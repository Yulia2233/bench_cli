import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const REPO=path.resolve(process.env.BENCH_REPO_ROOT||path.dirname(ROOT));
export const CAD_CODE=path.resolve(process.env.BENCH_CAD_CODE_DIR||path.join(REPO,'cad-code'));
export const DATA=path.resolve(process.env.BENCH_DATA_DIR||path.join(ROOT,'data'));
export const RUNTIME=path.join(ROOT,'.runtime');
export const RUNS=path.join(RUNTIME,'runs');
export const DATASETS=path.join(DATA,'datasets');
export const MUTABLE_DATASETS=path.join(RUNTIME,'datasets');
export const PROFILES=path.join(RUNTIME,'profiles');
export const HISTORY=path.join(RUNTIME,'history');

export const mkdirPrivate=dir=>fs.mkdirSync(dir,{recursive:true,mode:0o700});
export const sha256=value=>crypto.createHash('sha256').update(value).digest('hex');
export const fileSha=file=>sha256(fs.readFileSync(file));
export const slug=value=>String(value||'').trim();
export const validName=value=>/^[a-z0-9][a-z0-9._-]{0,79}$/.test(value);
export const validCaseId=value=>/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value);

export function atomicJson(file,value,{mode=0o600}={}){
  mkdirPrivate(path.dirname(file));
  const tmp=file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
  try{fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode});fs.renameSync(tmp,file);}
  finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
}

export function readJson(file){return JSON.parse(fs.readFileSync(file,'utf8'));}

export function safeChild(root,name){
  if(typeof name!=='string'||!name||name==='.'||name==='..'||name.includes('/')||name.includes('\\'))throw Error('Invalid path component');
  const result=path.resolve(root,name);
  if(!result.startsWith(path.resolve(root)+path.sep))throw Error('Path escaped root');
  if(fs.existsSync(result)&&fs.lstatSync(result).isSymbolicLink())throw Error('Symlinks are not allowed');
  return result;
}

export function hashTree(root){
  const output=[];
  function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    const full=path.join(dir,entry.name),rel=path.relative(root,full);
    if(entry.isSymbolicLink())throw Error('Dataset contains a symlink: '+rel);
    if(entry.isDirectory())walk(full);
    else if(entry.isFile())output.push({path:rel,size:fs.statSync(full).size,sha256:fileSha(full)});
  }}
  walk(root);return output;
}

export async function mapLimit(items,limit,fn,onResult=()=>{}){
  const n=Number(limit);if(!Number.isSafeInteger(n)||n<1||n>64)throw Error('--parallel must be an integer from 1 to 64');
  let next=0;const results=new Array(items.length);
  async function worker(){while(true){const i=next++;if(i>=items.length)return;let result;
    try{result=await fn(items[i],i);}catch(error){result={status:'runner_error',error:error?.stack||String(error)};}
    results[i]=result;await onResult(result,items[i],i);
  }}
  await Promise.all(Array.from({length:Math.min(n,items.length)},worker));return results;
}

export function parseFlags(args){
  const positional=[],flags={};
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    if(arg==='--'){positional.push(...args.slice(i+1));break;}
    if(!arg.startsWith('--')){positional.push(arg);continue;}
    const name=arg.slice(2);if(!/^[a-z][a-z0-9-]*$/.test(name))throw Error('Invalid option '+arg);
    if(name.startsWith('no-')){flags[name.slice(3)]=false;continue;}
    const value=args[i+1];
    if(value===undefined||value.startsWith('--')){flags[name]=true;continue;}
    flags[name]=value;i++;
  }
  return {positional,flags};
}

export function requireValue(value,name){if(typeof value!=='string'||!value.trim())throw Error(`${name} is required`);return value.trim();}

export async function readStdin(stream=process.stdin){
  let value='';for await(const chunk of stream){value+=chunk;if(value.length>16384)throw Error('Input exceeds 16 KiB');}return value.replace(/\r?\n$/,'');
}

export async function askConfirmation(question,{yes=false,input=process.stdin,output=process.stderr}={}){
  if(yes)return true;
  if(!input.isTTY)throw Error('This operation requires an interactive confirmation or --yes');
  const readline=await import('node:readline/promises');const rl=readline.createInterface({input,output});
  try{return (await rl.question(question+' Type yes: ')).trim()==='yes';}finally{rl.close();}
}
