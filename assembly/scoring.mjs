import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {atomicJson,fileSha} from './common.mjs';
import {assemblyInputSummary,loadAssemblyProject,resolveProjectAttempt} from './datasets.mjs';
import {CAD_CODE} from '../src/common.mjs';

export const DEFAULT_EVALUATOR=process.env.BENCH_ASSEMBLY_EVALUATOR||path.join(CAD_CODE,'multi/assemblyeval.py');
export const DEFAULT_PYTHON=process.env.BENCH_ASSEMBLY_PYTHON||path.join(CAD_CODE,'.runtime/python/bin/python');

export function replayFiles(root){
  const files=[];
  function visit(dir){
    for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      const full=path.join(dir,entry.name);
      if(entry.isSymbolicLink())throw Error('Replay source closure contains a symlink');
      if(entry.isDirectory()){
        if(entry.name==='__pycache__'||entry.name==='__marimo__')continue;
        visit(full);
      }else if(entry.isFile()&&entry.name.endsWith('.py'))files.push({path:path.relative(root,full),sha256:fileSha(full)});
    }
  }
  visit(root);return files;
}

export async function scoreAssembly({projectPath,attemptDir,outDir,evaluator=DEFAULT_EVALUATOR,python=DEFAULT_PYTHON,timeoutSeconds=600}){
  const project=loadAssemblyProject(projectPath),attempt=resolveProjectAttempt(project.projectDir,attemptDir);
  const summary=assemblyInputSummary(project,attempt);
  if(!fs.existsSync(evaluator))throw Error('Assembly evaluator is not installed: '+evaluator);
  if(!fs.existsSync(python))throw Error('Assembly Python is not installed: '+python);
  if(!Number.isSafeInteger(Number(timeoutSeconds))||Number(timeoutSeconds)<1)throw Error('Invalid evaluation timeout');
  const replay=replayFiles(path.dirname(summary.notebookPath));
  if(!replay.some(file=>file.path==='product.py'))throw Error('Missing product.py in replay closure');
  const evalInputs={...summary.inputs,replay_files:replay};
  const evalInputsPath=path.join(path.dirname(summary.inputsPath),'assembly-inputs.eval.json');
  const encoded=JSON.stringify(evalInputs,null,2)+'\n';
  if(fs.existsSync(evalInputsPath)){
    if(fs.readFileSync(evalInputsPath,'utf8')!==encoded)throw Error('Evaluation inputs changed; create a new attempt');
  }else atomicJson(evalInputsPath,evalInputs);
  const destination=path.resolve(outDir);fs.mkdirSync(destination,{recursive:true});
  const verdictPath=path.join(destination,'verdict.json');
  if(fs.existsSync(verdictPath))throw Error('Refusing to overwrite an existing assembly evaluation');
  const args=[evaluator,'--assembly-ir',project.assemblyIrPath,'--inputs',evalInputsPath,'--notebook',summary.notebookPath,'--out',destination,'--python',python,'--timeout',String(timeoutSeconds)];
  const processResult=await new Promise((resolve,reject)=>{
    const child=spawn(python,args,{stdio:['ignore','pipe','pipe']});
    let error=null,timedOut=false,forceTimer=null;
    child.stdout.resume();child.stderr.resume();
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');forceTimer=setTimeout(()=>child.kill('SIGKILL'),5000);},Number(timeoutSeconds)*1000);
    child.once('error',value=>{error=value;});
    child.once('close',(code,signal)=>{clearTimeout(timer);if(forceTimer)clearTimeout(forceTimer);error?reject(error):resolve({code,signal,timed_out:timedOut});});
  });
  if(processResult.timed_out)return {status:'timeout',candidate_executed:null,verdict:null};
  if(!fs.existsSync(verdictPath))return {status:'scorer_error',candidate_executed:null,verdict:null,exit_code:processResult.code};
  const verdict=JSON.parse(fs.readFileSync(verdictPath,'utf8'));
  if(verdict.schema_version!=='assembly-verdict-v1')throw Error('Evaluator returned an unsupported verdict schema');
  const expected={assembly_ir_sha256:fileSha(project.assemblyIrPath),notebook_sha256:summary.notebookSha256,inputs_sha256:fileSha(evalInputsPath)};
  for(const [key,value] of Object.entries(expected)){
    const recorded=verdict[key]??verdict.hashes?.[key];
    if(recorded!==value)throw Error('Evaluator verdict hash mismatch: '+key);
  }
  return {status:verdict.ok===true?'completed':'failed',verdict,verdict_path:verdictPath,exit_code:processResult.code};
}
