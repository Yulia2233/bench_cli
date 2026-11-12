import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DATASETS,MUTABLE_DATASETS,mkdirPrivate,safeChild,validName,validCaseId,atomicJson,readJson,fileSha,hashTree} from './common.mjs';

function roots(){mkdirPrivate(DATASETS);mkdirPrivate(MUTABLE_DATASETS);return [MUTABLE_DATASETS,DATASETS];}
export function resolveDataset(name){
  if(!validName(name))throw Error('Invalid dataset name');
  for(const root of roots()){const dir=safeChild(root,name),manifest=path.join(dir,'manifest.json');
    if(fs.existsSync(manifest)){const m=readJson(manifest);validateManifest(dir,m);return {dir,manifest:m,mutable:root===MUTABLE_DATASETS};}}
  throw Error('Dataset not found: '+name);
}
export function listDatasets(){
  const found=new Map();for(const [root,mutable]of roots().map((x,i)=>[x,i===0])){
    for(const name of fs.readdirSync(root)){const dir=path.join(root,name);if(fs.lstatSync(dir).isSymbolicLink()||!fs.statSync(dir).isDirectory())continue;
      const p=path.join(dir,'manifest.json');if(!fs.existsSync(p))continue;const m=readJson(p);if(found.has(m.name))continue;
      found.set(m.name,{name:m.name,revision:m.revision,mode:m.mode,cases:m.cases?.length||0,mutable,source:m.source||null});}}
  return [...found.values()].sort((a,b)=>a.name.localeCompare(b.name));
}
export function validateManifest(dir,m){
  if(m.schema_version!==1||!validName(m.name)||!Array.isArray(m.cases)||!['oneshot','agent'].includes(m.mode))throw Error('Invalid dataset manifest');
  const ids=new Set();for(const c of m.cases){if(!validCaseId(c.id)||ids.has(c.id))throw Error('Invalid or duplicate case id: '+c.id);ids.add(c.id);
    const caseDir=safeChild(path.join(dir,'cases'),c.id);for(const [file,hash]of Object.entries(c.files||{})){
      if(!['target.step','target.ir.jsonl','prompt.txt'].includes(file))throw Error('Unsupported dataset file: '+file);
      const p=safeChild(caseDir,file);if(!fs.existsSync(p)||!fs.statSync(p).isFile())throw Error(`Missing ${file} for ${c.id}`);
      if(hash&&fileSha(p)!==hash)throw Error(`SHA-256 mismatch in ${c.id}/${file}`);
    }
    if(!c.files?.['target.step']||!c.files?.['prompt.txt'])throw Error('Every case needs a prompt and STEP file: '+c.id);
    if(m.mode==='agent'&&!c.files?.['target.ir.jsonl'])throw Error('Agent cases need target IR: '+c.id);
  }
  return true;
}
export function casePath(dataset,entry,file){return safeChild(safeChild(path.join(dataset.dir,'cases'),entry.id),file);}
function writeManifest(dir,m){m.revision=(m.revision||1)+1;m.updated_at=new Date().toISOString();
  const entries=hashTree(path.join(dir,'cases'));m.content_sha256=crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');atomicJson(path.join(dir,'manifest.json'),m);}
function assertMutable(dataset){if(!dataset.mutable||dataset.manifest.read_only)throw Error('Built-in datasets are read-only; clone this dataset before editing');}
function backupRevision(dataset){
  const root=path.join(dataset.dir,'.revisions'),backup=path.join(root,'revision-'+String(dataset.manifest.revision).padStart(4,'0'));
  if(fs.existsSync(backup))return backup;
  fs.mkdirSync(root,{recursive:true});fs.mkdirSync(backup);
  fs.copyFileSync(path.join(dataset.dir,'manifest.json'),path.join(backup,'manifest.json'));
  fs.cpSync(path.join(dataset.dir,'cases'),path.join(backup,'cases'),{recursive:true,dereference:false});return backup;
}
export function datasetRevisions(name){
  const ds=resolveDataset(name),root=path.join(ds.dir,'.revisions');
  const rows=[];if(fs.existsSync(root))for(const item of fs.readdirSync(root).sort()){
    const p=path.join(root,item,'manifest.json');if(fs.existsSync(p)){const m=readJson(p);rows.push({name:m.name,revision:m.revision,case_count:m.cases.length,content_sha256:m.content_sha256,path:path.relative(ds.dir,path.dirname(p))});}}
  rows.push({name:ds.manifest.name,revision:ds.manifest.revision,case_count:ds.manifest.cases.length,content_sha256:ds.manifest.content_sha256,current:true});return rows;
}
export function cloneDataset(sourceName,newName){
  if(!validName(newName))throw Error('Invalid new dataset name');
  const source=resolveDataset(sourceName),target=safeChild(MUTABLE_DATASETS,newName);if(fs.existsSync(target))throw Error('Dataset already exists: '+newName);
  fs.mkdirSync(target,{recursive:true});
  fs.copyFileSync(path.join(source.dir,'manifest.json'),path.join(target,'manifest.json'));
  fs.cpSync(path.join(source.dir,'cases'),path.join(target,'cases'),{recursive:true,errorOnExist:true,dereference:false});
  const m=readJson(path.join(target,'manifest.json'));m.name=newName;m.revision=1;m.read_only=false;m.parent={name:source.manifest.name,revision:source.manifest.revision,content_sha256:source.manifest.content_sha256||null};m.updated_at=new Date().toISOString();atomicJson(path.join(target,'manifest.json'),m);
  return resolveDataset(newName);
}
function copyInput(source,dest){
  if(!source)return null;const src=path.resolve(source);const st=fs.lstatSync(src);if(st.isSymbolicLink()||!st.isFile())throw Error('Input must be a regular non-symlink file: '+source);
  fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(src,dest);return fileSha(dest);
}
export function addCase(datasetName,{id,split='custom',target,ir,promptFile,prompt,source={}}){
  const ds=resolveDataset(datasetName);assertMutable(ds);if(!validCaseId(id))throw Error('Invalid case id');if(ds.manifest.cases.some(c=>c.id===id))throw Error('Case already exists: '+id);
  backupRevision(ds);
  const dir=safeChild(path.join(ds.dir,'cases'),id);fs.mkdirSync(dir,{recursive:true});
  try{
    const files={'target.step':copyInput(target,path.join(dir,'target.step'))};
    files['target.ir.jsonl']=ir?copyInput(ir,path.join(dir,'target.ir.jsonl')):null;
    if(promptFile)files['prompt.txt']=copyInput(promptFile,path.join(dir,'prompt.txt'));
    else if(typeof prompt==='string'){fs.writeFileSync(path.join(dir,'prompt.txt'),prompt);files['prompt.txt']=fileSha(path.join(dir,'prompt.txt'));}
    if(!files['prompt.txt'])throw Error('Supply --prompt-file or --prompt');
    ds.manifest.cases.push({id,split,source,files,created_at:new Date().toISOString()});writeManifest(ds.dir,ds.manifest);validateManifest(ds.dir,ds.manifest);return ds.manifest.cases.at(-1);
  }catch(e){fs.rmSync(dir,{recursive:true,force:true});throw e;}
}
export function removeCase(datasetName,id){
  const ds=resolveDataset(datasetName);assertMutable(ds);const i=ds.manifest.cases.findIndex(c=>c.id===id);if(i<0)throw Error('Case not found: '+id);
  backupRevision(ds);
  const entry=ds.manifest.cases[i],dir=safeChild(path.join(ds.dir,'cases'),id);fs.rmSync(dir,{recursive:true});ds.manifest.cases.splice(i,1);writeManifest(ds.dir,ds.manifest);return entry;
}
export function editCase(datasetName,id,{target,ir,promptFile,prompt,split,source}){
  const ds=resolveDataset(datasetName);assertMutable(ds);const entry=ds.manifest.cases.find(c=>c.id===id);if(!entry)throw Error('Case not found: '+id);const dir=safeChild(path.join(ds.dir,'cases'),id);
  backupRevision(ds);
  for(const [key,input,file]of [['target.step',target,'target.step'],['target.ir.jsonl',ir,'target.ir.jsonl']])if(input){entry.files[key]=copyInput(input,path.join(dir,file));}
  if(promptFile){entry.files['prompt.txt']=copyInput(promptFile,path.join(dir,'prompt.txt'));}
  else if(prompt!==undefined){fs.writeFileSync(path.join(dir,'prompt.txt'),prompt);entry.files['prompt.txt']=fileSha(path.join(dir,'prompt.txt'));}
  if(split!==undefined)entry.split=split;if(source!==undefined)entry.source=source;entry.updated_at=new Date().toISOString();writeManifest(ds.dir,ds.manifest);validateManifest(ds.dir,ds.manifest);return entry;
}
