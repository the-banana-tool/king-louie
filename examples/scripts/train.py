r"""Stand-in for the owner's training script (King Louie fleet example).

train.run starts it as

    C:\KingLouie\tools\py\Scripts\python.exe D:\train\train.py
        --config D:\train\configs\<name>.json --epochs N
        --precision fp32|fp16|bf16 --resume=true|false

Rules a real script keeps while train.run is a routine runbook:

* read the config only from the absolute path it is given (an admin-owned file);
* write only under the absolute D:\train\runs\<config name>\ ;
* never depend on the current directory;
* never load pickled weights or trust_remote_code models from D:\models or any
  other folder the runner can write. A script that does must be run by an
  unsafe runbook instead.

This stand-in uses the standard library only and loads no weights.
"""

import argparse
import json
import pathlib
import re
import sys
import time

RUNS_ROOT = pathlib.Path(r"D:\train\runs")
FOLDER_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


def main(argv):
    parser = argparse.ArgumentParser(description="King Louie example training stand-in.")
    parser.add_argument("--config", required=True)
    parser.add_argument("--epochs", type=int, required=True)
    parser.add_argument("--precision", choices=["fp32", "fp16", "bf16"], required=True)
    parser.add_argument("--resume", choices=["true", "false"], required=True)
    args = parser.parse_args(argv)

    config_path = pathlib.Path(args.config)
    if not config_path.is_absolute():
        parser.error("--config must be an absolute path")
    name = config_path.stem
    if not FOLDER_NAME.match(name):
        parser.error("--config must name a file whose name is a plain folder name")
    with config_path.open("r", encoding="utf-8") as handle:
        config = json.load(handle)

    run_dir = RUNS_ROOT / name
    run_dir.mkdir(parents=True, exist_ok=True)
    for epoch in range(1, args.epochs + 1):
        print(f"epoch {epoch}/{args.epochs} ({args.precision}): nothing to train in the example")
    summary = {
        "config": str(config_path),
        "config_keys": sorted(config) if isinstance(config, dict) else [],
        "epochs": args.epochs,
        "precision": args.precision,
        "resume": args.resume == "true",
        "finished_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    out = run_dir / "summary.json"
    out.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
