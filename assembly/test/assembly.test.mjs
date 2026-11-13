import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fileSha} from '../common.mjs';
import {assemblyInputSummary,loadAssemblyProject,resolveProjectAttempt} from '../datasets.mjs';
import {listAssemblyRuns,showAssemblyRun} from '../history.mjs';
import {stageAssemblyRun} from '../runner.mjs';
import {scoreAssembly} from '../scoring.mjs';

function write(file,text){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}
function fixture(root){
  const project=path.join(root,'project');
  const sourceStep=path.join(project,'source/source.step'),targetStep=path.join(project,'unique/part-000/target.step');
  const sourceIr=path.join(project,'unique/part-000/target.ir.jsonl');
  write(sourceStep,'ISO-10303-21; source');write(targetStep,'ISO-10303-21; part');
  write(sourceIr,'{"stepir_version":"v6.3"}\n');
  const assemblyIr={schema_version:'step-assembly-ir-v1',units:'mm',source:{step_path:'source/source.step',sha256:fileSha(sourceStep)},
    unique_parts:[{id:'part-000',stepir_version:'v6.3',target_step:'unique/part-000/target.step',target_sha256:fileSha(targetStep),
      stepir:'unique/part-000/target.ir.jsonl',stepir_sha256:fileSha(sourceIr)}],
    instances:[{id:'instance-000',part_id:'part-000',placement:{origin:[0,0,0],x_axis:[1,0,0],y_axis:[0,1,0]}}]};
  write(path.join(project,'assembly.ir.json'),JSON.stringify(assemblyIr));
  write(path.join(project,'project.json'),JSON.stringify({schema_version:'cad-code-project-v1',project_id:'fixture',
    assembly_ir:{path:'assembly.ir.json',sha256:fileSha(path.join(project,'assembly.ir.json'))}}));
  const attempt=path.join(project,'assembly','attempt-001'),input=path.join(attempt,'input');
  const childNotebook='# [tool.simplecadapi]\n# id = "part-000"\n';
  const stepir='{"stepir_version":"v6.3"}\n';
  write(path.join(input,'parts/part-000/model.py'),childNotebook);
  write(path.join(input,'parts/part-000/target.ir.jsonl'),stepir);
  write(path.join(input,'assembly.ir.json'),JSON.stringify(assemblyIr));
  write(path.join(input,'assembly-inputs.json'),JSON.stringify({schema_version:'cad-code-assembly-inputs-v1',parts:[{
    part_id:'part-000',notebook:'parts/part-000/model.py',notebook_sha256:fileSha(path.join(input,'parts/part-000/model.py')),
    stepir:'parts/part-000/target.ir.jsonl',stepir_sha256:fileSha(path.join(input,'parts/part-000/target.ir.jsonl')),
    stepeval_verdict:{ok:true}
  }]}));
  write(path.join(attempt,'out/product.py'),'# [tool.simplecadapi]\n# id = "product"\n');
  return {project,attempt,assemblyIr};
}

function mockCadCodeMulti(file){
  write(file,`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args=process.argv.slice(2),action=args[0];
const value=name=>args[args.indexOf(name)+1];
if(action==='status'){process.stdout.write(JSON.stringify({ready_for_assembly:true,api_key:process.env.OPENAI_API_KEY||''})+'\\n');process.exit(0);}
if(action==='assemble'){
  const root=value('--project'),attempt=path.join(root,'assembly','attempt-001');
  process.stdout.write(JSON.stringify({session_id:'ses_fixture_12345678',attempt_dir:attempt,status:'completed',access_token:process.env.OPENAI_API_KEY||''})+'\\n');process.exit(0);
}
process.exit(2);
`);
  fs.chmodSync(file,0o700);
}

function addContext(f){
  const input=path.join(f.attempt,'input'),manifestPath=path.join(input,'assembly-inputs.json');
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  const page='assembly-index/parts-0000.json',index='assembly-context-index.json';
  write(path.join(input,page),JSON.stringify({schema_version:'cad-code-assembly-index-page-v1',rows:[{part_id:'part-000'}]}));
  write(path.join(input,index),JSON.stringify({schema_version:'cad-code-assembly-context-index-v1',pages:{parts:[page],occurrences:[],candidates:[]}}));
  manifest.context_index=index;manifest.context_index_sha256=fileSha(path.join(input,index));
  manifest.files=[{path:index,role:'assembly_context_index',sha256:manifest.context_index_sha256},
    {path:page,role:'assembly_part_index_page',sha256:fileSha(path.join(input,page))}];
  write(manifestPath,JSON.stringify(manifest));
  return {input,manifestPath,manifest,index,page};
}

