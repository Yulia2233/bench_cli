# Assembly benchmark runner

This isolated entry point handles multi-solid project inputs without changing the existing single-solid benchmark commands.

```sh
./assembly/bench_assembly inspect --project PROJECT_DIR
./assembly/bench_assembly run --project PROJECT_DIR --out .runtime/assembly-runs
./assembly/bench_assembly score --project PROJECT_DIR --attempt-dir PROJECT_DIR/assembly/attempt-001 --out .runtime/assembly-score
./assembly/bench_assembly history list
```

`run` asks `cad-code-multi` to report project status and complete one assembly turn, then validates and snapshots `assembly.ir.json`, `assembly-inputs.json`, the selected child notebooks/STEPIR inputs, and `out/product.py`. It never executes the candidate. The run record is marked `staged` with `score_status: not_evaluated`.

`score` validates an existing attempt, writes a separate `assembly-inputs.eval.json` with every delivered Python source path and SHA256, and calls the independent assembly evaluator. It accepts only `assembly-verdict-v1` records bound to the same assembly IR, inputs, and notebook hashes. A missing measurement is a scorer error, not a geometric zero. Override the installed evaluator/interpreter with `--evaluator` and `--python`.

The default evaluator and Python interpreter come from `BENCH_CAD_CODE_DIR` (or the sibling `cad-code/` checkout). `BENCH_ASSEMBLY_EVALUATOR` and `BENCH_ASSEMBLY_PYTHON` can select another installation. The Python path is passed without resolving the virtual-environment symlink.

## Large-assembly context and static defaults

With CAD Code's `codex/multisolid-v63` assembly-context update, `run` keeps using the same `cad-code-multi assemble` command. The controller validates the complete child notebooks, STEPIR v6.3 files, and assembly IR, but the agent starts from `input/assembly-context-index.json` and reads bounded pages under `input/assembly-index/` only as needed. It does not load every part IR into the initial prompt. The index records how many candidate relations were exposed or omitted; omitted candidates remain unresolved engineering hypotheses.

Before the assembly turn, CAD Code generates `out/product.py` with one definition per unique part, all source occurrences at their recorded placements, one grounded reference, and a fixed spanning tree. The agent may replace a fixed edge with a motion relationship only when local geometry and function evidence support it. Every occurrence remains constrained. Static fixed edges for floating or uncertain parts preserve the source pose; they do not establish the original mechanism or design intent. Check the independent verdict and residuals rather than treating a finished conversation as success.

The benchmark snapshot contains the complete assembly IR, selected child notebooks/STEPIR, the input manifest, and `product.py`. For new attempts it also validates and copies the context index and manifest-declared pages, including their hashes, under `source/input/`. Legacy attempts without a context index remain supported. A changed, missing, undeclared, or escaped page is rejected. Keep the original attempt directory with the complete delivered child-source tree, assembly report, and raw session export as well: `score` operates on that original attempt, and the benchmark snapshot is not a standalone replay package. This added assembly contract does not alter single-solid commands, prompts, skill, or trajectory schema.

The project must contain `project.json` and `assembly.ir.json` (at the project root, `preprocess/`, or `assembly/`). All paths in the assembly IR are project-relative; source STEP, unique target STEP, and STEPIR files must exist and match their declared SHA256 values. The assembly IR uses `step-assembly-ir-v1`, with each instance referring to a declared unique part using STEPIR v6.3. An attempt must contain a byte-identical `input/assembly.ir.json`, `input/assembly-inputs.json`, child notebooks and STEPIR at paths relative to `input/`, and `out/product.py`. The notebook/STEPIR hashes must match the attempt manifest and the STEPIR hash in the project IR. Symlinks and path escapes fail validation.

Mocked tests do not create CAD Code conversations or execute candidate code:

```sh
node --test assembly/test/*.test.mjs
```

The 2026-11-12 integration used a deterministic repeated-part fixture, the actual macOS assembly evaluator, and SimpleCADAPI 2.2.7. It returned `ok: true`, `replay_status: completed`, `mate_status: source_placement`, and counts `expected=2`, `actual=2`, `step_solids=2`. It made no model/API calls; it tested the CLI-to-evaluator path with known source code.
