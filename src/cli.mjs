#!/usr/bin/env node
import {DATA,RUNS,parseFlags,readStdin,requireValue,askConfirmation,validName} from './common.mjs';
import {loadProfile,listProfiles,saveProfile,removeProfile,probeProfile} from './profiles.mjs';
import {listDatasets,resolveDataset,cloneDataset,addCase,removeCase,editCase,datasetRevisions} from './datasets.mjs';
import {runOneShot} from './oneshot.mjs';
import {runAgent} from './agent.mjs';
import {listHistory,showHistory,compareRuns,clearImportedHistory} from './history.mjs';
import {workspacePlan,clearRunWorkspaces,clearTraceFiles,purgeRun} from './cleanup.mjs';

const HELP=[
  'bench_cli · CAD 单次生成与 Agent 评测','',
  '配置：','  bench_cli profile set NAME --base-url URL --model ID [--wire-api responses|chat]',
  '  bench_cli profile show|test|remove NAME [--yes]','','数据：',
  '  bench_cli dataset list|show|revisions NAME','  bench_cli dataset clone SOURCE NEW_NAME',
  '  bench_cli dataset add NAME --id ID --target FILE --prompt-file FILE [--ir FILE] [--split NAME]',
  '  bench_cli dataset edit NAME ID [--target FILE] [--prompt-file FILE] [--ir FILE] [--split NAME]',
  '  bench_cli dataset remove NAME ID [--yes]','','运行：',
  '  bench_cli run oneshot --dataset oneshot270-v1 --profile NAME [--parallel N] [--limit N] [--cases ID,ID]',
  '  bench_cli run agent --dataset agent30-cadcode-v1 --profile NAME [--parallel N] [--timeout SECONDS]',
  '','','历史：','  bench_cli history list [--mode oneshot|agent]','  bench_cli history show RUN_ID',
  '  bench_cli history compare RUN_ID RUN_ID','  bench_cli history delete RUN_ID --yes',
  '  bench_cli history delete-legacy LEGACY_ID --yes','','清理：',
  '  bench_cli clean workspace --run RUN_ID [--yes]','  bench_cli clean workspace --all-completed [--yes]',
  '  bench_cli clean workspace --free-gb N [--yes]',
  '  bench_cli clean traces --run RUN_ID --yes','','API key 使用隐藏终端输入；非交互时用 --api-key-stdin 从 stdin 读取。',
  'Agent run 自动打开 CAD Code 实时网页，并使用本地 CLI 配置的模型与运行参数。',''
].join('\n');

function output(value){process.stdout.write((typeof value==='string'?value:JSON.stringify(value,null,2))+'\n');}
function listOptions(options,names){for(const k of Object.keys(options))if(!names.includes(k))throw Error('Unknown option --'+k);}
function comma(value){return value?String(value).split(',').map(x=>x.trim()).filter(Boolean):null;}

async function handleProfile(args){
  const {positional,flags}=parseFlags(args),action=positional[0];
  if(action==='list'){listOptions(flags,[]);output(listProfiles());return;}
  if(action==='set'||action==='add'){
    const name=requireValue(positional[1],'Profile name');listOptions(flags,['base-url','model','thinking','wire-api','api-key-stdin']);
    if(!validName(name))throw Error('Invalid profile name');
    let old=null;try{old=loadProfile(name);}catch{}
    const baseURL=flags['base-url']||old?.baseURL,model=flags.model||old?.model;
    if(!baseURL||!model)throw Error('--base-url and --model are required for a new profile');
    let apiKey=old?.apiKey;if(flags['api-key-stdin'])apiKey=await readStdin();
    else if(!apiKey)apiKey=await readHiddenKey();
    const thinking=flags.thinking===undefined?(old?.thinking??true):flags.thinking==='on'?true:flags.thinking==='off'?false:(()=>{throw Error('--thinking must be on or off');})();
    const wire_api=flags['wire-api']||old?.wire_api||'responses';if(!['responses','chat'].includes(wire_api))throw Error('--wire-api must be responses or chat');
    output(saveProfile(name,{baseURL,apiKey,model,thinking,wire_api}));return;
  }
  const name=requireValue(positional[1],'Profile name');
  if(action==='show'){listOptions(flags,[]);const p=loadProfile(name);output({name,base_url:p.baseURL,model:p.model,thinking:p.thinking,wire_api:p.wire_api,api_key_configured:true});return;}
  if(action==='test'){listOptions(flags,[]);output(await probeProfile(name));return;}
  if(action==='remove'){listOptions(flags,['yes']);const ok=await askConfirmation('Remove local API profile '+name+'?',{yes:Boolean(flags.yes)});if(!ok){output('cancelled');return;}removeProfile(name);output({removed:name});return;}
  throw Error('Use profile list|set|show|test|remove');
}

