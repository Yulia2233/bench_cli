import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {atomicJson,fileSha,mkdirPrivate} from './common.mjs';
import {assemblyInputSummary,loadAssemblyProject,resolveProjectAttempt} from './datasets.mjs';
import {CAD_CODE,ROOT} from '../src/common.mjs';

const DEFAULT_MULTI_CLI=path.join(CAD_CODE,'cad-code-multi');

function parseJsonOutput(output,label){
  const text=String(output).trim();
  if(!text)throw Error(`${label} returned empty output`);
  try{return JSON.parse(text);}catch(error){
    const blocks=[...text.matchAll(/(?:^|\n)(\{[\s\S]*\})(?=\s*$)/g)];
    for(const block of blocks.reverse())try{return JSON.parse(block[1]);}catch{}
    throw Error(`${label} did not return JSON: ${error.message}`);
  }
}

function secretValues(env){
  return Object.entries(env).filter(([name,secret])=>/(API[_-]?KEY|TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL|SSHPW)/i.test(name)&&
    typeof secret==='string'&&secret.length>0).map(([,secret])=>secret).sort((a,b)=>b.length-a.length);
}

function redactOutput(value,env){
  let text=String(value);
  const secrets=secretValues(env);
  for(const secret of secrets)text=text.split(secret).join('[REDACTED]');
  return text.replace(/\bBearer\s+[^\s,"'}]+/gi,'Bearer [REDACTED]')
    .replace(/((?:api[-_ ]?key|authorization|access[-_ ]?token|refresh[-_ ]?token|password|secret)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,'$1[REDACTED]');
}

function assertNoCredentialContent(file,env){
  const content=fs.readFileSync(file,'utf8');
  if(secretValues(env).some(secret=>content.includes(secret)))throw Error('An input or candidate file contains a secret from the environment');
}

function runCommand(command,args,{cwd,timeoutMs,stdoutFile,stderrFile,env=process.env}){
  return new Promise((resolve,reject)=>{
    const maxOutput=2_000_000;
    let outTail='',errTail='',timedOut=false,forceTimer=null;
    let timer=null,processError=null,logsWritten=false;
    let child;
    try{child=spawn(command,args,{cwd,env,stdio:['ignore','pipe','pipe']});}
    catch(error){reject(error);return;}
    child.stdout.on('data',chunk=>{outTail=(outTail+chunk.toString()).slice(-maxOutput);});
    child.stderr.on('data',chunk=>{errTail=(errTail+chunk.toString()).slice(-maxOutput);});
    child.once('error',error=>{processError=error;});
    const writeLogs=()=>{
      if(logsWritten)return;
      logsWritten=true;
      fs.writeFileSync(stdoutFile,redactOutput(outTail,env),{flag:'wx',mode:0o600});
      fs.writeFileSync(stderrFile,redactOutput(errTail,env),{flag:'wx',mode:0o600});
    };
    timer=setTimeout(()=>{
      timedOut=true;child.kill('SIGTERM');
      forceTimer=setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');},5000);
    },timeoutMs);
    child.once('close',(code,signal)=>{
      clearTimeout(timer);if(forceTimer)clearTimeout(forceTimer);
      try{writeLogs();if(processError)reject(processError);else resolve({code,signal,timed_out:timedOut,stdout:outTail,stderr:errTail});}
      catch(error){reject(error);}
    });
  });
}

function copyFileRecorded(source,root,destinationRelative,records){
  const rel=String(destinationRelative);
  if(path.isAbsolute(rel)||rel.split(/[\\/]/).includes('..'))throw Error('Unsafe snapshot path: '+rel);
  const destination=path.join(root,rel);
  mkdirPrivate(path.dirname(destination));
  fs.copyFileSync(source,destination,fs.constants.COPYFILE_EXCL);
  records.push({path:rel,sha256:fileSha(destination),size:fs.statSync(destination).size});
}

function runIdentifier(projectDir){
  const label=path.basename(projectDir).replace(/[^A-Za-z0-9._-]/g,'-').slice(0,48)||'project';
  return `assembly-${new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,17)}-${label}-${randomUUID().slice(0,8)}`;
}

export async function stageAssemblyRun({projectPath,outRoot,cadCodeMulti=DEFAULT_MULTI_CLI,timeoutSeconds=1800,
  now=()=>new Date().toISOString(),env=process.env}={}){
  if(!Number.isSafeInteger(Number(timeoutSeconds))||Number(timeoutSeconds)<60||Number(timeoutSeconds)>86400)
    throw Error('timeoutSeconds must be an integer from 60 to 86400');
  const project=loadAssemblyProject(projectPath);
  const multiCli=path.resolve(cadCodeMulti);
  const outputRoot=path.resolve(outRoot||path.join(ROOT,'.runtime','assembly-runs'));
  mkdirPrivate(outputRoot);
  const runId=runIdentifier(project.projectDir),runDir=path.join(outputRoot,runId);
  fs.mkdirSync(runDir,{recursive:false,mode:0o700});
  const run={schema_version:'bench-assembly-run-v1',run_id:runId,status:'starting',created_at:now(),
    project:{path:project.projectDir,id:project.project.project_id||project.project.id||null,assembly_ir_sha256:fileSha(project.assemblyIrPath)},
    cad_code_multi:multiCli,candidate_executed:false,score_status:'not_evaluated',
    assembly_ir_path:path.relative(project.projectDir,project.assemblyIrPath),attempt_dir:null};
  atomicJson(path.join(runDir,'run.json'),run);
  try{
    const statusResult=await runCommand(multiCli,['status','--project',project.projectDir,'--json'],{
      cwd:project.projectDir,timeoutMs:60_000,stdoutFile:path.join(runDir,'status.stdout.log'),stderrFile:path.join(runDir,'status.stderr.log'),env});
    if(statusResult.timed_out)throw Error('cad-code-multi status timed out');
    if(statusResult.code!==0)throw Error(`cad-code-multi status failed (${statusResult.code}): ${statusResult.stderr.slice(-1200)}`);
    const status=parseJsonOutput(statusResult.stdout,'cad-code-multi status');
    run.project_status={ready_for_assembly:status.ready_for_assembly??null,can_assemble:status.can_assemble??null,
      status:typeof status.status==='string'?status.status:null};
    if(status.ready_for_assembly===false||status.can_assemble===false)
      throw Error('Project status reports that assembly is not ready');

    const assembleResult=await runCommand(multiCli,['assemble','--project',project.projectDir,'--json','--wait'],{
      cwd:project.projectDir,timeoutMs:Number(timeoutSeconds)*1000,
      stdoutFile:path.join(runDir,'assemble.stdout.log'),stderrFile:path.join(runDir,'assemble.stderr.log'),env});
    if(assembleResult.timed_out)throw Error(`cad-code-multi assemble exceeded ${timeoutSeconds} seconds`);
    if(assembleResult.code!==0)throw Error(`cad-code-multi assemble failed (${assembleResult.code}): ${assembleResult.stderr.slice(-1200)}`);
    const result=parseJsonOutput(assembleResult.stdout,'cad-code-multi assemble');
    if(typeof result.attempt_dir!=='string'||!result.attempt_dir)throw Error('cad-code-multi assemble did not return attempt_dir');
    const attemptDir=resolveProjectAttempt(project.projectDir,result.attempt_dir);
    const sessionId=typeof result.session_id==='string'?result.session_id:null;
    if(!sessionId)throw Error('cad-code-multi assemble did not return session_id');
    const summary=assemblyInputSummary(project,attemptDir);
    run.attempt_dir=attemptDir;run.session_id=sessionId;
    run.assembly_status=typeof result.status==='string'?result.status:null;
    run.input={assembly_ir_sha256:summary.assemblyIrSha256,assembly_inputs_sha256:summary.assemblyInputsSha256,
      candidate_sha256:summary.notebookSha256,files:summary.files};
    run.status='staged';
    run.score_status='not_evaluated';
    run.completed_at=now();
    const snapshots=[];
    for(const file of [summary.irPath,summary.inputsPath,summary.notebookPath,...summary.files.map(item=>path.join(attemptDir,item.path))])
      assertNoCredentialContent(file,env);
    copyFileRecorded(summary.irPath,runDir,'source/input/assembly.ir.json',snapshots);
    copyFileRecorded(summary.inputsPath,runDir,'source/input/assembly-inputs.json',snapshots);
    for(const item of summary.files)copyFileRecorded(path.join(attemptDir,item.path),runDir,'source/'+item.path,snapshots);
    copyFileRecorded(summary.notebookPath,runDir,'candidate/out/product.py',snapshots);
    run.snapshots=snapshots;
    run.replay={status:'not_evaluated',candidate_executed:false,
      reason:'Run score explicitly with the independent assembly evaluator.'};
    atomicJson(path.join(runDir,'run.json'),run);
    atomicJson(path.join(runDir,'summary.json'),{run_id:runId,status:run.status,score_status:run.score_status,
      session_id:sessionId,attempt_dir:attemptDir,candidate_executed:false,assembly_ir_sha256:summary.assemblyIrSha256,
      assembly_inputs_sha256:summary.assemblyInputsSha256,candidate_sha256:summary.notebookSha256,
      expected_instances:project.assemblyIr.instances.length,expected_unique_parts:project.assemblyIr.unique_parts.length});
    return {runDir,run};
  }catch(error){
    run.status='runner_error';run.error=redactOutput(error?.stack||String(error),env);run.completed_at=now();
    atomicJson(path.join(runDir,'run.json'),run);
    return {runDir,run};
  }
}

export function defaultCadCodeMulti(){return DEFAULT_MULTI_CLI;}
