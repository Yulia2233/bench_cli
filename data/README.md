# External benchmark data

This directory is intentionally not populated in Git. Dataset snapshots contain benchmark STEP targets and evaluation prompts and must be obtained from an authorized, access-controlled source.

Set `BENCH_DATA_DIR` to the private data root containing `datasets/` and optional `history/legacy/`. Do not commit target STEP files, evaluation-only data, generated trajectories, API profiles, or runtime logs here.

Some repository scripts also need source material under `BENCH_REPO_ROOT` (for example `benchmark/eval_sets/` and staged historical runs). Those source paths are workspace-specific and are not distributed with this CLI repository.
