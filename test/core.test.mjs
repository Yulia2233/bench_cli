import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DATA,DATASETS,MUTABLE_DATASETS,RUNS,mapLimit,parseFlags,validCaseId} from '../src/common.mjs';
import {loadProfile,listProfiles,saveProfile,removeProfile} from '../src/profiles.mjs';
import {extractPythonCode,summarizeScores} from '../src/scoring.mjs';
import {addCase,editCase,removeCase,resolveDataset,datasetRevisions,cloneDataset} from '../src/datasets.mjs';
import {compareRuns,showHistory} from '../src/history.mjs';
import {purgeRun,clearTraceFiles,clearImportedHistory,workspacePlan} from '../src/cleanup.mjs';
import {classifyAgentResult} from '../src/agent.mjs';

const hasBuiltInData=['oneshot270-v1','agent30-cadcode-v1'].every(name=>fs.existsSync(path.join(DATASETS,name,'manifest.json')));
const hasLegacyHistory=fs.existsSync(path.join(DATA,'history/legacy/legacy-v7-oneshot270.json'))&&
  fs.existsSync(path.join(DATA,'history/legacy/legacy-v8-oneshot270.json'))&&
  fs.existsSync(path.join(DATA,'history/legacy/legacy-agent30_20261102.json'));

test('one-shot extract accepts only one fenced or bare build result',()=>{
  assert.match(extractPythonCode('```python\ndef build(): return 1\n```'),/def build/);
  assert.equal(extractPythonCode('```python\nx=1\n```\n```python\ny=2\n```'),null);
  assert.equal(extractPythonCode('text only'),null);
});

test('parallel work respects its bound and returns results in case order',async()=>{
  let active=0,maximum=0;
  const rows=await mapLimit([30,10,20],2,async value=>{active++;maximum=Math.max(active,maximum);await new Promise(r=>setTimeout(r,value));active--;return value;});
  assert.equal(maximum,2);assert.deepEqual(rows,[30,10,20]);
  await assert.rejects(()=>mapLimit([1],0,async()=>1),/parallel/);
});

test('profile secrets are stored mode 0600, validated, and omitted from every summary',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bench-profile-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const apiKey='profile-test-never-print-this';
  saveProfile('local',{baseURL:'http://127.0.0.1:1234/v1',apiKey,model:'qwen-v8',thinking:true,wire_api:'responses'},{root:dir});
  const file=path.join(dir,'local.json');assert.equal(fs.statSync(file).mode&0o777,0o600);
  assert.equal(loadProfile('local',{root:dir}).apiKey,apiKey);
  const summary=JSON.stringify(listProfiles({root:dir}));assert.equal(summary.includes(apiKey),false);
  assert.throws(()=>saveProfile('bad',{baseURL:'http://x/v1',apiKey:'key',model:'gpt-6.1',thinking:false,wire_api:'unsupported'},{root:dir}),/wire_api/);
  removeProfile('local',{root:dir});assert.deepEqual(listProfiles({root:dir}),[]);
});

test('built-in datasets have immutable 270 and 30 case snapshots with expected mode and IR coverage',{skip:!hasBuiltInData},()=>{
  const one=resolveDataset('oneshot270-v1'),agent=resolveDataset('agent30-cadcode-v1');
  assert.equal(one.manifest.cases.length,270);assert.equal(one.manifest.mode,'oneshot');assert.equal(one.mutable,false);
  assert.equal(agent.manifest.cases.length,30);assert.equal(agent.manifest.mode,'agent');assert.equal(agent.mutable,false);
  assert.ok(agent.manifest.cases.every(c=>c.files['target.ir.jsonl']));
  assert.equal(datasetRevisions('oneshot270-v1').length,1);
  assert.equal(validCaseId('bg00002587_fillet_2'),true);assert.equal(validCaseId('../target.step'),false);
  assert.throws(()=>cloneDataset('oneshot270-v1','../unsafe'),/Invalid new dataset/);
  assert.throws(()=>removeCase('oneshot270-v1','bench1'),/read-only/);
});

