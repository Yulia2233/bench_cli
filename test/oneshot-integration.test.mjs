import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {profileFile,saveProfile,removeProfile} from '../src/profiles.mjs';
import {DATASETS} from '../src/common.mjs';
import {runOneShot} from '../src/oneshot.mjs';

const hasOneShotDataset=fs.existsSync(path.join(DATASETS,'oneshot270-v1','manifest.json'));

test('one-shot calls cad-code ask with one exact user message at temperature 1',{skip:!hasOneShotDataset},async t=>{
  const secret='bench-cli-e2e-key',requests=[];
  const code=['import simplecadapi as scad',
    '@scad.part(id="part", revision="1.0.0")',
    'def build() -> scad.Part:',
    '    body = scad.make_box_rsolid(width=10.0, height=10.0, depth=10.0)',
    '    return scad.make_part_rpart(part_id="part", body=body)'].join('\n');
  const fence=String.fromCharCode(96).repeat(3);
  const answer=fence+'python\n'+code+'\n'+fence;
  const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;
    requests.push({path:req.url,authorization:req.headers.authorization,body:JSON.parse(raw)});
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({id:'resp-test',status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:answer}]}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const name='e2e-'+Math.random().toString(36).slice(2,9),runDirs=[];
  t.after(async()=>{removeProfile(name);for(const d of runDirs)fs.rmSync(d,{recursive:true,force:true});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const apiKey=secret;saveProfile(name,{baseURL:'http://127.0.0.1:'+server.address().port+'/v1',apiKey,model:'qwen-v8',thinking:true,wire_api:'responses'});
  const {resolveDataset}=await import('../src/datasets.mjs');const ds=resolveDataset('oneshot270-v1');
  const expected=fs.readFileSync(path.join(ds.dir,'cases','bench1','prompt.txt'),'utf8');
  const result=await runOneShot({datasetName:'oneshot270-v1',profileName:name,parallel:1,limit:1,caseIds:['bench1'],maxTokens:256});runDirs.push(result.runDir);
  assert.equal(result.run.status,'completed');assert.equal(requests.length,1);assert.equal(requests[0].body.temperature,1);
  assert.deepEqual(requests[0].body.input,[{role:'user',content:[{type:'input_text',text:expected}]}]);
  assert.equal(requests[0].authorization,'Bearer '+secret);assert.equal(requests[0].body.store,false);
  assert.equal(result.run.summary.scored_count,1);assert.equal(result.run.summary.weighted_score,null);assert.equal(result.run.summary.protocol_complete,false);
  assert.equal(JSON.stringify(result.run).includes(secret),false);
});
