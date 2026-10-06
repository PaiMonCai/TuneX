#!/usr/bin/env python3
"""Current Integration entrypoint backed by a provenance-preserving historical Gate."""
from pathlib import Path
import runpy

ROOT = Path(__file__).resolve().parents[2]
runpy.run_path(str(ROOT / "scripts" / "v3-e2e" / "bootstrap-federation.py"), run_name="__main__")