test('mutable dataset edits preserve old content as a revision',{skip:!hasBuiltInData},t=>{
  const name='test-'+Math.random().toString(36).slice(2,10),root=path.join(MUTABLE_DATASETS,name);
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bench-dataset-edit-')),target=path.join(temp,'part.step'),ir=path.join(temp,'part.ir.jsonl'),prompt=path.join(temp,'prompt.txt');
  fs.writeFileSync(target,'STEP TEST');fs.writeFileSync(ir,'{}\n');fs.writeFileSync(prompt,'exact prompt');
  t.after(()=>{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(temp,{recursive:true,force:true});});
  cloneDataset('agent30-cadcode-v1',name);
  addCase(name,{id:'custom-case',split:'bench',target,ir,promptFile:prompt});
  assert.equal(resolveDataset(name).manifest.cases.length,31);assert.equal(resolveDataset(name).manifest.revision,2);
  fs.writeFileSync(prompt,'revised exact prompt');editCase(name,'custom-case',{promptFile:prompt});
  assert.deepEqual(datasetRevisions(name).map(x=>x.revision),[1,2,3]);
  assert.equal(fs.readFileSync(path.join(root,'.revisions/revision-0002/cases/custom-case/prompt.txt'),'utf8'),'exact prompt');
  assert.equal(removeCase(name,'custom-case').id,'custom-case');assert.equal(resolveDataset(name).manifest.cases.length,30);
});

test('one-shot score summary uses weighted split means and leaves strict IoU separate',()=>{
  const cases=[{id:'b',split:'bench'},{id:'p',split:'proxy'},{id:'r',split:'dev_real'},{id:'s',split:'dev_syn'}];
  const rows=[{id:'b',riou:1,iou:.9,status:'ok',build_ok:true,export_ok:true},
    {id:'p',riou:.5,iou:null,status:'comparison_error',build_ok:true,export_ok:true},
    {id:'r',riou:.8,iou:.7,status:'ok',build_ok:true,export_ok:true},
    {id:'s',riou:.4,iou:0,status:'build_failed',build_ok:false,export_ok:false}];
  const s=summarizeScores(rows,cases);assert.equal(s.weighted_score,.4*1+.3*.5+.15*.8+.15*.4);
  assert.equal(s.scored_count,4);assert.equal(s.build_count,3);assert.equal(s.export_count,3);assert.equal(s.protocol_complete,true);
  assert.equal(s.status_counts.build_failed,1);
  assert.equal(summarizeScores(rows.slice(0,3),cases).weighted_score,null);
  const missing=[...rows.slice(0,3),{...rows[3],riou:null,status:'scorer_error'}];
  const partial=summarizeScores(missing,cases);assert.equal(partial.scored_count,3);assert.equal(partial.attempted_count,4);
  assert.equal(partial.weighted_score,null);assert.equal(partial.protocol_complete,false);
});

test('cleanup commands reject path traversal before touching run or history files',async()=>{
  await assert.rejects(()=>purgeRun('../outside',{yes:true}),/Invalid path component/);
  await assert.rejects(()=>clearTraceFiles('../outside'),/Invalid path component/);
  assert.throws(()=>clearImportedHistory('../outside',{yes:true}),/Invalid imported history id/);
});

test('workspace cleanup rejects malformed session ids before filesystem or CLI access',t=>{
  const root=RUNS,id='test-session-validation-'+Math.random().toString(36).slice(2,8);
  const dir=path.join(root,id);fs.mkdirSync(path.join(dir,'cad-code-workspace'),{recursive:true});
  fs.writeFileSync(path.join(dir,'run.json'),JSON.stringify({mode:'agent',status:'completed',cases:[{session_id:'../outside'}]}));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  assert.throws(()=>workspacePlan([id]),/Invalid CAD Code session id/);
});

test('Agent completion requires a CLI session and a candidate script',()=>{
  assert.equal(classifyAgentResult('completed',null), 'runner_error');
  assert.equal(classifyAgentResult('completed','ses_12345678'), 'missing_candidate');
  assert.equal(classifyAgentResult('completed','ses_12345678','compared'), 'completed');
  assert.equal(classifyAgentResult('completed','ses_12345678','scorer_error'), 'scorer_error');
  assert.equal(classifyAgentResult('time_budget_exhausted','ses_12345678'), 'time_budget_exhausted');
});

test('legacy snapshots retain their real temperature and distinguish agent status from scores',{skip:!hasLegacyHistory},()=>{
  const v7=showHistory('legacy-v7-oneshot270'),v8=showHistory('legacy-v8-oneshot270'),agent=showHistory('legacy-agent30_20261102');
  assert.equal(v7.generation.temperature,0);assert.equal(v8.generation.temperature,0);
  assert.equal(agent.cases.length,30);assert.equal(agent.summary.started,12);
  assert.ok(agent.cases.some(c=>c.score_status==='not_available_in_collection_snapshot'));
  const comparison=compareRuns([v7.run_id,v8.run_id]);assert.equal(comparison.case_overlap,270);
  assert.equal(comparison.protocol_match,true);assert.ok(comparison.delta_weighted_score<0);
});
