import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {saveProfile,removeProfile} from '../src/profiles.mjs';
import {DATASETS} from '../src/common.mjs';
import {resolveDataset,casePath} from '../src/datasets.mjs';
import {runAgent} from '../src/agent.mjs';

const hasAgentDataset=fs.existsSync(path.join(DATASETS,'agent30-cadcode-v1','manifest.json'));

test('agent runner uses the CAD Code CLI for web, files, task, and complete transcripts',{skip:!hasAgentDataset},async t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bench-agent-cli-'));
  const profile='mock-'+Math.random().toString(36).slice(2,9),capture=path.join(temp,'cli-call.json'),webCapture=path.join(temp,'web-call.json');
  const cliPath=path.join(temp,'cad-code');let runDir=null;
  const oldCapture=process.env.MOCK_CAPTURE,oldWebCapture=process.env.MOCK_WEB_CAPTURE;
  const source=[
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import http from 'node:http';",
    'const args=process.argv.slice(2);',
    "if(args.includes('--web')){",
    '  fs.writeFileSync(process.env.MOCK_WEB_CAPTURE,JSON.stringify(args));',
    "  const server=http.createServer((req,res)=>res.end('mock'));",
    "  server.listen(Number(process.env.PORT),'127.0.0.1');",
    "  const stop=()=>server.close(()=>process.exit(0));",
    "  process.on('SIGTERM',stop);process.on('SIGINT',stop);",
    '}else{',
    "  const session='ses_mock_session_12345678';",
    '  const files=[];for(let i=0;i<args.length;i++)if(args[i]==="--file")files.push(args[++i]);',
    '  const input=path.join(process.env.CAD_CODE_WORKSPACE,session,"input");fs.mkdirSync(input,{recursive:true});',
    '  for(const file of files)fs.copyFileSync(file,path.join(input,path.basename(file)));',
    '  fs.writeFileSync(process.env.MOCK_CAPTURE,JSON.stringify({args,wire:process.env.CAD_CODE_WIRE_API}));',
    '  process.stdout.write("workspace/"+session+":\\n");',
    '}'
  ].join('\n')+'\n';
  fs.writeFileSync(cliPath,source,{mode:0o755});fs.chmodSync(cliPath,0o755);
  saveProfile(profile,{baseURL:'http://127.0.0.1:9999/v1',apiKey:'mock-key-for-test',model:'mock-model',thinking:true,wire_api:'chat'});
  t.after(()=>{removeProfile(profile);if(oldCapture===undefined)delete process.env.MOCK_CAPTURE;else process.env.MOCK_CAPTURE=oldCapture;
    if(oldWebCapture===undefined)delete process.env.MOCK_WEB_CAPTURE;else process.env.MOCK_WEB_CAPTURE=oldWebCapture;
    fs.rmSync(temp,{recursive:true,force:true});if(runDir)fs.rmSync(runDir,{recursive:true,force:true});});

  const dataset=resolveDataset('agent30-cadcode-v1'),caseId='h0001_00010222';
  const expectedPrompt=fs.readFileSync(casePath(dataset,dataset.manifest.cases.find(c=>c.id===caseId),'prompt.txt'),'utf8');
  process.env.MOCK_CAPTURE=capture;process.env.MOCK_WEB_CAPTURE=webCapture;
  const result=await runAgent({datasetName:'agent30-cadcode-v1',profileName:profile,caseIds:[caseId],timeout:60,
    openWeb:false,cliPath});
  runDir=result.runDir;
  const invoked=JSON.parse(fs.readFileSync(capture,'utf8'));
  assert.ok(JSON.parse(fs.readFileSync(webCapture,'utf8')).includes('--web'));
  assert.equal(invoked.wire,'chat');
  assert.ok(!invoked.args.includes('--web'));
  assert.equal(invoked.args.filter(x=>x==='--file').length,2);
  assert.equal(invoked.args.at(-2),'run');assert.equal(invoked.args.at(-1),expectedPrompt);
  assert.equal(result.run.cases[0].status,'missing_candidate');
  assert.equal(result.run.summary.status_counts.missing_candidate,1);
  const caseRun=path.join(runDir,'cases',caseId);
  const trace=JSON.parse(fs.readFileSync(path.join(caseRun,'trace.json'),'utf8'));
  const stdout=fs.readFileSync(path.join(caseRun,trace.stdout_log),'utf8');
  assert.match(stdout,/ses_mock_session_12345678/);
  assert.equal(trace.stdout_bytes,Buffer.byteLength(stdout));
  assert.equal(trace.stdout_sha256,createHash('sha256').update(stdout).digest('hex'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(caseRun,'input.json'),'utf8')).user_input,expectedPrompt);
});
