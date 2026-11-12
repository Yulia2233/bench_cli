#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$ROOT/.staging"
mkdir -p "$STAGE/agent30" "$STAGE/legacy/v7" "$STAGE/legacy/v8"

scp aliyun:/train/outputs/qwen35-27b-v8-oneshot270_20261105/eval/prompts_all.jsonl "$STAGE/prompts_all.jsonl"
scp -r aliyun:/train/outputs/agent-evaluation-trajectories/collections/agent30_20261102/cases "$STAGE/agent30/"
scp aliyun:/train/outputs/agent-evaluation-trajectories/collections/agent30_20261102/manifest.json \
  aliyun:/train/outputs/agent-evaluation-trajectories/collections/agent30_20261102/README.md "$STAGE/agent30/"
scp -r aliyun:/train/outputs/eval_qwen35-27b-v7-oneshot270_20261101/config \
  aliyun:/train/outputs/eval_qwen35-27b-v7-oneshot270_20261101/eval "$STAGE/legacy/v7/"
scp -r aliyun:/train/outputs/qwen35-27b-v8-oneshot270_20261105/config \
  aliyun:/train/outputs/qwen35-27b-v8-oneshot270_20261105/eval "$STAGE/legacy/v8/"
scp aliyun:/train/outputs/qwen35-27b-v8-oneshot270_20261105/RESULT.json \
  aliyun:/train/outputs/qwen35-27b-v8-oneshot270_20261105/RESULT.md \
  aliyun:/train/outputs/qwen35-27b-v8-oneshot270_20261105/REPORT.zh.md "$STAGE/legacy/v8/"

echo "Legacy files staged under $STAGE; the importer copies only benchmark cases and score records."
