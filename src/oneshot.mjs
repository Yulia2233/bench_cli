import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {CAD_CODE,DATA,REPO,RUNS,atomicJson,fileSha,mkdirPrivate,validName} from './common.mjs';
import {loadProfile,profileFile} from './profiles.mjs';
import {resolveDataset} from './datasets.mjs';
import {scoreOneShot} from './scoring.mjs';

function runId(profile,dataset){return `oneshot-${new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,17)}-${profile}-${dataset}`;}
function spawnAsk({credentialPath,model,thinking,wireAPI,prompt,caseDir,maxTokens}){
  return new Promise(resolve=>{
    const out=fs.createWriteStream(path.join(caseDir,'response.txt'),{mode:0o600});
    const err=fs.createWriteStream(path.join(caseDir,'response.stderr.txt'),{mode:0o600});
    const child=spawn(path.join(CAD_CODE,'cad-code'),['ask','--credentials',credentialPath,
      '--model',model,'--thinking',thinking?'on':'off','--max-output-tokens',String(maxTokens),'--show-thinking','--',prompt],
      {cwd:REPO,env:{...process.env,CAD_CODE_WIRE_API:wireAPI||'responses'},stdio:['ignore','pipe','pipe']});
    child.stdout.pipe(out);child.stderr.pipe(err);const start=Date.now();
    child.on('error',e=>{out.end();err.end();resolve({api_status:'runner_error',error:e.message,seconds:(Date.now()-start)/1000});});
    child.on('close',(code,signal)=>{out.end();err.end(()=>resolve({api_status:code===0?'completed':signal==='SIGINT'?'cancelled':'api_error',exit_code:code,signal,seconds:(Date.now()-start)/1000}));});
  });
}

export async function runOneShot({datasetName,profileName,parallel=1,limit=null,caseIds=null,maxTokens=24576}){
  const ds=resolveDataset(datasetName),profile=loadProfile(profileName),credentialPath=profileFile(profileName);
  if(ds.manifest.mode!=='oneshot')throw Error('Dataset mode must be oneshot');
  if(!Number.isSafeInteger(Number(parallel))||Number(parallel)<1||Number(parallel)>64)throw Error('--parallel must be an integer from 1 to 64');
  if(limit!==null&&(!Number.isSafeInteger(Number(limit))||Number(limit)<1))throw Error('--limit must be a positive integer');
  if(!Number.isSafeInteger(Number(maxTokens))||Number(maxTokens)<1||Number(maxTokens)>262144)throw Error('--max-output-tokens must be from 1 to 262144');
  const selected=ds.manifest.cases.filter(c=>!caseIds||caseIds.includes(c.id)).slice(0,limit||Infinity);
  if(!selected.length)throw Error('No cases selected');
  mkdirPrivate(RUNS);const id=runId(profileName,datasetName),runDir=path.join(RUNS,id);fs.mkdirSync(runDir,{recursive:false});
  const casesRoot=path.join(runDir,'cases');mkdirPrivate(casesRoot);
  const run={schema_version:1,id,mode:'oneshot',status:'running',created_at:new Date().toISOString(),
    dataset:{name:ds.manifest.name,revision:ds.manifest.revision,manifest_sha256:fileSha(path.join(ds.dir,'manifest.json'))},
    profile:{name:profileName,base_url:profile.baseURL,model:profile.model,thinking:profile.thinking,wire_api:profile.wire_api||'responses'},
    generation:{temperature:1,n:1,thinking:profile.thinking,max_output_tokens:maxTokens},parallel:Number(parallel),
    cases:selected.map(c=>({id:c.id,split:c.split,status:'pending',source:c.source||null})),
    history_scope:'new CAD Code ask calls; temperature=1. Historical 270 baselines used temperature=0 and are not protocol-identical.'};
  atomicJson(path.join(runDir,'run.json'),run);
  for(const c of selected){const from=path.join(ds.dir,'cases',c.id),to=path.join(casesRoot,c.id,'input');fs.mkdirSync(to,{recursive:true});
    for(const file of ['prompt.txt','target.step']){const source=path.join(from,file);fs.copyFileSync(source,path.join(to,file));}
    if(c.files?.['target.ir.jsonl'])fs.copyFileSync(path.join(from,'target.ir.jsonl'),path.join(to,'target.ir.jsonl'));
    atomicJson(path.join(casesRoot,c.id,'case.json'),{id:c.id,split:c.split,source:c.source||null,
      prompt_sha256:fileSha(path.join(to,'prompt.txt')),target_sha256:fileSha(path.join(to,'target.step')),
      target_ir_sha256:fs.existsSync(path.join(to,'target.ir.jsonl'))?fileSha(path.join(to,'target.ir.jsonl')):null,status:'pending'});
  }
  const results=new Array(selected.length);let next=0;
  async function worker(){while(true){const index=next++;if(index>=selected.length)return;const c=selected[index],dir=path.join(casesRoot,c.id),prompt=fs.readFileSync(path.join(dir,'input/prompt.txt'),'utf8');
    const result=await spawnAsk({credentialPath,model:profile.model,thinking:profile.thinking,wireAPI:profile.wire_api,prompt,caseDir:dir,maxTokens});
    results[index]={id:c.id,split:c.split,...result,response_sha256:fileSha(path.join(dir,'response.txt'))};
    atomicJson(path.join(dir,'case.json'),{...JSON.parse(fs.readFileSync(path.join(dir,'case.json'),'utf8')),...result,response_sha256:results[index].response_sha256});
    run.cases[index]={...run.cases[index],...result};run.completed=results.filter(Boolean).length;run.api_failures=results.filter(x=>x&&x.api_status!=='completed').length;
    atomicJson(path.join(runDir,'run.json'),run);console.log(`[${run.completed}/${selected.length}] ${c.id}: ${result.api_status}`);
  }}
  await Promise.all(Array.from({length:Math.min(Number(parallel),selected.length)},worker));
  const outputs=selected.map((c,i)=>({id:c.id,samples:[{text:results[i].api_status==='completed'?fs.readFileSync(path.join(casesRoot,c.id,'response.txt'),'utf8'):'',finish_reason:results[i].api_status==='completed'?'stop':'error'}]}));
  fs.writeFileSync(path.join(runDir,'generated-for-scoring.jsonl'),outputs.map(JSON.stringify).join('\n')+'\n');
  let scoring=null;try{scoring=await scoreOneShot({runDir,cases:selected,expectedCases:ds.manifest.cases,parallel:Math.min(Number(parallel),8)});}catch(error){run.scoring_error=error.stack||String(error);}
  run.status=results.every(x=>x.api_status==='completed')&&scoring?'completed':scoring?'completed_with_api_errors':'generation_or_scoring_failed';
  run.completed_at=new Date().toISOString();run.summary=scoring?.summary||null;run.score_status_counts=scoring?.summary?.status_counts||{};
  // A score with one or more failed provider requests is retained per case but not advertised as a full-set aggregate.
  if(results.some(x=>x.api_status!=='completed'))run.summary={...run.summary,weighted_score:null,aggregate_suppressed_reason:'one or more provider requests did not complete'};
  if(scoring?.rows.some(x=>x.status==='scorer_error'))run.summary={...run.summary,weighted_score:null,aggregate_suppressed_reason:'one or more independent scorer runs errored'};
  atomicJson(path.join(runDir,'run.json'),run);atomicJson(path.join(runDir,'summary.json'),run.summary||{status:run.status,error:run.scoring_error});
  return {runDir,run};
}
