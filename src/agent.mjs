import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {CAD_CODE,RUNS,atomicJson,fileSha,mkdirPrivate} from './common.mjs';
import {loadProfile,profileFile} from './profiles.mjs';
import {resolveDataset,casePath} from './datasets.mjs';
import {scoreAgentSource,isNotebook,sdkVersion,SCORER_PYTHON} from './scoring.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){return await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});}
function runId(profile,dataset){return `agent-${new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,17)}-${profile}-${dataset}`;}
function portOpen(port){return new Promise(resolve=>{const socket=new net.Socket();let settled=false;const done=value=>{if(settled)return;settled=true;socket.destroy();resolve(value);};
  socket.setTimeout(500);socket.once('connect',()=>done(true));socket.once('error',()=>done(false));socket.once('timeout',()=>done(false));socket.connect(port,'127.0.0.1');});}
async function waitForPort(port,child,timeoutMs=60000){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){
  if(child.exitCode!==null)throw Error('CAD Code --web exited during startup');if(await portOpen(port))return;await sleep(200);
}throw Error('Timed out waiting for the CAD Code --web CLI');}
async function openBrowser(url){
  if(process.platform!=='darwin')return {opened:false,reason:'Open the printed URL manually on this platform.',url};
  return await new Promise(resolve=>{const child=spawn('open',[url],{stdio:'ignore'});child.once('error',e=>resolve({opened:false,error:e.message,url}));child.once('close',code=>resolve({opened:code===0,code,url}));});
}
async function startCadCode({cliPath,runtime,workspace,credentialPath,ports,logPath,wireAPI}){
  fs.mkdirSync(runtime,{recursive:true});fs.mkdirSync(workspace,{recursive:true});fs.mkdirSync(path.dirname(logPath),{recursive:true});
  const log=fs.createWriteStream(logPath,{flags:'a',mode:0o600});
  const child=spawn(cliPath,['--web','--credentials',credentialPath],{
    cwd:CAD_CODE,env:{...process.env,CAD_CODE_RUNTIME:runtime,CAD_CODE_WORKSPACE:workspace,
      CAD_CODE_PYTHON:path.join(CAD_CODE,'.runtime/python/bin/python'),PORT:String(ports.web),
      CAD_CODE_OPENCODE_PORT:String(ports.opencode),CAD_CODE_GATEWAY_PORT:String(ports.gateway),CAD_CODE_WIRE_API:wireAPI||'responses'},
    stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>log.write(chunk));child.stderr.on('data',chunk=>log.write(chunk));
  try{await waitForPort(ports.web,child);}catch(error){child.kill('SIGTERM');log.end();throw Error(error.message+'; see '+logPath);}
  return {child,website:`http://127.0.0.1:${ports.web}`,log};
}
async function stopCadCode(server){
  if(server.child.exitCode===null){server.child.kill('SIGTERM');await Promise.race([new Promise(resolve=>server.child.once('exit',resolve)),sleep(5000)]);
    if(server.child.exitCode===null){server.child.kill('SIGKILL');await new Promise(resolve=>server.child.once('exit',resolve));}}
  await new Promise(resolve=>server.log.end(resolve));
}
function sessionIdFrom(text){return String(text).match(/\bses_[A-Za-z0-9_-]{8,}\b/)?.[0]||null;}
export function classifyAgentResult(cliStatus,sessionId,candidateStatus=null){
  if(!sessionId)return 'runner_error';
  if(cliStatus!=='completed')return cliStatus;
  if(candidateStatus==='scorer_error')return 'scorer_error';
  return candidateStatus?'completed':'missing_candidate';
}

async function runCadCodeTask({cliPath,files,user,credentialPath,wireAPI,runtime,workspace,ports,caseDir,timeoutMs,signal}){
  fs.mkdirSync(caseDir,{recursive:true});
  const stdoutFile=path.join(caseDir,'cad-code-cli.stdout.log'),stderrFile=path.join(caseDir,'cad-code-cli.stderr.log');
  const stdoutLog=fs.createWriteStream(stdoutFile,{mode:0o600}),stderrLog=fs.createWriteStream(stderrFile,{mode:0o600});
  const started_at=new Date().toISOString();
  const args=['--credentials',credentialPath];for(const file of files)args.push('--file',file);args.push('run',user);
  const child=spawn(cliPath,args,{cwd:CAD_CODE,env:{...process.env,
    CAD_CODE_RUNTIME:runtime,CAD_CODE_WORKSPACE:workspace,CAD_CODE_PYTHON:path.join(CAD_CODE,'.runtime/python/bin/python'),
    PORT:String(ports.web),CAD_CODE_OPENCODE_PORT:String(ports.opencode),CAD_CODE_GATEWAY_PORT:String(ports.gateway),CAD_CODE_WIRE_API:wireAPI||'responses'},stdio:['ignore','pipe','pipe']});
  let tail='',sessionId=null,stdoutBytes=0,stderrBytes=0,timedOut=false,interrupted=false,forceTimer=null;
  child.stdout.on('data',chunk=>{stdoutBytes+=chunk.length;tail=(tail+chunk.toString()).slice(-16000);sessionId||=sessionIdFrom(tail);stdoutLog.write(chunk);});
  child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;tail=(tail+chunk.toString()).slice(-16000);sessionId||=sessionIdFrom(tail);stderrLog.write(chunk);});
  const stop=()=>{if(child.exitCode!==null)return;child.kill('SIGINT');forceTimer=setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');},5000);};
  const onAbort=()=>{interrupted=true;stop();};
  signal?.addEventListener('abort',onAbort,{once:true});
  if(signal?.aborted)onAbort();
  const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
  let close;
  try{close=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,term)=>resolve({code,term}));});}
  finally{clearTimeout(timer);if(forceTimer)clearTimeout(forceTimer);signal?.removeEventListener('abort',onAbort);
    await Promise.all([new Promise(resolve=>stdoutLog.end(resolve)),new Promise(resolve=>stderrLog.end(resolve))]);}
  const status=timedOut?'time_budget_exhausted':interrupted?'interrupted':close.code===0?'completed':'cad_code_cli_error';
  const transcript={source:'CAD Code CLI stdout/stderr',status,exit_code:close.code,signal:close.term,
    started_at,completed_at:new Date().toISOString(),stdout_log:path.basename(stdoutFile),stderr_log:path.basename(stderrFile),
    stdout_bytes:stdoutBytes,stderr_bytes:stderrBytes,stdout_sha256:fileSha(stdoutFile),stderr_sha256:fileSha(stderrFile)};
  return {id:sessionId,status,exit_code:close.code,signal:close.term,transcript};
}

