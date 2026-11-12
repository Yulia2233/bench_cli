import fs from 'node:fs';
import path from 'node:path';
import {readJson} from './common.mjs';

export function listAssemblyRuns(root){
  if(!fs.existsSync(root))return [];
  return fs.readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&!entry.isSymbolicLink())
    .map(entry=>{
      const runDir=path.join(root,entry.name),file=path.join(runDir,'run.json');
      if(!fs.existsSync(file))return null;
      try{
        const run=readJson(file);
        if(run.schema_version!=='bench-assembly-run-v1')return null;
        return {run_id:run.run_id,status:run.status,score_status:run.score_status,created_at:run.created_at,
          project_id:run.project?.id||null,session_id:run.session_id||null,attempt_dir:run.attempt_dir||null,run_dir:runDir};
      }catch{return null;}
    }).filter(Boolean).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
}

export function showAssemblyRun(idOrPath,root){
  const candidate=path.resolve(idOrPath);
  let runDir=fs.existsSync(candidate)&&fs.statSync(candidate).isDirectory()?candidate:null;
  if(!runDir){
    if(typeof idOrPath!=='string'||idOrPath.includes('/')||idOrPath.includes('\\')||idOrPath==='.'||idOrPath==='..')
      throw Error('Invalid assembly run id');
    runDir=path.join(root,idOrPath);
  }
  const file=path.join(runDir,'run.json');
  if(!fs.existsSync(file))throw Error('Assembly run not found: '+idOrPath);
  const record=readJson(file);
  if(record.schema_version!=='bench-assembly-run-v1')throw Error('Unsupported assembly run record');
  return record;
}
