import fs from 'node:fs';
import path from 'node:path';
import {fileSha,readJson} from './common.mjs';

const IR_CANDIDATES=['assembly.ir.json','preprocess/assembly.ir.json','assembly/assembly.ir.json'];
const NOTEBOOK_KEYS=['notebook','notebook_path','source_notebook'];
const IR_KEYS=['stepir','stepir_path','ir','ir_path'];

function inside(root,file){
  const resolved=path.resolve(file),base=path.resolve(root);
  return resolved===base||resolved.startsWith(base+path.sep);
}

function noSymlinkPath(root,file,label){
  const base=path.resolve(root),resolved=path.resolve(file);
  if(!inside(base,resolved))throw Error(`${label} escapes its root`);
  let cursor=base;
  for(const part of path.relative(base,resolved).split(path.sep).filter(Boolean)){
    cursor=path.join(cursor,part);
    if(fs.existsSync(cursor)&&fs.lstatSync(cursor).isSymbolicLink())throw Error(`${label} must not use a symlink`);
  }
}

function regularFile(root,relative,label){
  if(typeof relative!=='string'||!relative.trim()||path.isAbsolute(relative))throw Error(`${label} must be a relative path`);
  const file=path.resolve(root,relative);
  if(!inside(root,file))throw Error(`${label} escapes the input snapshot`);
  noSymlinkPath(root,file,label);
  if(!fs.existsSync(file)||!fs.statSync(file).isFile())throw Error(`${label} is missing: ${relative}`);
  return file;
}

function nonEmptyId(value,label){
  if(typeof value!=='string'||!value.trim()||value.includes('/')||value.includes('\\'))throw Error(`${label} is invalid`);
  return value;
}

export function loadAssemblyProject(projectPath){
  const projectDir=fs.realpathSync(projectPath);
  if(!fs.statSync(projectDir).isDirectory())throw Error('Project path must be a directory');
  const projectFile=path.join(projectDir,'project.json');
  noSymlinkPath(projectDir,projectFile,'project.json');
  if(!fs.existsSync(projectFile))throw Error('Project is missing project.json');
  const project=readJson(projectFile);
  let assemblyIrPath=null;
  const configured=typeof project.assembly_ir==='object'?project.assembly_ir?.path:project.assembly_ir||project.assembly_ir_path||project.files?.assembly_ir;
  if(configured!==undefined&&(typeof configured!=='string'||path.isAbsolute(configured)))
    throw Error('Project assembly IR path must be project-relative');
  if(configured){
    assemblyIrPath=regularFile(projectDir,configured,'assembly IR');
  }else{
    for(const candidate of IR_CANDIDATES){
      const resolved=path.resolve(projectDir,candidate);
      if(fs.existsSync(resolved)){
        assemblyIrPath=regularFile(projectDir,candidate,'assembly IR');break;
      }
    }
  }
  if(!assemblyIrPath)throw Error('Project is missing assembly.ir.json');
  if(project.assembly_ir?.sha256&&project.assembly_ir.sha256!==fileSha(assemblyIrPath))throw Error('Project assembly IR hash mismatch');
  const assemblyIr=readJson(assemblyIrPath);
  if(assemblyIr.schema_version!=='step-assembly-ir-v1')
    throw Error(`Unsupported assembly IR schema: ${assemblyIr.schema_version}`);
  if(!Array.isArray(assemblyIr.unique_parts)||!Array.isArray(assemblyIr.instances))
    throw Error('Assembly IR must contain unique_parts and instances arrays');
  const sourceStep=assemblyIr.source?.step_path;
  if(typeof sourceStep!=='string'||path.isAbsolute(sourceStep))throw Error('Assembly IR source.step_path must be project-relative');
  const sourceStepPath=regularFile(projectDir,sourceStep,'source STEP');
  if(typeof assemblyIr.source.sha256!=='string'||assemblyIr.source.sha256!==fileSha(sourceStepPath))
    throw Error('Assembly IR source STEP hash mismatch');
  const parts=new Map();
  for(const part of assemblyIr.unique_parts){
    const id=nonEmptyId(part?.id,'unique part id');
    if(parts.has(id))throw Error(`Duplicate unique part id: ${id}`);
    if(part.stepir_version!=='v6.3')throw Error(`Part ${id} does not use STEPIR v6.3`);
    const targetStep=regularFile(projectDir,part.target_step,`Target STEP for ${id}`);
    const stepir=regularFile(projectDir,part.stepir,`STEPIR for ${id}`);
    const targetHash=part.target_sha256||part.target_step_sha256;
    if(typeof targetHash!=='string'||targetHash!==fileSha(targetStep))throw Error(`Target STEP hash mismatch for ${id}`);
    if(typeof part.stepir_sha256!=='string'||part.stepir_sha256!==fileSha(stepir))throw Error(`STEPIR hash mismatch for ${id}`);
    parts.set(id,part);
  }
  const instances=new Set();
  for(const instance of assemblyIr.instances){
    const id=nonEmptyId(instance?.id,'instance id');
    if(instances.has(id))throw Error(`Duplicate instance id: ${id}`);
    instances.add(id);
    if(!parts.has(instance.part_id))throw Error(`Instance ${id} refers to unknown part ${instance.part_id}`);
    if(!instance.placement||typeof instance.placement!=='object')throw Error(`Instance ${id} has no placement`);
  }
  if(parts.size===0||instances.size===0)throw Error('Assembly IR must contain at least one part and one instance');
  return {projectDir,project,projectFile,assemblyIrPath,assemblyIr,parts,instances};
}

