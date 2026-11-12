#!/usr/bin/env python3
"""Replay a SimpleCAD notebook in a fresh process and export its product as STEP (no target is read).

  python -I replay_notebook.py --notebook model.py --out DIR

Writes DIR/execution.json with the keys bench_cli's scorer reads (the same as cadeval.py `_exec`):
import_succeeded, build_succeeded, capture_succeeded, export_succeeded, error_type, error, seconds;
and on success DIR/product.scadpkg and DIR/rebuilt.step.
"""
import argparse
import json
import time
import traceback
from pathlib import Path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--notebook", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    rep = {"kind": "notebook", "import_succeeded": False, "build_succeeded": False,
           "capture_succeeded": False, "export_succeeded": False}
    started = time.monotonic()
    try:
        import simplecadapi as scad
        from simplecadapi import exporter
        from simplecadapi.runtime import run_notebook
        rep["import_succeeded"] = True
        run = run_notebook(a.notebook, cache=False)
        if not isinstance(run.product, scad.Part):
            raise TypeError(f"the notebook's product is {type(run.product).__name__}, expected scad.Part")
        rep["build_succeeded"] = True
        scad.capture(run.definition, str(out / "product.scadpkg"))
        rep["capture_succeeded"] = True
        exporter.export_product_package_to_step(str(out / "product.scadpkg"), str(out / "rebuilt.step"))
        rep["export_succeeded"] = True
    except BaseException as e:  # noqa: BLE001 - reported to the scorer
        rep["error_type"] = type(e).__name__
        rep["error"] = str(e)[:2000]
        rep["traceback"] = traceback.format_exc()[-3000:]
    rep["seconds"] = round(time.monotonic() - started, 3)
    (out / "execution.json").write_text(json.dumps(rep, indent=2))


if __name__ == "__main__":
    main()
