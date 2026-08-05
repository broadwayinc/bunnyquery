#!/usr/bin/env python3
"""Patch the built bunnyquery.js so BQ_VERSION matches package.json.

The widget build normally injects the version itself (tsup.config.ts `define:
__BQ_VERSION__` reads package.json), so a fresh `npm run build` needs no help.
This exists for the other order: the version was bumped AFTER the last build and
the built file should be patched without rebuilding.

Usage: python3 scripts/sync_version.py
Paths are resolved from the script's location, so it works from any cwd.
Exit 0 on success or already-in-sync, 1 when the assignment cannot be found
(or matches more than once, which would mean blind edits).
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGE_JSON = ROOT / "package.json"
BUNDLE = ROOT / "bunnyquery.js"

# The assignment as the build emits it: `var BQ_VERSION = "1.8.3" ;` (the
# spacing is define-substitution debris, so match loosely). [^;\n]+ also covers
# a bundle built without the define (`typeof __BQ_VERSION__ ... : "dev";`).
ASSIGNMENT = re.compile(r'(var\s+BQ_VERSION\s*=\s*)[^;\n]+?(\s*;)')


def main() -> int:
    version = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))["version"]
    source = BUNDLE.read_text(encoding="utf-8")

    matches = ASSIGNMENT.findall(source)
    if len(matches) != 1:
        print(
            f"error: expected exactly one BQ_VERSION assignment in {BUNDLE.name}, "
            f"found {len(matches)}",
            file=sys.stderr,
        )
        return 1

    patched, count = ASSIGNMENT.subn(rf'\g<1>"{version}"\g<2>', source, count=1)
    if patched == source:
        print(f"{BUNDLE.name}: BQ_VERSION already {version}")
        return 0

    old = ASSIGNMENT.search(source).group(0)
    BUNDLE.write_text(patched, encoding="utf-8")
    print(f"{BUNDLE.name}: {old.strip()}  ->  BQ_VERSION = \"{version}\"")
    return 0


if __name__ == "__main__":
    sys.exit(main())
