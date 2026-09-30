"""Build the frontend from the committed npm lock during Python installation."""
import os
from pathlib import Path
import subprocess
import sys


def build_extension(target_name, version):
    root = Path(__file__).resolve().parent
    env = {**os.environ, "KERNEL_BRIDGE_PYTHON": sys.executable}
    subprocess.run(["npm", "ci", "--no-audit", "--no-fund"], cwd=root, env=env, check=True)
    subprocess.run(["npm", "run", "build:extension"], cwd=root, env=env, check=True)
