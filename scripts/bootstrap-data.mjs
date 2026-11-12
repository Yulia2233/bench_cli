#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {DATA,REPO,fileSha,atomicJson,sha256} from '../src/common.mjs';

const stage=path.join(path.dirname(new URL(import.meta.url).pathname),'..','.staging');
const datasets=path.join(DATA,'datasets'),history=path.join(DATA,'history');
function ensureFresh(dir){if(fs.existsSync(dir))throw Error('Refusing to overwrite existing dataset: '+dir);fs.mkdirSync(dir,{recursive:true});}
function copyFile(source,target){fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);return fileSha(target);}
function readLines(file){return fs.readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);}

function buildOneShot(){
  const dir=path.join(datasets,'oneshot270-v1');
  if(fs.existsSync(path.join(dir,'manifest.json'))){const existing=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));return {name:existing.name,cases:existing.cases.length,content_sha256:existing.content_sha256,reused:true};}
  ensureFresh(dir);
  const promptFile=path.join(stage,'prompts_all.jsonl');if(!fs.existsSync(promptFile))throw Error('Run scripts/stage-legacy-data.sh first');
  const prompts=new Map(readLines(promptFile).map(x=>[x.id,x.prompt]));const cases=[];
  for(const split of ['bench','proxy','dev_real','dev_syn']){
    const targetFile=path.join(REPO,'benchmark/eval_sets',split,'targets.json');const targets=JSON.parse(fs.readFileSync(targetFile,'utf8'));
    for(const [id,relative]of Object.entries(targets)){
      const promptId=split+'::'+id,prompt=prompts.get(promptId);if(typeof prompt!=='string')throw Error('Prompt missing: '+promptId);
      const source=path.resolve(path.dirname(targetFile),relative),caseDir=path.join(dir,'cases',id);fs.mkdirSync(caseDir,{recursive:true});
      const targetHash=copyFile(source,path.join(caseDir,'target.step'));fs.writeFileSync(path.join(caseDir,'prompt.txt'),prompt);
      cases.push({id,split,files:{'target.step':targetHash,'prompt.txt':fileSha(path.join(caseDir,'prompt.txt'))},
        source:{targets_file:path.relative(REPO,targetFile),prompt_id:promptId}});
    }
  }
  if(cases.length!==270)throw Error('Expected 270 one-shot cases, found '+cases.length);
  const v8=path.join(stage,'legacy/v8'),protocol=JSON.parse(fs.readFileSync(path.join(v8,'config/protocol.json'),'utf8'));
  const manifest={schema_version:1,name:'oneshot270-v1',revision:1,mode:'oneshot',read_only:true,created_at:new Date().toISOString(),
    source:{type:'official 270 STEP benchmark and frozen v8 prompt set',benchmark_root:'/data/benchmark/step-benchmark',
      prompt_sha256:fileSha(promptFile),protocol_sha256:fileSha(path.join(v8,'config/protocol.json'))},
    legacy_reference_protocol:{temperature:protocol.generation.temperature,thinking:protocol.generation.thinking,n:protocol.generation.n,
      weights:protocol.scoring.weights,metric:protocol.scoring.metric},
    new_run_protocol:{temperature:1,thinking:true,n:1,score_thresholds:[0.90,0.99],
      note:'User-selected temperature=1; this differs from historical temperature=0 baselines.'},cases};
  manifest.content_sha256=sha256(JSON.stringify(cases));atomicJson(path.join(dir,'manifest.json'),manifest);
  return {name:manifest.name,cases:cases.length,content_sha256:manifest.content_sha256};
}

function adaptAgentPrompt(source){
  let text=source;const transformations=[];
  if(text.includes('SimpleCADAPI 2.1.4')){text=text.replaceAll('SimpleCADAPI 2.1.4','SimpleCADAPI 2.2.5');transformations.push('sdk-version-2.2.5');}
  if(/native read tool/i.test(text)){text=text.replace(/native read tool/gi,'CAD Code tools.view_image via exec');transformations.push('cad-code-image-tool');}
  if(/native OpenCode tools/i.test(text)){text=text.replace(/native OpenCode tools/gi,'CAD Code exec and session tools');transformations.push('cad-code-agent-tools');}
  const lines=text.split(/\r?\n/).map(line=>{
    if(line.includes('/train/')&&line.includes('cadeval.py')){
      transformations.push('local-cad-code-evaluator');
      return 'You may score your code with: "$CAD_CODE_PYTHON" -I tools/cadeval.py eval --code out/rebuild.py --target target.step --out out/check-N --metrics-python "$CAD_CODE_PYTHON". Use a new check-N directory each attempt. Keep the best completed result at the required paths; do not claim success without evidence.';
    }
    return line;
  });
  text=lines.join('\n');
  if(text.includes('/train/')||text.includes('SimpleCADAPI 2.1.4'))throw Error('Agent prompt still contains old server-only environment instructions');
  return {text,transformations};
}

