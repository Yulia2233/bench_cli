#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fileSha,parseFlags,requireValue} from './common.mjs';
import {assemblyInputSummary,loadAssemblyProject,resolveProjectAttempt} from './datasets.mjs';
import {listAssemblyRuns,showAssemblyRun} from './history.mjs';
import {defaultCadCodeMulti,stageAssemblyRun} from './runner.mjs';
import {scoreAssembly,DEFAULT_EVALUATOR,DEFAULT_PYTHON} from './scoring.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const RUNS_ROOT=path.resolve(HERE,'../.runtime/assembly-runs');
const HELP=`bench_assembly - isolated SimpleCADAPI assembly benchmark tooling

Commands:
  bench_assembly inspect --project DIR [--attempt-dir DIR]
  bench_assembly run --project DIR [--out RUNS_DIR] [--cad-code-multi PATH] [--timeout SECONDS]
  bench_assembly score --project DIR --attempt-dir DIR --out DIR [--evaluator PATH] [--python PATH]
  bench_assembly history list [--runs-root DIR]
  bench_assembly history show RUN_ID [--runs-root DIR]

Assembly scoring runs the independent evaluator with a hashed Python source closure.
`;

function output(value){process.stdout.write(JSON.stringify(value,null,2)+'\n');}
function listOptions(flags,allowed){for(const name of Object.keys(flags))if(!allowed.includes(name))throw Error('Unknown option --'+name);}

function inspectProject(projectPath,attemptDir){
  const project=loadAssemblyProject(projectPath);
  const report={status:'valid_inputs',project_id:project.project.project_id||project.project.id||null,project_dir:project.projectDir,
    assembly_ir:path.relative(project.projectDir,project.assemblyIrPath),assembly_ir_sha256:fileSha(project.assemblyIrPath),
    unique_parts:project.assemblyIr.unique_parts.length,instances:project.assemblyIr.instances.length};
  if(attemptDir){
    const attemptPath=resolveProjectAttempt(project.projectDir,attemptDir);
    const summary=assemblyInputSummary(project,attemptPath);
    report.attempt_dir=attemptPath;
    report.assembly_inputs_sha256=summary.assemblyInputsSha256;
    report.candidate_sha256=summary.notebookSha256;
    report.input_files=summary.files;
  }
  return report;
}

async function main(args){
  const {positional,flags}=parseFlags(args),command=positional[0];
  if(!command||command==='help'||flags.help){process.stdout.write(HELP);return;}
  if(command==='inspect'){
    listOptions(flags,['project','attempt-dir']);
    output(inspectProject(requireValue(flags.project,'--project'),flags['attempt-dir']));return;
  }
  if(command==='run'){
    listOptions(flags,['project','out','cad-code-multi','timeout']);
    const timeout=flags.timeout===undefined?1800:Number(flags.timeout);
    if(!Number.isSafeInteger(timeout)||timeout<60||timeout>86400)throw Error('--timeout must be between 60 and 86400 seconds');
    const result=await stageAssemblyRun({projectPath:requireValue(flags.project,'--project'),
      outRoot:flags.out||RUNS_ROOT,cadCodeMulti:flags['cad-code-multi']||defaultCadCodeMulti(),timeoutSeconds:timeout});
    output({run_id:result.run.run_id,status:result.run.status,score_status:result.run.score_status,
      candidate_executed:false,session_id:result.run.session_id||null,attempt_dir:result.run.attempt_dir,
      run_dir:result.runDir,error:result.run.error||null});
    if(result.run.status==='runner_error')process.exitCode=1;
    return;
  }
  if(command==='score'){
    listOptions(flags,['project','attempt-dir','out','evaluator','python','timeout']);
    const result=await scoreAssembly({projectPath:requireValue(flags.project,'--project'),attemptDir:requireValue(flags['attempt-dir'],'--attempt-dir'),
      outDir:requireValue(flags.out,'--out'),evaluator:flags.evaluator||DEFAULT_EVALUATOR,python:flags.python||DEFAULT_PYTHON,
      timeoutSeconds:flags.timeout===undefined?600:Number(flags.timeout)});
    output(result);return;
  }
  if(command==='history'){
    const action=positional[1],root=path.resolve(flags['runs-root']||RUNS_ROOT);
    if(action==='list'){listOptions(flags,['runs-root']);output(listAssemblyRuns(root));return;}
    if(action==='show'){
      listOptions(flags,['runs-root']);output(showAssemblyRun(requireValue(positional[2],'Run ID'),root));return;
    }
    throw Error('Use history list|show');
  }
  throw Error('Unknown command: '+command+'\n'+HELP);
}

main(process.argv.slice(2)).catch(error=>{console.error(error?.stack||String(error));process.exitCode=1;});