// Candidates, in order of preference for the final score: the notebook the task names (out/model.py), any other
// SimpleCAD notebook under out/ or the workspace root (newest first), then the legacy build() modules.
export function findCandidates(workspace){
  const seen=new Set(),found=[];
  const add=(file,name)=>{const real=path.resolve(file);if(seen.has(real)||!fs.existsSync(file))return;seen.add(real);found.push({name,file});};
  add(path.join(workspace,'out','model.py'),'model.py');
  const notebooks=[];
  for(const dir of [path.join(workspace,'out'),workspace]){
    if(!fs.existsSync(dir))continue;
    for(const f of fs.readdirSync(dir)){const p=path.join(dir,f);
      if(f.endsWith('.py')&&!['rebuild.py','final.py'].includes(f)&&fs.statSync(p).isFile()&&isNotebook(p))notebooks.push(p);}
  }
  notebooks.sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
  for(const p of notebooks)add(p,path.relative(workspace,p));
  for(const name of ['final.py','rebuild.py'])for(const p of [path.join(workspace,'out',name),path.join(workspace,name)])add(p,name);
  return found;
}

async function scoreCase({dataset,entry,workspace,runCase,python}){
  const results=[];
  for(const {name,file}of findCandidates(workspace)){
    const result=await scoreAgentSource({codePath:file,targetPath:casePath(dataset,entry,'target.step'),
      outDir:path.join(runCase,'evaluation',name.replace(/\.py$/,'').replace(/[\/]/g,'__')),python});
    results.push({candidate:name,...result});
  }
  return results;
}