function buildAgent30(){
  const stageRoot=path.join(stage,'agent30'),sourceManifest=JSON.parse(fs.readFileSync(path.join(stageRoot,'manifest.json'),'utf8'));
  const dir=path.join(datasets,'agent30-cadcode-v1');
  if(fs.existsSync(path.join(dir,'manifest.json'))){const existing=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));return {name:existing.name,cases:existing.cases.length,historical_started:existing.source.historical_started_count,statuses:existing.source.historical_statuses,content_sha256:existing.content_sha256,reused:true};}
  ensureFresh(dir);const cases=[];
  for(const source of sourceManifest.cases){
    const id=source.case_id,from=path.join(stageRoot,'cases',id),to=path.join(dir,'cases',id);fs.mkdirSync(to,{recursive:true});
    for(const name of ['target.step','target.ir.jsonl']){
      const expected=name==='target.step'?source.step_sha256:source.ir_sha256;
      const actual=copyFile(path.join(from,name),path.join(to,name));if(actual!==expected)throw Error('Source hash mismatch for '+id+'/'+name);
    }
    const sourcePrompt=fs.readFileSync(path.join(from,'prompt.txt'),'utf8'),adapted=adaptAgentPrompt(sourcePrompt);
    fs.writeFileSync(path.join(to,'prompt.txt'),adapted.text);
    fs.writeFileSync(path.join(to,'source-case.json'),JSON.stringify(JSON.parse(fs.readFileSync(path.join(from,'case.json'),'utf8')),null,2)+'\n');
    cases.push({id,split:source.origin.toLowerCase(),source:{origin:source.origin,run:source.source_run,case:source.source_case,
        archive:source.archive,archive_prefix:source.archive_prefix,step_sha256:source.step_sha256,ir_sha256:source.ir_sha256},
      historical_status:source.run_status,historical_started:source.started,
      source_prompt_sha256:fileSha(path.join(from,'prompt.txt')),prompt_transformations:adapted.transformations,
      files:{'target.step':fileSha(path.join(to,'target.step')),'target.ir.jsonl':fileSha(path.join(to,'target.ir.jsonl')),'prompt.txt':fileSha(path.join(to,'prompt.txt'))}});
  }
  if(cases.length!==30)throw Error('Expected 30 agent cases, found '+cases.length);
  const manifest={schema_version:1,name:'agent30-cadcode-v1',revision:1,mode:'agent',read_only:true,created_at:new Date().toISOString(),
    source:{type:'agent30_20261102 target case collection',scope:'EVAL_ONLY',source_collection_sha256:fileSha(path.join(stageRoot,'manifest.json')),
      historical_started_count:sourceManifest.started_count,historical_statuses:sourceManifest.cases.reduce((a,c)=>(a[c.run_status]=(a[c.run_status]||0)+1,a),{}),
      historical_client:'OpenCode',historical_sdk:'SimpleCADAPI 2.1.4'},
    new_run_protocol:{client:'cad-code',simplecadapi:'2.2.5',temperature:1,vision:true,context_tokens:262144,
      compaction_target_tokens:261120,score_threshold_riou:0.90,
      note:'Prompt is version-adapted for CAD Code; do not merge with historical OpenCode results.'},cases};
  manifest.content_sha256=sha256(JSON.stringify(cases));atomicJson(path.join(dir,'manifest.json'),manifest);
  return {name:manifest.name,cases:cases.length,historical_started:sourceManifest.started_count,statuses:manifest.source.historical_statuses,
    content_sha256:manifest.content_sha256};
}

