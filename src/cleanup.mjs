import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {CAD_CODE,DATA,RUNS,atomicJson,readJson,safeChild,validName} from './common.mjs';
import {profileFile} from './profiles.mjs';

async function freePort(){return await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});}
function sessionWorkspace(runId,sessionId){
  if(typeof sessionId!=='string'||!/^ses_[A-Za-z0-9_-]+$/.test(sessionId))throw Error('Invalid CAD Code session id');
  const runRoot=safeChild(RUNS,runId),workspaceRoot=safeChild(runRoot,'cad-code-workspace');
  return safeChild(workspaceRoot,sessionId);
}
async function cadCodeDeleteSession(runId,sessionId,scope){
  const root=safeChild(RUNS,runId),run=readJson(path.join(root,'run.json'));
  if(run.mode!=='agent')throw Error('Selected run does not own CAD Code agent sessions');
  sessionWorkspace(runId,sessionId);
  const ports={PORT:String(await freePort()),CAD_CODE_OPENCODE_PORT:String(await freePort()),CAD_CODE_GATEWAY_PORT:String(await freePort())};
  const env={...process.env,CAD_CODE_RUNTIME:path.join(root,'cad-code-runtime'),CAD_CODE_WORKSPACE:path.join(root,'cad-code-workspace'),
    CAD_CODE_PYTHON:path.join(CAD_CODE,'.runtime/python/bin/python'),...ports};
  const credential=profileFile(run.profile.name);
  await new Promise((resolve,reject)=>{
    const child=spawn(path.join(CAD_CODE,'cad-code'),['delete',scope,sessionId,'--yes','--credentials',credential],{cwd:CAD_CODE,env,stdio:['ignore','pipe','pipe']});
    let stderr='';const log=fs.createWriteStream(path.join(root,'cad-code-cleanup-cli.log'),{flags:'a',mode:0o600});
    child.stdout.on('data',chunk=>log.write(chunk));child.stderr.on('data',chunk=>{stderr+=chunk.toString();log.write(chunk);});
    child.once('error',error=>log.end(()=>reject(error)));
    child.once('close',code=>log.end(()=>code===0?resolve():reject(Error('cad-code CLI refused '+scope+' deletion for '+sessionId+': '+stderr.slice(-1200)))));
  });
}

export function workspacePlan(runIds=null){
  if(!fs.existsSync(RUNS))return [];
  return fs.existsSync(RUNS)?fs.readdirSync(RUNS).filter(id=>!runIds||runIds.includes(id)).flatMap(id=>{
    const runRoot=safeChild(RUNS,id),p=path.join(runRoot,'run.json');if(!fs.existsSync(p))return [];
    const run=readJson(p);if(run.mode!=='agent')return [];
    const root=safeChild(runRoot,'cad-code-workspace');if(!fs.existsSync(root))return [];
    return run.cases.filter(c=>c.session_id).map(c=>{const dir=sessionWorkspace(id,c.session_id);return {run_id:id,run_created_at:run.created_at,session_id:c.session_id,
      run_status:run.status,case_status:c.status,path:dir,exists:fs.existsSync(dir),bytes:fs.existsSync(dir)?measure(dir):0};});
  }):[];
}
function measure(dir){let bytes=0;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isSymbolicLink())continue;if(e.isDirectory())bytes+=measure(p);else bytes+=fs.statSync(p).size;}return bytes;}
export async function clearRunWorkspaces(runIds,{dryRun=true,includeActive=false}={}){
  const rows=workspacePlan(runIds);if(!includeActive&&rows.some(x=>x.run_status==='running'))throw Error('A selected run is still active; stop it before workspace cleanup');
  if(dryRun)return {dry_run:true,planned:rows,total_bytes:rows.reduce((n,x)=>n+x.bytes,0)};
  const results=[];for(const row of rows){const run=readJson(path.join(RUNS,row.run_id,'run.json'));
    await cadCodeDeleteSession(row.run_id,row.session_id,'workspace');
    results.push({...row,cleared:true,trajectory_archive:'written by cad-code CLI; conversation and trace preserved'});
    run.workspace_cleanups ||= [];run.workspace_cleanups.push({session_id:row.session_id,created_at:new Date().toISOString(),bytes:row.bytes});
    atomicJson(path.join(RUNS,row.run_id,'run.json'),run);
  }
  return {dry_run:false,results,total_bytes:rows.reduce((n,x)=>n+x.bytes,0)};
}

export async function clearTraceFiles(runId){
  const root=safeChild(RUNS,runId);if(!fs.existsSync(path.join(root,'run.json')))throw Error('Run not found');
  const run=readJson(path.join(root,'run.json'));if(run.status==='running')throw Error('Stop the run before clearing trace files');
  const removed=[];
  if(run.mode==='agent')for(const c of run.cases)if(c.session_id)await cadCodeDeleteSession(runId,c.session_id,'conversation');
  function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isSymbolicLink())continue;if(e.isDirectory()){walk(p);continue;}
    if(e.name==='trace.json'||e.name==='preflight-trace.json'||e.name==='preflight-input.json'||
       e.name==='.cad-events.jsonl'||e.name==='.conversation.json'||e.name==='response.txt'||
       e.name==='response.stderr.txt'||e.name==='cad-code-cli.stdout.log'||e.name==='cad-code-cli.stderr.log'||
       e.name==='cad-code-cleanup-cli.log'||e.name==='generated-for-scoring.jsonl'||e.name==='user_input.txt'){
      fs.unlinkSync(p);removed.push(path.relative(root,p));}
  }}
  run.traces_cleared_at=new Date().toISOString();run.cleared_trace_files=removed;atomicJson(path.join(root,'run.json'),run);return {run_id:runId,removed,scores_preserved:true,workspace_preserved:true};
}

export async function purgeRun(runId,{yes=false}={}){
  if(!yes)throw Error('history delete is destructive; repeat with --yes');
  const runDir=safeChild(RUNS,runId),manifest=path.join(runDir,'run.json');if(!fs.existsSync(manifest))throw Error('Run not found: '+runId);
  const run=readJson(manifest);if(run.status==='running')throw Error('Cannot delete a running benchmark');
  if(run.mode==='agent')for(const c of run.cases)if(c.session_id){
    await cadCodeDeleteSession(runId,c.session_id,'conversation');
    await cadCodeDeleteSession(runId,c.session_id,'workspace');
  }
  fs.rmSync(runDir,{recursive:true,force:false});return {deleted:runId,mode:run.mode};
}

export function clearImportedHistory(id,{yes=false}={}){
  if(!yes)throw Error('history delete-legacy is destructive; repeat with --yes');
  if(!validName(id))throw Error('Invalid imported history id');
  const pathRoot=path.join(DATA,'history/legacy');
  const file=safeChild(pathRoot,id+'.json');if(!fs.existsSync(file))throw Error('Imported history file not found: '+id);
  fs.unlinkSync(file);let rowsRemoved=0;const rowsFile=path.join(pathRoot,'legacy-scores.jsonl');
  if(fs.existsSync(rowsFile)){const rows=fs.readFileSync(rowsFile,'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const kept=rows.filter(row=>row.run_id!==id);rowsRemoved=rows.length-kept.length;
    if(rowsRemoved)fs.writeFileSync(rowsFile,kept.map(JSON.stringify).join('\n')+(kept.length?'\n':''));}
  return {deleted:file,score_rows_removed:rowsRemoved,source_runs_unchanged:true};
}