async function readHiddenKey(){
  if(!process.stdin.isTTY||typeof process.stdin.setRawMode!=='function')throw Error('Use --api-key-stdin for non-interactive key input');
  process.stderr.write('API key (input hidden): ');const input=process.stdin,output=process.stderr,wasRaw=input.isRaw,wasPaused=input.isPaused();
  input.setRawMode(true);input.resume();
  return await new Promise((resolve,reject)=>{let value='';
    const done=error=>{input.off('data',onData);input.setRawMode(wasRaw);if(wasPaused)input.pause();output.write('\n');error?reject(error):resolve(value);};
    const onData=chunk=>{for(const c of String(chunk)){if(c==='\u0003')return done(Error('Cancelled'));if(c==='\r'||c==='\n')return done();if(c==='\u007f'||c==='\b')value=Array.from(value).slice(0,-1).join('');else if(c>=' ')value+=c;if(value.length>8192)return done(Error('API key too long'));}};
    input.on('data',onData);
  });
}

async function handleDataset(args){
  const {positional,flags}=parseFlags(args),action=positional[0];
  if(action==='list'){listOptions(flags,[]);output(listDatasets());return;}
  if(action==='show'){listOptions(flags,[]);const ds=resolveDataset(requireValue(positional[1],'Dataset name'));output({name:ds.manifest.name,mode:ds.manifest.mode,revision:ds.manifest.revision,read_only:Boolean(ds.manifest.read_only),case_count:ds.manifest.cases.length,source:ds.manifest.source||null,content_sha256:ds.manifest.content_sha256});return;}
  if(action==='revisions'){listOptions(flags,[]);output(datasetRevisions(requireValue(positional[1],'Dataset name')));return;}
  if(action==='clone'){listOptions(flags,[]);const ds=cloneDataset(requireValue(positional[1],'Source dataset'),requireValue(positional[2],'New dataset name'));output({name:ds.manifest.name,mode:ds.manifest.mode,case_count:ds.manifest.cases.length,mutable:ds.mutable});return;}
  if(action==='add'||action==='edit'){
    const name=requireValue(positional[1],'Dataset name'),id=action==='edit'?requireValue(positional[2],'Case ID'):requireValue(flags.id,'--id');
    listOptions(flags,['id','target','ir','prompt-file','split','yes']);
    if(action==='add'){
      if(!flags.target||!flags['prompt-file'])throw Error('--target and --prompt-file are required');
      output(addCase(name,{id,target:flags.target,ir:flags.ir,promptFile:flags['prompt-file'],split:flags.split||'custom'}));
    }else{
      const ok=await askConfirmation('Create an edited case revision for '+name+'/'+id+'?',{yes:Boolean(flags.yes)});if(!ok){output('cancelled');return;}
      output(editCase(name,id,{target:flags.target,ir:flags.ir,promptFile:flags['prompt-file'],split:flags.split}));
    }return;
  }
  if(action==='remove'){
    const name=requireValue(positional[1],'Dataset name'),id=requireValue(positional[2],'Case ID');listOptions(flags,['yes']);
    const ok=await askConfirmation('Remove case '+name+'/'+id+' from this mutable dataset?',{yes:Boolean(flags.yes)});if(!ok){output('cancelled');return;}
    output(removeCase(name,id));return;
  }
  throw Error('Use dataset list|show|clone|add|edit|remove');
}

async function handleRun(args){
  const {positional,flags}=parseFlags(args),mode=positional[0];
  if(mode==='oneshot'){
    listOptions(flags,['dataset','profile','parallel','limit','cases','max-output-tokens']);
    const result=await runOneShot({datasetName:requireValue(flags.dataset,'--dataset'),profileName:requireValue(flags.profile,'--profile'),
      parallel:flags.parallel?Number(flags.parallel):1,limit:flags.limit?Number(flags.limit):null,caseIds:comma(flags.cases),
      maxTokens:flags['max-output-tokens']?Number(flags['max-output-tokens']):24576});
    output({run_id:result.run.id,status:result.run.status,summary:result.run.summary,run_dir:result.runDir});return;
  }
  if(mode==='agent'){
    listOptions(flags,['dataset','profile','parallel','timeout','cases']);
    const result=await runAgent({datasetName:requireValue(flags.dataset,'--dataset'),profileName:requireValue(flags.profile,'--profile'),
      parallel:flags.parallel?Number(flags.parallel):1,timeout:flags.timeout?Number(flags.timeout):5400,caseIds:comma(flags.cases),openWeb:true});
    output({run_id:result.run.id,status:result.run.status,website:result.run.website,summary:result.run.summary,run_dir:result.runDir});return;
  }
  throw Error('Use run oneshot|agent');
}