function buildLegacyHistory(){
  const out=path.join(history,'legacy');fs.mkdirSync(out,{recursive:true});const records=[];
  for(const version of ['v7','v8']){
    const root=path.join(stage,'legacy',version),summary=JSON.parse(fs.readFileSync(path.join(root,'eval/summary.json'),'utf8'));
    const protocol=JSON.parse(fs.readFileSync(path.join(root,'config/protocol.json'),'utf8')),generation=protocol.generation||protocol,scoreRows=[];
    for(const split of ['bench','proxy','dev_real','dev_syn'])for(const line of fs.readFileSync(path.join(root,`eval/score_${split}.jsonl`),'utf8').split(/\r?\n/).filter(Boolean))scoreRows.push({...JSON.parse(line),split});
    const weights={bench:.4,proxy:.3,dev_real:.15,dev_syn:.15};
    const weighted=Object.entries(weights).every(([k])=>Number.isFinite(summary[k]?.mean_riou))?Object.entries(weights).reduce((a,[k,w])=>a+w*summary[k].mean_riou,0):null;
    const runId=`legacy-${version}-oneshot270`;
    const run={schema_version:1,run_id:runId,mode:'oneshot',model:version==='v8'?'Qwen3.8-27B v8 final441':'Qwen3.8-27B v7',dataset:'oneshot270-v1',
      imported:true,source_root:version==='v8'?'/train/outputs/qwen35-27b-v8-oneshot270_20261105':'/train/outputs/eval_qwen35-27b-v7-oneshot270_20261101',
      generation:{temperature:generation.temperature,thinking:generation.thinking,n:generation.n,top_p:generation.top_p??null},
      group_weights:weights,summary:{...summary,weighted_score:weighted},scores:scoreRows};
    atomicJson(path.join(out,runId+'.json'),run);
    for(const row of scoreRows)records.push({run_id:runId,mode:'oneshot',model:run.model,dataset:run.dataset,case_id:row.id,split:row.split,
      temperature:generation.temperature,status:row.status,build_ok:row.build_ok,export_ok:row.export_ok,iou:row.iou,riou:row.riou,finish:row.finish,source:'read-only imported server score'});
  }
  const agent=JSON.parse(fs.readFileSync(path.join(datasets,'agent30-cadcode-v1/manifest.json'),'utf8'));
  for(const c of agent.cases){
    const sourceCase=path.join(stage,'agent30/cases',c.id);let report=null,evalStatus=c.historical_status;
    for(const candidate of ['frozen-output/report.json','evaluation.json']){
      const p=path.join(sourceCase,candidate);if(!fs.existsSync(p))continue;
      try{const item=JSON.parse(fs.readFileSync(p,'utf8'));
        const riou=item.riou??item.robust_iou??item.robust?.result?.riou??null;
        const iou=item.iou??item.strict_iou??item.strict_brep?.result?.iou??null;
        if(Number.isFinite(riou)||Number.isFinite(iou))report={riou,iou};
        if(item.status)evalStatus=item.status;
      }catch{}
    }
    records.push({run_id:'legacy-agent30_20261102',mode:'agent',dataset:agent.name,case_id:c.id,
      status:c.historical_status,started:c.historical_started,evaluator_status:evalStatus,riou:report?.riou??null,iou:report?.iou??null,
      score_status:report?'available':'not_available_in_collection_snapshot',historical_client:'OpenCode',historical_sdk:'SimpleCADAPI 2.1.4',source:c.source});
  }
  const agentRows=records.filter(x=>x.run_id==='legacy-agent30_20261102');
  atomicJson(path.join(out,'legacy-agent30_20261102.json'),{run_id:'legacy-agent30_20261102',mode:'agent',model:'Qwen v7',dataset:agent.name,
    imported:true,created_at:new Date().toISOString(),historical_status_only:true,
    summary:{case_count:agentRows.length,started:agentRows.filter(x=>x.started).length,
      score_available:agentRows.filter(x=>x.score_status==='available').length,
      status_counts:Object.fromEntries([...new Set(agentRows.map(x=>x.status))].map(s=>[s,agentRows.filter(x=>x.status===s).length]))},
    cases:agentRows,source:'30-case target collection and any available frozen evaluation reports; not a completed 30-case run'});
  fs.writeFileSync(path.join(out,'legacy-scores.jsonl'),records.map(JSON.stringify).join('\n')+'\n');
  return {imported_oneshot_score_rows:records.filter(x=>x.mode==='oneshot').length,agent_cases:records.filter(x=>x.mode==='agent').length};
}

const result={one_shot:buildOneShot(),agent:buildAgent30(),history:buildLegacyHistory()};
console.log(JSON.stringify(result,null,2));