export function resolveProjectAttempt(projectDir,attemptPath){
  if(typeof attemptPath!=='string'||!attemptPath.trim())throw Error('attempt_dir is required');
  const base=fs.realpathSync(projectDir);
  const candidate=path.isAbsolute(attemptPath)?path.resolve(attemptPath):path.resolve(base,attemptPath);
  let parent=path.dirname(candidate);
  while(!fs.existsSync(parent)&&parent!==path.dirname(parent))parent=path.dirname(parent);
  const realParent=fs.realpathSync(parent);
  if(!inside(base,realParent))throw Error('attempt_dir is outside the project directory');
  let resolved;
  try{resolved=fs.realpathSync(candidate);}catch{throw Error(`attempt_dir is missing: ${attemptPath}`);}
  if(!inside(base,resolved))throw Error('attempt_dir is outside the project directory');
  let cursor=path.parse(candidate).root,reachedProject=false;
  for(const part of path.relative(path.parse(candidate).root,candidate).split(path.sep).filter(Boolean)){
    cursor=path.join(cursor,part);
    if(!fs.existsSync(cursor))continue;
    if(!reachedProject){
      if(fs.realpathSync(cursor)===base)reachedProject=true;
    }else if(fs.lstatSync(cursor).isSymbolicLink())throw Error('attempt_dir must not use a symlink');
  }
  if(!reachedProject)throw Error('attempt_dir is outside the project directory');
  noSymlinkPath(base,resolved,'attempt_dir');
  if(!fs.statSync(resolved).isDirectory())throw Error(`attempt_dir is not a directory: ${attemptPath}`);
  return resolved;
}

export function validateAssemblyInputs({inputsPath,assemblyIr,attemptDir}){
  const inputs=readJson(inputsPath);
  if(inputs.schema_version!=='cad-code-assembly-inputs-v1')throw Error(`Unsupported assembly inputs schema: ${inputs.schema_version}`);
  if(!Array.isArray(inputs.parts))throw Error('assembly-inputs.json must contain parts[]');
  const expected=new Set(assemblyIr.unique_parts.map(part=>part.id));
  const seen=new Set(),files=[];
  for(const part of inputs.parts){
    const id=nonEmptyId(part?.part_id||part?.id,'assembly input part_id');
    if(seen.has(id))throw Error(`Duplicate assembly input part: ${id}`);
    seen.add(id);
    if(!expected.has(id))throw Error(`assembly-inputs.json contains unknown part ${id}`);
    const notebookKey=NOTEBOOK_KEYS.find(key=>typeof part[key]==='string');
    if(!notebookKey)throw Error(`Assembly input ${id} has no notebook path`);
    const inputRoot=path.join(attemptDir,'input');
    const notebook=regularFile(inputRoot,part[notebookKey],`Notebook for ${id}`);
    const notebookHash=fileSha(notebook);
    const expectedNotebookHash=part.notebook_sha256||part.source_notebook_sha256;
    if(typeof expectedNotebookHash!=='string'||expectedNotebookHash!==notebookHash)throw Error(`Notebook hash mismatch for ${id}`);
    files.push({part_id:id,kind:'notebook',path:path.relative(attemptDir,notebook),sha256:notebookHash});
    const irKey=IR_KEYS.find(key=>typeof part[key]==='string');
    if(!irKey)throw Error(`Assembly input ${id} has no STEPIR path`);
    const ir=regularFile(inputRoot,part[irKey],`STEPIR for ${id}`);
    const irHash=fileSha(ir),expectedIr=assemblyIr.unique_parts.find(item=>item.id===id)?.stepir_sha256;
    if(typeof part.stepir_sha256!=='string'||part.stepir_sha256!==irHash||irHash!==expectedIr)
      throw Error(`STEPIR hash mismatch for ${id}`);
    files.push({part_id:id,kind:'stepir',path:path.relative(attemptDir,ir),sha256:irHash});
    if(part.stepeval_verdict!==null&&(!part.stepeval_verdict||typeof part.stepeval_verdict!=='object'||Array.isArray(part.stepeval_verdict)))
      throw Error(`Invalid stepeval verdict for ${id}`);
  }
  for(const id of expected)if(!seen.has(id))throw Error(`Assembly input is missing unique part ${id}`);
  return {inputs,files,sha256:fileSha(inputsPath)};
}

export function assemblyInputSummary(projectInfo,attemptDir){
  const inputDir=path.join(attemptDir,'input');
  const inputsPath=path.join(inputDir,'assembly-inputs.json');
  const irPath=path.join(inputDir,'assembly.ir.json');
  const notebookPath=path.join(attemptDir,'out','product.py');
  for(const [file,label] of [[inputsPath,'assembly-inputs.json'],[irPath,'attempt assembly.ir.json'],[notebookPath,'out/product.py']]){
    noSymlinkPath(attemptDir,file,label);
    if(!fs.existsSync(file)||!fs.statSync(file).isFile())throw Error(`Assembly attempt is missing ${label}`);
  }
  const sourceIrHash=fileSha(projectInfo.assemblyIrPath),attemptIrHash=fileSha(irPath);
  if(sourceIrHash!==attemptIrHash)throw Error('Attempt assembly.ir.json does not match the project assembly IR');
  const checked=validateAssemblyInputs({inputsPath,assemblyIr:projectInfo.assemblyIr,attemptDir});
  const source=fs.readFileSync(notebookPath,'utf8');
  if(!/^# \[tool\.simplecadapi\]\s*$/m.test(source))throw Error('out/product.py is not a SimpleCADAPI notebook');
  return {inputsPath,irPath,notebookPath,assemblyIrSha256:attemptIrHash,assemblyInputsSha256:checked.sha256,
    notebookSha256:fileSha(notebookPath),files:checked.files,inputs:checked.inputs};
}
