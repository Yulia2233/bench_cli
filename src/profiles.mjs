import fs from 'node:fs';
import path from 'node:path';
import {PROFILES,mkdirPrivate,safeChild,validName,atomicJson,readJson} from './common.mjs';

export function validateProvider(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Profile must be an object');
  const base=value.baseURL??value.base_url,apiKey=value.apiKey??value.api_key,model=String(value.model||'').trim();
  const thinking=value.thinking??true,wire_api=value.wire_api||'responses';
  let url;try{url=new URL(base);}catch{throw Error('Base URL must be an absolute HTTP(S) URL');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('Invalid provider URL');
  if(typeof apiKey!=='string'||!apiKey.trim()||/[\s\x00-\x1f\x7f]/.test(apiKey))throw Error('API key is missing or malformed');
  if(!model||/[\s\x00-\x1f\x7f]/.test(model))throw Error('Model ID is missing or malformed');
  if(typeof thinking!=='boolean')throw Error('thinking must be boolean');
  if(!['responses','chat'].includes(wire_api))throw Error('wire_api must be responses or chat');
  return {baseURL:url.toString().replace(/\/+$/,''),apiKey,model,thinking,wire_api};
}

function profilePath(name,root=PROFILES){
  if(!validName(name))throw Error('Profile name must match [a-z0-9][a-z0-9._-]{0,79}');
  mkdirPrivate(root);return safeChild(root,name+'.json');
}
export function listProfiles({root=PROFILES}={}){mkdirPrivate(root);return fs.readdirSync(root).filter(x=>x.endsWith('.json')).map(file=>{
  const p=path.join(root,file),v=readJson(p);return {name:file.slice(0,-5),base_url:v.baseURL,model:v.model,thinking:v.thinking,wire_api:v.wire_api||'responses',api_key_configured:Boolean(v.apiKey)};
}).sort((a,b)=>a.name.localeCompare(b.name));}
export function loadProfile(name,{root=PROFILES}={}){
  const file=profilePath(name,root);if(!fs.existsSync(file))throw Error('Profile not found: '+name);
  const p=fs.lstatSync(file);if(p.isSymbolicLink()||!p.isFile())throw Error('Profile must be a regular file');
  const raw=readJson(file);return {...validateProvider(raw),wire_api:raw.wire_api||'responses'};
}
export function profileFile(name,{root=PROFILES}={}){const file=profilePath(name,root);loadProfile(name,{root});return file;}
export function saveProfile(name,provider,{root=PROFILES}={}){
  const file=profilePath(name,root);const value={...validateProvider(provider),wire_api:provider.wire_api||'responses'};
  if(!['responses','chat'].includes(value.wire_api))throw Error('wire_api must be responses or chat');
  if(fs.existsSync(file)){const st=fs.lstatSync(file);if(st.isSymbolicLink()||!st.isFile())throw Error('Profile path must be a regular file');}
  atomicJson(file,value,{mode:0o600});fs.chmodSync(file,0o600);
  return {name,base_url:value.baseURL,model:value.model,thinking:value.thinking,wire_api:value.wire_api,api_key_configured:true};
}
export function removeProfile(name,{root=PROFILES}={}){const file=profilePath(name,root);if(fs.existsSync(file)){const st=fs.lstatSync(file);if(st.isSymbolicLink()||!st.isFile())throw Error('Profile path must be a regular file');fs.unlinkSync(file);}}
export async function probeProfile(name){const provider=loadProfile(name);const models=await listProviderModels(provider);return {name,base_url:provider.baseURL,model:provider.model,models,model_list_supported:true};}
async function listProviderModels(provider){
  let response;try{response=await fetch(provider.baseURL+'/models',{headers:{authorization:'Bearer '+provider.apiKey},signal:AbortSignal.timeout(8000)});}
  catch{throw Error('Could not connect to provider /models');}
  if(!response.ok)throw Error('Provider /models returned HTTP '+response.status);
  const data=await response.json(),rows=Array.isArray(data)?data:data.data||data.models;
  if(!Array.isArray(rows))throw Error('Provider /models response has no model list');
  return [...new Set(rows.map(x=>typeof x==='string'?x:x?.id).filter(x=>typeof x==='string'))].sort();
}
