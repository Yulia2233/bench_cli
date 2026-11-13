# bench_cli

`bench_cli` runs STEP reconstruction benchmarks through CAD Code and independently scores the resulting Python/CAD artifact. It supports single-part `oneshot` and `agent` runs plus a separate multi-solid assembly runner. Assembly input validation and scoring do not change the existing single-part benchmark commands.

## Requirements

- Node.js 22 or newer.
- A CAD Code checkout and its configured Python/SimpleCADAPI runtime for scoring and agent runs.
- A data directory containing authorized dataset manifests/cases. Benchmark STEP files, prompts, profiles, run logs, and credentials are not included in this public repository.
- macOS `sandbox-exec` for the original single-solid candidate replay. Assembly replay uses the evaluator supplied by cad-code; Linux requires bubblewrap isolation there.

Install the CLI and tests:

```bash
git clone https://github.com/Yulia2233/bench_cli.git
cd bench_cli
npm install
```

Set integration paths if the checkouts are not siblings. `BENCH_REPO_ROOT` should point to the workspace containing `benchmark/eval_sets/`; `BENCH_DATA_DIR` points to the private dataset snapshot; `BENCH_CAD_CODE_DIR` points to cad-code.

```bash
export BENCH_REPO_ROOT=/path/to/step-8B-sft
export BENCH_CAD_CODE_DIR=/path/to/cad-code
export BENCH_DATA_DIR=/path/to/private/bench-data
```

Defaults are the parent directory of this checkout, its sibling `cad-code/`, and this checkout's ignored `data/` directory. Keep benchmark data out of Git. Before using it, verify dataset provenance and make sure evaluation-only targets do not enter training collections.

## CLI

```bash
./bench_cli --help
./bench_cli profile set lab --base-url https://provider.example/v1 --model model-id
secret-manager-command | ./bench_cli profile set lab \
  --base-url https://provider.example/v1 --model model-id --api-key-stdin
./bench_cli profile test lab
./bench_cli dataset list
./bench_cli run oneshot --dataset oneshot270-v1 --profile lab --parallel 1
./bench_cli run agent --dataset agent30-cadcode-v3 --profile lab --parallel 1
./bench_cli history list
```

`oneshot` sends one exact user prompt without tools or conversation history. `agent` drives CAD Code's real CLI, records the CLI transcript, then replays the candidate in a target-denied sandbox before scoring. A completed model turn is not a passing score. Run output and profiles are stored in `.runtime/` with private permissions; API keys are not recorded in manifests or logs.

Built-in datasets are immutable. Clone one before editing:

```bash
./bench_cli dataset clone oneshot270-v1 oneshot270-local
./bench_cli dataset add oneshot270-local --id extra-001 \
  --target /path/part.step --prompt-file /path/prompt.txt --split proxy
./bench_cli dataset revisions oneshot270-local
```

## Multi-solid assembly benchmark

The assembly benchmark validates the project and selected child inputs, stages the assembly turn through `cad-code-multi`, and scores it separately. `run` does not execute candidate code; `score` invokes the independent evaluator.

```bash
./assembly/bench_assembly inspect --project PROJECT_DIR
./assembly/bench_assembly run --project PROJECT_DIR \
  --out .runtime/assembly-runs
./assembly/bench_assembly score --project PROJECT_DIR \
  --attempt-dir PROJECT_DIR/assembly/attempt-001 \
  --out .runtime/assembly-score
./assembly/bench_assembly history list
```

The project must contain a valid `project.json`, `assembly.ir.json`, selected part notebooks and STEPIR v6.3 files, plus an assembly attempt when scoring. Paths, hashes, schemas, and symlinks are checked. Verdicts distinguish occurrence coverage, component geometry, constraints, and source-placement fallback.

Defaults locate `cad-code/cad-code-multi`, `cad-code/multi/assemblyeval.py`, and the cad-code Python environment under the configured `BENCH_CAD_CODE_DIR`. Override them with `--cad-code-multi`, `--evaluator`, `--python`, `BENCH_ASSEMBLY_EVALUATOR`, or `BENCH_ASSEMBLY_PYTHON` when needed.

The updated CAD Code assembly controller supplies a bounded context index and pages, then generates a complete source-pose assembly with one grounded reference and a fixed spanning tree. The agent inspects selected candidate relationships and replaces fixed edges only with evidence-supported motion constraints. Use the [assembly guide](assembly/README.md#large-assembly-context-and-static-defaults) for context and archive requirements; the original attempt directory remains necessary for scoring and complete context analysis. Single-solid behavior is unchanged.

## Tests

```bash
npm test
```

Tests that require built-in benchmark cases or a cad-code runtime are skipped when those private external fixtures are not configured. Deterministic unit and assembly tests run without API calls. To include the optional integration tests, set `BENCH_DATA_DIR`, `BENCH_CAD_CODE_DIR`, and, for replay fixtures, `BENCH_AGENT_STAGING_DIR` to authorized local data.

Dataset contents and evaluation policy remain the responsibility of the workspace that supplies the data. Never commit API credentials, `.runtime/`, `.staging/`, benchmark STEP files, or generated trajectories to this repository.
