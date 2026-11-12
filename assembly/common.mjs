// Small filesystem/CLI helpers kept local so this extension can be released independently.
// Semantics follow the existing bench_cli/src/common.mjs helpers; the single-solid module is unchanged.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const mkdirPrivate=directory=>fs.mkdirSync(directory,{recursive:true,mode:0o700});
export const fileSha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));

export function atomicJson(file,value){
  mkdirPrivate(path.dirname(file));
  const temporary=file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
  try{
    fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
    fs.renameSync(temporary,file);
  }finally{
    if(fs.existsSync(temporary))fs.unlinkSync(temporary);
  }
}

export function parseFlags(args){
  const positional=[],flags={};
  for(let index=0;index<args.length;index++){
    const argument=args[index];
    if(argument==='--'){positional.push(...args.slice(index+1));break;}
    if(!argument.startsWith('--')){positional.push(argument);continue;}
    const name=argument.slice(2);
    if(!/^[a-z][a-z0-9-]*$/.test(name))throw Error('Invalid option '+argument);
    const value=args[index+1];
    if(value===undefined||value.startsWith('--'))flags[name]=true;
    else{flags[name]=value;index++;}
  }
  return {positional,flags};
}

export function requireValue(value,name){
  if(typeof value!=='string'||!value.trim())throw Error(name+' is required');
  return value.trim();
}
