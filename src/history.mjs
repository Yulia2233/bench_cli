import fs from 'node:fs';
import path from 'node:path';
import {HISTORY,RUNS,DATA,atomicJson,readJson,mkdirPrivate} from './common.mjs';

function readLegacy(){
  const dir=path.join(DATA,'history','legacy'),runs=[];if(!fs.existsSync(dir))return runs;
  for(const p of fs.readdirSync(dir).filter(x=>x.endsWith('.json'))){const x=readJson(path.join(dir,p));runs.push({id:x.run_id,mode:x.mode,model:x.model,status:'imported',imported:true,
    score:x.summary?.weighted_score??null,cases:x.summary?.case_count??x.scores?.length??x.score_rows?.length??x.cases?.length??x.case_count??0,created_at:x.imported_at||x.created_at,source:x.source_root||x.source});}
  return runs;
}
function readRuns(){
  if(!fs.existsSync(RUNS))return [];
  return fs.readdirSync(RUNS).filter(id=>fs.existsSync(path.join(RUNS,id,'run.json'))).map(id=>{
    const r=readJson(path.join(RUNS,id,'run.json'));return {id:r.id,mode:r.mode,model:r.profile?.model,status:r.status,
      score:r.summary?.weighted_score??r.summary?.mean_riou??null,cases:r.summary?.case_count??r.cases?.length??0,created_at:r.created_at,dataset:r.dataset?.name};
  });
}
export function listHistory({mode=null,limit=100}={}){
  return [...readLegacy(),...readRuns()].filter(x=>!mode||x.mode===mode).sort((a,b)=>(b.created_at||'').localeCompare(a.created_at||'')).slice(0,limit);
}
export function showHistory(id){
  const runDir=path.join(RUNS,id,'run.json');if(fs.existsSync(runDir)){
    const run=readJson(runDir),scores=path.join(RUNS,id,'scores.jsonl');
    if(fs.existsSync(scores))run.scores=fs.readFileSync(scores,'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
    return run;
  }
  const legacy=path.join(DATA,'history','legacy');if(fs.existsSync(legacy))for(const p of fs.readdirSync(legacy).filter(x=>x.endsWith('.json'))){
    const value=readJson(path.join(legacy,p));if(value.run_id===id)return value;
  }
  throw Error('History item not found: '+id);
}
export function compareRuns(ids){
  if(ids.length!==2)throw Error('history compare requires exactly two run IDs');
  const [a,b]=ids.map(showHistory);if(a.mode!==b.mode)throw Error('Cannot compare different benchmark modes');
  if(a.mode==='oneshot'){
    const rowsA=a.scores||a.score_rows||[],rowsB=b.scores||b.score_rows||[],mapA=new Map(rowsA.map(x=>[x.id,x])),mapB=new Map(rowsB.map(x=>[x.id,x]));
    const overlap=[...mapA.keys()].filter(k=>mapB.has(k));
    const datasetA=typeof a.dataset==='string'?a.dataset:a.dataset?.name,datasetB=typeof b.dataset==='string'?b.dataset:b.dataset?.name;
    const temperatureA=a.generation?.temperature??a.profile?.temperature,temperatureB=b.generation?.temperature??b.profile?.temperature;
    return {mode:a.mode,a:a.run_id||a.id,b:b.run_id||b.id,
      dataset_compatible:datasetA===datasetB,temperature_a:temperatureA??null,temperature_b:temperatureB??null,
      protocol_match:datasetA===datasetB&&temperatureA===temperatureB,case_overlap:overlap.length,
      delta_weighted_score:Number.isFinite(a.summary?.weighted_score)&&Number.isFinite(b.summary?.weighted_score)?b.summary.weighted_score-a.summary.weighted_score:null,
      per_case:overlap.map(id=>({id,a:mapA.get(id).riou,b:mapB.get(id).riou,delta:(Number(mapB.get(id).riou)||0)-(Number(mapA.get(id).riou)||0)}))};
  }
  const casesA=a.cases||[],casesB=b.cases||[],mapA=new Map(casesA.map(x=>[x.case_id||x.id,x])),mapB=new Map(casesB.map(x=>[x.case_id||x.id,x]));
  const overlap=[...mapA.keys()].filter(k=>mapB.has(k));return {mode:a.mode,a:a.run_id||a.id,b:b.run_id||b.id,
    dataset_a:typeof a.dataset==='string'?a.dataset:a.dataset?.name??null,dataset_b:typeof b.dataset==='string'?b.dataset:b.dataset?.name??null,
    temperature_a:a.environment?.temperature??a.generation?.temperature??null,temperature_b:b.environment?.temperature??b.generation?.temperature??null,
    case_overlap:overlap.length,
    per_case:overlap.map(id=>({id,status_a:mapA.get(id).status,status_b:mapB.get(id).status,riou_a:mapA.get(id).riou,riou_b:mapB.get(id).riou,
      delta:(Number(mapB.get(id).riou)||0)-(Number(mapA.get(id).riou)||0)}))};
}

export function clearImportedHistory(id,{yes=false}={}){
  if(!yes)throw Error('Deleting an imported local history snapshot requires confirmation');
  const file=path.join(DATA,'history','legacy',id+'.json');
  if(!fs.existsSync(file))throw Error('Imported history file not found: '+id);
  fs.unlinkSync(file);return {deleted:id,original_server_records_changed:false};
}

export function writeHistoryIndex(){
  mkdirPrivate(HISTORY);const history=listHistory({limit:100000});atomicJson(path.join(HISTORY,'index.json'),{updated_at:new Date().toISOString(),runs:history});return history;
}