test('assembly IR validation enforces unique parts, v6.3, instance references and placements',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bench-assembly-ir-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const f=fixture(root),project=loadAssemblyProject(f.project);
  assert.equal(project.assemblyIr.instances.length,1);
  assert.equal(project.assemblyIr.unique_parts[0].stepir_version,'v6.3');
  f.assemblyIr.instances.push({...f.assemblyIr.instances[0],id:'instance-001',part_id:'unknown'});
  write(path.join(f.project,'assembly.ir.json'),JSON.stringify(f.assemblyIr));
  assert.throws(()=>loadAssemblyProject(f.project),/hash mismatch/);
});

test('project input paths must be relative, hashes must match, and symlinks fail closed',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bench-assembly-paths-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const f=fixture(root),irPath=path.join(f.project,'assembly.ir.json');
  const projectRecord=JSON.parse(fs.readFileSync(path.join(f.project,'project.json'),'utf8'));
  delete projectRecord.assembly_ir.sha256;write(path.join(f.project,'project.json'),JSON.stringify(projectRecord));
  const ir=JSON.parse(fs.readFileSync(irPath,'utf8'));ir.source.step_path=path.join(f.project,'source/source.step');write(irPath,JSON.stringify(ir));
  assert.throws(()=>loadAssemblyProject(f.project),/project-relative/);
  ir.source.step_path='source/source.step';ir.source.sha256='incorrect';write(irPath,JSON.stringify(ir));
  assert.throws(()=>loadAssemblyProject(f.project),/source STEP hash mismatch/);
  ir.source.sha256=fileSha(path.join(f.project,'source/source.step'));write(irPath,JSON.stringify(ir));
  ir.unique_parts[0].stepir_sha256='incorrect';write(irPath,JSON.stringify(ir));
  assert.throws(()=>loadAssemblyProject(f.project),/STEPIR hash mismatch/);
  ir.unique_parts[0].stepir_sha256=fileSha(path.join(f.project,'unique/part-000/target.ir.jsonl'));write(irPath,JSON.stringify(ir));
  const target=path.join(f.project,'unique/part-000/target.step'),saved=target+'.saved';
  fs.renameSync(target,saved);fs.symlinkSync(saved,target);
  assert.throws(()=>loadAssemblyProject(f.project),/symlink/);
  assert.throws(()=>resolveProjectAttempt(f.project,path.join(root,'outside')),/outside the project/);
  const internalLink=path.join(f.project,'assembly','attempt-link');fs.symlinkSync(f.attempt,internalLink,'dir');
  assert.throws(()=>resolveProjectAttempt(f.project,internalLink),/symlink/);
});

test('assembly input validation checks relative notebook and STEPIR files plus declared hashes',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bench-assembly-inputs-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const f=fixture(root),info=loadAssemblyProject(f.project),summary=assemblyInputSummary(info,f.attempt);
  assert.equal(summary.files.length,2);
  assert.equal(summary.files[0].kind,'notebook');
  const inputs=path.join(f.attempt,'input','assembly-inputs.json');
  const data=JSON.parse(fs.readFileSync(inputs,'utf8'));data.parts[0].notebook_sha256='bad';write(inputs,JSON.stringify(data));
  assert.throws(()=>assemblyInputSummary(info,f.attempt),/Notebook hash mismatch/);
  data.parts[0].notebook_sha256=fileSha(path.join(f.attempt,'input','parts/part-000/model.py'));
  data.parts[0].stepeval_verdict='invalid';write(inputs,JSON.stringify(data));
  assert.throws(()=>assemblyInputSummary(info,f.attempt),/Invalid stepeval verdict/);
  data.parts[0].notebook='../../out/product.py';delete data.parts[0].notebook_sha256;write(inputs,JSON.stringify(data));
  assert.throws(()=>assemblyInputSummary(info,f.attempt),/escapes the input snapshot/);
  data.parts[0].notebook='parts/part-000/model.py';
  const notebook=path.join(f.attempt,'input',data.parts[0].notebook),saved=notebook+'.saved';
  fs.renameSync(notebook,saved);fs.symlinkSync(saved,notebook);data.parts[0].notebook_sha256=fileSha(saved);write(inputs,JSON.stringify(data));
  assert.throws(()=>assemblyInputSummary(info,f.attempt),/symlink/);
});

test('score invokes evaluator with exact input hashes and retains actual verdict schema',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bench-assembly-blocked-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const f=fixture(root),evaluator=path.join(root,'eval.mjs');
  write(evaluator,`import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
const args=process.argv.slice(2),v=name=>args[args.indexOf(name)+1],sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const inputs=JSON.parse(fs.readFileSync(v('--inputs')));if(!inputs.replay_files.some(f=>f.path==='product.py'))process.exit(2);
fs.writeFileSync(path.join(v('--out'),'verdict.json'),JSON.stringify({schema_version:'assembly-verdict-v1',ok:true,
assembly_ir_sha256:sha(v('--assembly-ir')),notebook_sha256:sha(v('--notebook')),inputs_sha256:sha(v('--inputs'))}));`);
  const result=await scoreAssembly({projectPath:f.project,attemptDir:f.attempt,outDir:path.join(root,'scored'),evaluator,python:process.execPath});
  assert.equal(result.status,'completed');
  assert.equal(result.verdict.ok,true);
  const scoreDir=path.join(root,'score'),cli=fileURLToPath(new URL('../bench_assembly',import.meta.url));
  const cliResult=spawnSync(cli,['score','--project',f.project,'--attempt-dir',f.attempt,'--out',scoreDir,'--evaluator',evaluator,'--python',process.execPath],{encoding:'utf8'});
  assert.equal(cliResult.status,0,cliResult.stderr);
  assert.equal(JSON.parse(cliResult.stdout).status,'completed');
  assert.equal(fs.existsSync(path.join(scoreDir,'verdict.json')),true);
});

