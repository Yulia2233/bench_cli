import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {CAD_CODE,mapLimit} from './common.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
// Scorer interpreter: CAD Code's runtime (SimpleCADAPI 2.2.7); BENCH_SCORER_PYTHON selects another one, e.g. the
// historical envs/cad214 (2.1.4) when a run must be comparable with the frozen 270-case baselines.
export const SCORER_PYTHON=process.env.BENCH_SCORER_PYTHON||path.join(CAD_CODE,'.runtime/python/bin/python');
const versions=new Map();
export function sdkVersion(python){
  if(!versions.has(python)){const r=spawnSync(python,['-I','-c',"import importlib.metadata as m; print(m.version('simplecadapi'))"],{encoding:'utf8'});
    versions.set(python,r.status===0?r.stdout.trim():null);}
  return versions.get(python);
}
export function isNotebook(file){try{return /^# \[tool\.simplecadapi\]\s*$/m.test(fs.readFileSync(file,'utf8'));}catch{return false;}}

const WEIGHTS={bench:0.4,proxy:0.3,dev_real:0.15,dev_syn:0.15};
const hasMetric=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value));
export function weightedScore(rows,caseById,expectedCaseIds=[...caseById.keys()]){
  const groups={};for(const [name,weight]of Object.entries(WEIGHTS)){
    const values=rows.filter(r=>caseById.get(r.id)?.split===name&&hasMetric(r.riou)).map(r=>Number(r.riou));
    groups[name]={weight,n:values.length,mean:values.length?values.reduce((a,b)=>a+b,0)/values.length:null};
  }
  const observed=new Set(rows.map(r=>r.id));
  const complete=expectedCaseIds.length>0&&expectedCaseIds.length===observed.size&&expectedCaseIds.every(id=>observed.has(id))&&
    expectedCaseIds.every(id=>hasMetric(rows.find(r=>r.id===id)?.riou))&&Object.keys(WEIGHTS).every(k=>groups[k].n>0);
  return {weighted_score:complete?Object.entries(WEIGHTS).reduce((a,[k,w])=>a+w*groups[k].mean,0):null,
    group_weights:WEIGHTS,groups,protocol_complete:complete};
}

export function summarizeScores(rows,cases,{expectedCases=cases}={}){
  const byId=new Map(expectedCases.map(c=>[c.id,c]));const weighted=weightedScore(rows,byId,expectedCases.map(c=>c.id));
  const riou=rows.filter(x=>hasMetric(x.riou)).map(x=>Number(x.riou));
  const strict=rows.filter(x=>hasMetric(x.iou)).map(x=>Number(x.iou));
  return {case_count:cases.length,attempted_count:rows.length,scored_count:riou.length,strict_scored_count:strict.length,
    mean_riou:riou.length?riou.reduce((a,b)=>a+b,0)/riou.length:null,
    mean_iou_strict:strict.length?strict.reduce((a,b)=>a+b,0)/strict.length:null,
    build_count:rows.filter(x=>x.build_ok).length,export_count:rows.filter(x=>x.export_ok).length,
    riou_ge_090:riou.filter(x=>x>=0.90).length,
    riou_ge_099:riou.filter(x=>x>=0.99).length,
    status_counts:Object.fromEntries([...new Set(rows.map(x=>x.status||'unknown'))].sort().map(s=>[s,rows.filter(x=>(x.status||'unknown')===s).length])),
    ...weighted};
}

