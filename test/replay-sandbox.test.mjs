import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CAD_CODE,ROOT} from '../src/common.mjs';
import {scoreAgentSource} from '../src/scoring.mjs';

const python=path.join(CAD_CODE,'.runtime/python/bin/python');
const staging=path.resolve(process.env.BENCH_AGENT_STAGING_DIR||path.join(ROOT,'.staging/agent30'));
const target=path.join(staging,'cases/bench1/target.step');
const available=process.platform==='darwin'&&fs.existsSync(python)&&fs.existsSync(target);

test('fresh candidate replay builds without target access and the host scorer then reports against target',
  {skip:!available},async t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'bench-replay-sandbox-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const code=path.join(root,'valid.py');fs.writeFileSync(code,`import simplecadapi as scad
@scad.part(id='part', revision='1.0.0')
def build() -> scad.Part:
    body = scad.make_box_rsolid(width=10.0, height=10.0, depth=10.0)
    return scad.make_part_rpart(part_id='part', body=body)
`);
    const result=await scoreAgentSource({codePath:code,targetPath:target,outDir:path.join(root,'valid-score'),python});
    assert.equal(result.build_ok,true);assert.equal(result.export_ok,true);assert.equal(result.valid_cad,true);
    assert.ok(Number.isFinite(result.riou));

    const denied=path.join(root,'target-read.py');fs.writeFileSync(denied,`import simplecadapi as scad
@scad.part(id='part', revision='1.0.0')
def build() -> scad.Part:
    with open(${JSON.stringify(target)}, 'rb') as source:
        source.read(1)
    body = scad.make_box_rsolid(width=10.0, height=10.0, depth=10.0)
    return scad.make_part_rpart(part_id='part', body=body)
`);
    const rejected=await scoreAgentSource({codePath:denied,targetPath:target,outDir:path.join(root,'denied-score'),python});
    assert.equal(rejected.build_ok,false);assert.match(rejected.exec_error,/PermissionError|Operation not permitted/);
  });