async function handleHistory(args){
  const {positional,flags}=parseFlags(args),action=positional[0];
  if(action==='list'){listOptions(flags,['mode','limit']);output(listHistory({mode:flags.mode||null,limit:flags.limit?Number(flags.limit):100}));return;}
  if(action==='show'){listOptions(flags,[]);output(showHistory(requireValue(positional[1],'Run ID')));return;}
  if(action==='compare'){listOptions(flags,[]);output(compareRuns(positional.slice(1)));return;}
  if(action==='delete'){
    listOptions(flags,['yes']);const id=requireValue(positional[1],'Run ID');const ok=await askConfirmation('Permanently delete this bench_cli run and its trace/history '+id+'?',{yes:Boolean(flags.yes)});
    if(!ok){output('cancelled');return;}output(await purgeRun(id,{yes:true}));return;
  }
  if(action==='delete-legacy'){
    listOptions(flags,['yes']);const id=requireValue(positional[1],'Legacy id');const ok=await askConfirmation('Delete the local imported legacy snapshot '+id+'? Original server records are unchanged.',{yes:Boolean(flags.yes)});
    if(!ok){output('cancelled');return;}output(clearImportedHistory(id,{yes:true}));return;
  }
  throw Error('Use history list|show|compare|delete|delete-legacy');
}

async function handleClean(args){
  const {positional,flags}=parseFlags(args),action=positional[0];
  if(action==='workspace'){
    listOptions(flags,['run','all-completed','free-gb','yes','dry-run']);let ids=null,plan;
    if(flags.run){ids=[flags.run];plan=workspacePlan(ids);}
    else if(flags['free-gb']){
      const wanted=Number(flags['free-gb'])*1024*1024*1024;if(!Number.isFinite(wanted)||wanted<=0)throw Error('--free-gb must be a positive number');
      const candidates=workspacePlan().filter(x=>x.run_status!=='running').sort((a,b)=>(a.run_created_at||'').localeCompare(b.run_created_at||''));
      const bytesByRun=new Map();for(const row of candidates)bytesByRun.set(row.run_id,(bytesByRun.get(row.run_id)||0)+row.bytes);
      ids=[];let planned=0;for(const [runId,bytes]of bytesByRun){ids.push(runId);planned+=bytes;if(planned>=wanted)break;}
      plan=candidates.filter(x=>ids.includes(x.run_id));
      if(planned<wanted)console.error('Warning: available completed CAD workspaces contain only '+planned+' bytes; requested '+wanted+'.');
    }else if(flags['all-completed']){plan=workspacePlan().filter(x=>x.run_status!=='running');ids=[...new Set(plan.map(x=>x.run_id))];}
    else throw Error('Choose --run RUN_ID, --all-completed, or --free-gb N');
    if(plan.some(x=>x.run_status==='running'))throw Error('A selected run is active; stop it before cleanup');
    const bytes=plan.reduce((n,x)=>n+x.bytes,0);if(flags['dry-run']||!flags.yes){output({dry_run:true,planned_cases:plan.length,total_bytes:bytes,plan});return;}
    output(await clearRunWorkspaces(ids,{dryRun:false}));return;
  }
  if(action==='traces'){
    listOptions(flags,['run','yes']);const id=requireValue(flags.run,'--run');const ok=await askConfirmation('Clear raw trace/request files for '+id+'? Scores and CAD workspaces will be preserved.',{yes:Boolean(flags.yes)});
    if(!ok){output('cancelled');return;}output(await clearTraceFiles(id));return;
  }
  throw Error('Use clean workspace or clean traces');
}

async function main(){
  const args=process.argv.slice(2),{positional,flags}=parseFlags(args),command=positional[0];
  if(!command||command==='help'||flags.help){process.stdout.write(HELP);return;}
  if(command==='profile')return handleProfile(args.slice(1));
  if(command==='dataset')return handleDataset(args.slice(1));
  if(command==='run')return handleRun(args.slice(1));
  if(command==='history')return handleHistory(args.slice(1));
  if(command==='clean')return handleClean(args.slice(1));
  if(command==='status'){listOptions(flags,[]);return output({profiles:listProfiles(),datasets:listDatasets(),history:listHistory({limit:20}),runs_root:RUNS});}
  throw Error('Unknown command: '+command+'\n'+HELP);
}
main().catch(error=>{console.error(error?.stack||String(error));process.exitCode=1;});