test('assembly runner calls only status/assemble, snapshots validated artifacts, and does not evaluate the candidate',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bench-assembly-run-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const f=fixture(root),cli=path.join(root,'cad-code-multi'),out=path.join(root,'runs');mockCadCodeMulti(cli);
  const secret='fixture-secret-that-must-not-be-written';
  const {runDir,run}=await stageAssemblyRun({projectPath:f.project,outRoot:out,cadCodeMulti:cli,env:{...process.env,OPENAI_API_KEY:secret}});
  assert.equal(run.status,'staged');
  assert.equal(run.score_status,'not_evaluated');
  assert.equal(run.candidate_executed,false);
  assert.equal(fs.existsSync(path.join(runDir,'candidate/out/product.py')),true);
  assert.equal(fs.existsSync(path.join(runDir,'source/input/assembly.ir.json')),true);
  assert.equal(fs.existsSync(path.join(runDir,'source/input/parts/part-000/model.py')),true);
  assert.equal(fs.existsSync(path.join(runDir,'source/input/parts/part-000/target.step')),false);
  const saved=fs.readdirSync(runDir).filter(name=>name.endsWith('.log')).map(name=>fs.readFileSync(path.join(runDir,name),'utf8')).join('\n')+
    fs.readFileSync(path.join(runDir,'run.json'),'utf8');
  assert.equal(saved.includes(secret),false);
  assert.deepEqual(listAssemblyRuns(out).map(row=>row.run_id),[run.run_id]);
  assert.equal(showAssemblyRun(run.run_id,out).replay.candidate_executed,false);
});

test('assembly runner refuses to persist a candidate containing a secret from the environment',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bench-assembly-secret-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const f=fixture(root),cli=path.join(root,'cad-code-multi'),out=path.join(root,'runs');mockCadCodeMulti(cli);
  const secret='fixture-secret-that-must-not-be-written';
  fs.appendFileSync(path.join(f.attempt,'out/product.py'),`\n# ${secret}\n`);
  const {runDir,run}=await stageAssemblyRun({projectPath:f.project,outRoot:out,cadCodeMulti:cli,env:{...process.env,OPENAI_API_KEY:secret}});
  assert.equal(run.status,'runner_error');
  assert.match(run.error,/contains a secret/);
  assert.equal(fs.existsSync(path.join(runDir,'candidate/out/product.py')),false);
  assert.equal(fs.readFileSync(path.join(runDir,'run.json'),'utf8').includes(secret),false);
});

test('assembly runner archives hash-bound context index and pages with legacy child inputs',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bench-assembly-context-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const f=fixture(root),context=addContext(f),cli=path.join(root,'cad-code-multi');mockCadCodeMulti(cli);
  const {runDir,run}=await stageAssemblyRun({projectPath:f.project,outRoot:path.join(root,'runs'),cadCodeMulti:cli});
  assert.equal(run.status,'staged');
  for(const name of [context.index,context.page,'parts/part-000/model.py','parts/part-000/target.ir.jsonl']){
    const saved=path.join(runDir,'source/input',name);
    assert.equal(fileSha(saved),fileSha(path.join(context.input,name)));
    assert.ok(run.snapshots.some(row=>row.path==='source/input/'+name&&row.sha256===fileSha(saved)));
  }
});

test('assembly context archive rejects changed, unmanifested and escaped pages',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bench-assembly-context-invalid-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const f=fixture(root),c=addContext(f),project=loadAssemblyProject(f.project),pagePath=path.join(c.input,c.page);
  fs.appendFileSync(pagePath,' ');
  assert.throws(()=>assemblyInputSummary(project,f.attempt),/context asset hash mismatch/);
  c.manifest.files[1].sha256=fileSha(pagePath);
  c.manifest.files=c.manifest.files.slice(0,1);write(c.manifestPath,JSON.stringify(c.manifest));
  assert.throws(()=>assemblyInputSummary(project,f.attempt),/page is missing from the file manifest/);
  c.manifest.files.push({path:'../../outside.json',role:'assembly_part_index_page',sha256:'bad'});
  write(c.manifestPath,JSON.stringify(c.manifest));
  assert.throws(()=>assemblyInputSummary(project,f.attempt),/escapes the input snapshot/);
});