export async function runAgent({datasetName,profileName,parallel=1,caseIds=null,timeout=5400,openWeb=true,
  cliPath=path.join(CAD_CODE,'cad-code')}){
  const dataset=resolveDataset(datasetName),profile=loadProfile(profileName),credentialPath=profileFile(profileName);
  if(dataset.manifest.mode!=='agent')throw Error('Dataset mode must be agent');
  if(profile.thinking!==true)throw Error('Agent tests require profile thinking=on');
  if(!Number.isSafeInteger(Number(parallel))||Number(parallel)<1||Number(parallel)>30)throw Error('--parallel must be an integer from 1 to 30');
  if(!Number.isSafeInteger(Number(timeout))||Number(timeout)<60||Number(timeout)>86400)throw Error('--timeout must be between 60 and 86400 seconds');
  const selected=dataset.manifest.cases.filter(c=>!caseIds||caseIds.includes(c.id));if(!selected.length)throw Error('No cases selected');
  mkdirPrivate(RUNS);const id=runId(profileName,datasetName),runDir=path.join(RUNS,id);fs.mkdirSync(runDir,{recursive:false});
  const casesRoot=path.join(runDir,'cases');mkdirPrivate(casesRoot);
  const runtime=path.join(runDir,'cad-code-runtime'),workspaceRoot=path.join(runDir,'cad-code-workspace');
  const used=new Set(),nextPort=async()=>{let p;do{p=await freePort();}while(used.has(p));used.add(p);return p;};
  const ports={web:await nextPort(),opencode:await nextPort(),gateway:await nextPort()};
  const run={schema_version:1,id,mode:'agent',status:'starting',created_at:new Date().toISOString(),
    dataset:{name:dataset.manifest.name,revision:dataset.manifest.revision,manifest_sha256:fileSha(path.join(dataset.dir,'manifest.json'))},
    profile:{name:profileName,base_url:profile.baseURL,model:profile.model,thinking:true,wire_api:profile.wire_api||'responses'},
    environment:{cad_code:'local CLI',simplecadapi:sdkVersion(path.join(CAD_CODE,'.runtime/python/bin/python')),temperature:1,vision:true,context_tokens:262144,
      compaction_target_tokens:261120,automatic_compaction:true,configuration_source:'CAD Code CLI runtime defaults',
      configuration_verified:false,case_timeout_seconds:timeout,ports,score_threshold_riou:0.90},
    parallel:Number(parallel),website:null,trace_source:'complete CAD Code CLI stdout/stderr transcript',
    cases:selected.map(c=>({id:c.id,split:c.split,status:'pending',source:c.source||null}))};
  atomicJson(path.join(runDir,'run.json'),run);
  const server=await startCadCode({cliPath,runtime,workspace:workspaceRoot,credentialPath,ports,logPath:path.join(runDir,'cad-code-server.log'),wireAPI:profile.wire_api});
  const browser=openWeb?await openBrowser(server.website):{opened:false,reason:'--no-open specified',url:server.website};
  if(openWeb&&process.platform==='darwin'&&!browser.opened){await stopCadCode(server);throw Error('Could not open the CAD Code monitor page: '+server.website+'; '+(browser.error||''));}
  server.log.write(`\nCAD Code monitoring page: ${server.website}\n`);
  run.website=server.website;run.web_browser=browser;run.status='running';run.web_ready=true;
  atomicJson(path.join(runDir,'run.json'),run);console.log('CAD Code monitoring page: '+server.website);
  const controller=new AbortController(),cancel=()=>controller.abort();process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  let next=0;const results=new Array(selected.length),agentsErrors=[];
  async function worker(){while(true){if(controller.signal.aborted)return;const i=next++;if(i>=selected.length)return;const entry=selected[i],caseRun=path.join(casesRoot,entry.id);
    let sessionId=null,outputWorkspace=null;
    try{
      fs.mkdirSync(caseRun,{recursive:true});
      const targetHash=entry.files['target.step'],irHash=entry.files['target.ir.jsonl'];
      const task=fs.readFileSync(casePath(dataset,entry,'prompt.txt'),'utf8');
      const taskRecord={user_input:task,user_input_sha256:entry.files['prompt.txt'],
        cad_code_cli_file_context:'CAD Code CLI imports input files into input/ and exposes their relative paths to the task.',
        target_sha256:targetHash,ir_sha256:irHash,source_prompt_sha256:entry.source_prompt_sha256||null};
      atomicJson(path.join(caseRun,'input.json'),taskRecord);
      run.cases[i]={...run.cases[i],status:'running',started_at:new Date().toISOString()};
      run.active_cases=run.cases.filter(c=>c.status==='running').length;atomicJson(path.join(runDir,'run.json'),run);
      const cli=await runCadCodeTask({cliPath,files:[casePath(dataset,entry,'target.step'),casePath(dataset,entry,'target.ir.jsonl')],
        user:task,credentialPath,wireAPI:profile.wire_api,runtime,workspace:workspaceRoot,ports,caseDir:caseRun,timeoutMs:timeout*1000,signal:controller.signal});
      sessionId=cli.id;outputWorkspace=sessionId?path.join(workspaceRoot,sessionId):null;
      taskRecord.session_id=sessionId;atomicJson(path.join(caseRun,'input.json'),taskRecord);
      atomicJson(path.join(caseRun,'trace.json'),{...cli.transcript,session_id:sessionId});
      if(classifyAgentResult(cli.status,sessionId)==='runner_error')throw Error('CAD Code CLI did not report its session ID; inspect the complete stdout/stderr logs');
      if(!sameFileHash(path.join(outputWorkspace,'input/target.step'),targetHash)||!sameFileHash(path.join(outputWorkspace,'input/target.ir.jsonl'),irHash))
        throw Error('CAD Code CLI input SHA mismatch: '+entry.id);
      const score=fs.existsSync(outputWorkspace)?await scoreCase({dataset,entry,workspace:outputWorkspace,runCase:caseRun,python:SCORER_PYTHON}):[];
      const final=score[0]||null;
      const resultStatus=classifyAgentResult(cli.status,sessionId,final?.status||null);
      const record={...taskRecord,status:resultStatus,cad_code_cli_status:cli.status,cad_code_cli_exit_code:cli.exit_code,completed_at:new Date().toISOString(),
        assistant_messages:null,candidate_scores:score,final_riou:final?.riou??null,pass:final?Number(final.riou)>=0.90:false,
        target_workspace_unchanged:sessionId?sameFileHash(path.join(outputWorkspace,'input/target.step'),targetHash)&&sameFileHash(path.join(outputWorkspace,'input/target.ir.jsonl'),irHash):null};
      atomicJson(path.join(caseRun,'result.json'),record);results[i]=record;
      run.cases[i]={...run.cases[i],session_id:sessionId,status:resultStatus,final_riou:record.final_riou,pass:record.pass,completed_at:record.completed_at};
      run.active_cases=run.cases.filter(c=>c.status==='running').length;run.completed_cases=run.cases.filter(c=>c.completed_at).length;
      atomicJson(path.join(runDir,'run.json'),run);console.log(`[${run.completed_cases}/${selected.length}] ${entry.id}: ${resultStatus}${final&&Number.isFinite(Number(final.riou))?` rIoU=${Number(final.riou).toFixed(4)}`:''}`);
    }catch(error){
      const record={id:entry.id,session_id:sessionId,status:'runner_error',error:error?.stack||String(error),completed_at:new Date().toISOString()};
      results[i]=record;agentsErrors.push(entry.id);atomicJson(path.join(caseRun,'result.json'),record);
      run.cases[i]={...run.cases[i],session_id:sessionId,status:'runner_error',error:error.message,completed_at:record.completed_at};
      run.active_cases=run.cases.filter(c=>c.status==='running').length;run.completed_cases=run.cases.filter(c=>c.completed_at).length;
      atomicJson(path.join(runDir,'run.json'),run);console.error(`[${run.completed_cases}/${selected.length}] ${entry.id}: runner_error ${error.message}`);
    }
  }}
  try{await Promise.all(Array.from({length:Math.min(Number(parallel),selected.length)},worker));}
  finally{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);await stopCadCode(server);}
  const complete=results.filter(Boolean),scores=complete.map(x=>x.final_riou).filter(Number.isFinite);
  run.status=controller.signal.aborted?'interrupted':complete.length===selected.length&&complete.every(x=>x.status==='completed')?'completed':'completed_with_errors';
  run.completed_at=new Date().toISOString();
  run.summary={cases:selected.length,recorded:complete.length,completed:complete.filter(x=>x.status==='completed').length,
    passed_at_riou_090:complete.filter(x=>x.pass).length,mean_riou:scores.length?scores.reduce((a,b)=>a+b,0)/scores.length:null,
    scored_cases:scores.length,runner_errors:agentsErrors,
    status_counts:Object.fromEntries([...new Set(complete.map(x=>x.status))].map(s=>[s,complete.filter(x=>x.status===s).length]))};
  atomicJson(path.join(runDir,'summary.json'),run.summary);atomicJson(path.join(runDir,'run.json'),run);return {runDir,run};
}

function sameFileHash(file,expected){try{return fileSha(file)===expected;}catch{return false;}}
