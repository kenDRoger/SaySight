#!/usr/bin/env python3
"""Run the committed verification suites against the running compose stack."""
import subprocess
import sys
from pathlib import Path

SUITES = [
    ("MVP-B spec", "mvpb_verify.py", "spec"),
    ("MVP-C spec", "mvpc_verify.py", "spec"),
    ("MVP-C adversarial", "mvpc_verify.py", "adversarial"),
    ("MVP-D spec", "mvpd_verify.py", "spec"),
    ("MVP-D adversarial", "mvpd_verify.py", "adversarial"),
]
TIMEOUT = 600
HERE = Path(__file__).resolve().parent


def main():
    failed = []
    for name, script, mode in SUITES:
        print(f"\n=== {name}: {script} {mode} ===", flush=True)
        try:
            # Output is inherited so each suite streams straight to the caller.
            result = subprocess.run([sys.executable, str(HERE / script), mode], timeout=TIMEOUT)
            summary = "PASS" if result.returncode == 0 else f"FAIL (exit {result.returncode})"
            if result.returncode != 0:
                failed.append(name)
        except subprocess.TimeoutExpired:
            summary = f"FAIL (timeout after {TIMEOUT}s)"
            failed.append(name)
        print(f"--- {name}: {summary} ---", flush=True)

    if failed:
        print("\nFAILED SUITES: " + "; ".join(failed))
        return 1
    print(f"\nALL {len(SUITES)} SUITES OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