export async function scoreOneShot({runDir,cases,expectedCases=cases,parallel=4,python=SCORER_PYTHON}){
  if(!fs.existsSync(python))throw Error('One-shot scorer requires '+python);
  const rows=await mapLimit(cases,parallel,async c=>{
    const dir=path.join(runDir,'cases',c.id);
    const content=fs.readFileSync(path.join(dir,'response.txt'),'utf8');const source=extractPythonCode(content);
    const call={id:c.id,k:0,finish:'stop',iou:0,riou:0,status:'no_code',build_ok:false,export_ok:false,valid_cad:false,compared:false,
      exec_error:'',cmp_error:'',rel_vol_err:null,cd:null,hd:null};
    if(!source)return call;
    const sourcePath=path.join(dir,'candidate.py');fs.writeFileSync(sourcePath,source);
    try{const result=await scoreAgentSource({codePath:sourcePath,targetPath:path.join(dir,'input','target.step'),
      outDir:path.join(dir,'evaluation'),python});return {...call,...result,id:c.id,k:0,finish:'stop'};}
    catch(error){return {...call,status:'scorer_error',riou:null,iou:null,build_ok:null,export_ok:null,
      scorer_error:error?.stack||String(error),id:c.id,k:0,finish:'stop'};}
  });
  const summary=summarizeScores(rows,cases,{expectedCases});summary.metric='robust IoU per-set weighted .4/.3/.15/.15; strict B-rep IoU reported separately';
  summary.scorer={python,simplecadapi:sdkVersion(python),strict_comparator:path.join(CAD_CODE,'tools/frozen/compare.py'),
    target_denied_candidate_replay:true,temperature_protocol:'new runs use temperature=1; historical 270 baselines were temperature=0'};
  fs.writeFileSync(path.join(runDir,'scores.jsonl'),rows.map(JSON.stringify).join('\n')+'\n');
  fs.writeFileSync(path.join(runDir,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  return {rows,summary};
}

export function extractPythonCode(text){
  const blocks=[...String(text).matchAll(/```(?:python)?\n([\s\S]*?)```/g)].map(x=>x[1]);
  if(blocks.length===1)return blocks[0];
  if(blocks.length===0&&!String(text).includes('```')&&String(text).includes('def build'))return String(text);
  return null;
}

export async function scoreAgentSource({codePath,targetPath,outDir,python=SCORER_PYTHON}){
  codePath=path.resolve(codePath);targetPath=path.resolve(targetPath);outDir=path.resolve(outDir);python=path.resolve(python);
  if(!fs.existsSync(codePath))return {status:'missing_candidate',build_ok:false,export_ok:false,riou:0,iou:0};
  const base=path.join(CAD_CODE,'tools','cadeval.py');
  fs.mkdirSync(outDir,{recursive:true});
  const execution=path.join(outDir,'execution');fs.mkdirSync(execution,{recursive:true});
  // The scored source is replayed in an empty workspace; target files stay outside it. A notebook (web-editor format)
  // is replayed by run_notebook in the writable replay directory, because the runtime keeps its state next to the file.
  const notebook=isNotebook(codePath);
  const isolatedCode=notebook?path.join(execution,'out','model.py'):path.join(execution,'candidate.py');
  fs.mkdirSync(path.dirname(isolatedCode),{recursive:true});fs.copyFileSync(codePath,isolatedCode);
  const env={...process.env,CAD_CODE_PYTHON:python,CAD_CODE_WORKSPACE:path.join(execution,'workspace'),PYTHONDONTWRITEBYTECODE:'1'};
  const execDir=path.join(execution,'out');fs.mkdirSync(execDir,{recursive:true});
  fs.mkdirSync(path.join(execDir,'.tmp'),{recursive:true});fs.mkdirSync(path.join(execDir,'.home'),{recursive:true});
  env.HOME=path.join(execDir,'.home');env.TMPDIR=path.join(execDir,'.tmp');env.MPLCONFIGDIR=path.join(execDir,'.tmp','mpl');
  fs.mkdirSync(env.MPLCONFIGDIR,{recursive:true});
  const profile=pythonSandboxProfile(python,execDir,[path.dirname(isolatedCode),HERE]);
  const replay=notebook?[path.join(HERE,'replay_notebook.py'),'--notebook',isolatedCode,'--out',execDir]:[base,'_exec','--code',isolatedCode,'--out',execDir];
  const execResult=await runProcess('/usr/bin/sandbox-exec',['-p',profile,python,'-I',...replay],{cwd:execDir,env,timeout:notebook?600000:180000});
  fs.writeFileSync(path.join(outDir,'independent-replay.log'),execResult.stdout+execResult.stderr);
  let executionReport={};try{executionReport=JSON.parse(fs.readFileSync(path.join(execDir,'execution.json'),'utf8'));}catch{}
  if(!executionReport.export_succeeded)return {status:executionReport.error_type||'replay_failed',build_ok:Boolean(executionReport.build_succeeded),export_ok:false,riou:0,iou:0,exec_error:executionReport.error||execResult.stderr.slice(-1000)};
  const rebuilt=path.join(execDir,'rebuilt.step'),comparison=path.join(outDir,'comparison.json');
  const cmp=await runProcess(python,['-I',base,'_cmp','--target',targetPath,'--current',rebuilt,'--out',comparison],{cwd:outDir,env,timeout:360000});
  let strict={};try{strict=JSON.parse(fs.readFileSync(comparison,'utf8'));}catch{}
  let robust={};
  const robustScript=path.join(CAD_CODE,'tools','robust_iou.py');
  const robustRun=await runProcess(python,['-I',robustScript,targetPath,rebuilt],{cwd:outDir,env,timeout:360000}).catch(e=>({stdout:'',stderr:e.message,code:1}));
  try{robust=JSON.parse(robustRun.stdout.trim().split(/\r?\n/).at(-1));}catch{}
  if(robustRun.code!==0||robust.riou===null||robust.riou===undefined||!Number.isFinite(Number(robust.riou)))
    return {status:'scorer_error',build_ok:true,export_ok:true,valid_cad:Boolean(strict.candidate_valid),
      compared:Boolean(strict.comparison_succeeded),iou:Number(strict.iou)||0,riou:null,robust_ok:false,
      robust_error:robustRun.stderr||'robust_iou did not return a numeric riou',
      source_sha256:hashFile(codePath),rebuilt_sha256:hashFile(rebuilt),exec_error:'',cmp_error:strict.error||''};
  return {status:strict.status|| (cmp.code===0?'compared':'comparison_error'),build_ok:true,export_ok:true,
    valid_cad:Boolean(strict.candidate_valid),compared:Boolean(strict.comparison_succeeded),iou:Number(strict.iou)||0,
    riou:Number(robust.riou)||0,robust_ok:Boolean(robust.ok),rel_vol_err:robust.rel_vol_err??strict.rel_vol_err??null,
    source_kind:notebook?'notebook':'module',scorer:{python,simplecadapi:sdkVersion(python),robust_python:python},
    source_sha256:hashFile(codePath),rebuilt_sha256:hashFile(rebuilt),exec_error:'',cmp_error:strict.error||''};
}

function hashFile(file){return createHash('sha256').update(fs.readFileSync(file)).digest('hex');}

function pythonSandboxProfile(python,writable,extraRead=[]){
  const actual=fs.realpathSync(python),prefix=path.dirname(path.dirname(actual));
  const pythonEnvRoot=path.resolve(path.dirname(path.dirname(python)));
  const pthFile=path.join(pythonEnvRoot,'lib/python3.12/site-packages/cad-code-dependencies.pth');
  const pthRoots=fs.existsSync(pthFile)?fs.readFileSync(pthFile,'utf8').split(/\r?\n/).map(x=>x.trim()).filter(x=>x.startsWith('/')):[];
  const writableRoots=[path.resolve(writable),fs.realpathSync(writable)];
  const readRoots=['/System','/Library','/usr','/bin','/sbin','/dev','/opt/homebrew','/private/etc','/private/var/db',
    prefix,path.dirname(actual),pythonEnvRoot,path.join(CAD_CODE,'tools'),path.join(CAD_CODE,'skills/simplecadapi'),...pthRoots,...extraRead];
  const unique=[...new Set(readRoots.filter(x=>fs.existsSync(x)).flatMap(x=>[path.resolve(x),fs.realpathSync(x)]))];
  const q=x=>JSON.stringify(x);
  return `(version 1)\n(deny default)\n(allow process-fork)\n(allow process-exec)\n(allow signal (target self) (target children))\n(allow sysctl-read)\n(allow mach-lookup)\n(allow file-read-metadata)\n(allow file-read* (literal "/") ${unique.map(x=>'(subpath '+q(x)+')').join(' ')})\n(allow file-write* ${[...new Set(writableRoots)].map(x=>'(subpath '+q(x)+')').join(' ')} (literal "/dev/null") (literal "/dev/tty"))\n`;
}
function runProcess(command,args,{cwd,env,timeout}){
  return new Promise((resolve,reject)=>{
    const p=spawn(command,args,{cwd,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
    const timer=setTimeout(()=>{p.kill('SIGKILL');reject(Error('Process timed out'));},timeout);
    p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);
    p.on('error',e=>{clearTimeout(timer);reject(e);});p.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
  });
}
