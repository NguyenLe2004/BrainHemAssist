"""Regenerate SHA256SUMS for files allowed in the public source snapshot."""
import argparse
import hashlib
import os
from pathlib import Path
import runpy
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify all public files without writing")
    args = parser.parse_args()
    # Do not create bytecode in the source tree while checking publication policy.
    sys.dont_write_bytecode = True
    policy = runpy.run_path(str(ROOT / "scripts/check_public_tree.py"))
    if policy["check"]() != 0:
        raise SystemExit("Refusing to hash a tree that fails publication policy")
    files = []
    for base, directories, names in os.walk(ROOT, followlinks=False):
        directories[:] = sorted(
            name for name in directories
            if name not in policy["LOCAL_BUILD"] and not name.startswith(".venv")
        )
        for name in names:
            path = Path(base) / name
            if path == ROOT / "SHA256SUMS":
                continue
            relative = path.relative_to(ROOT).as_posix()
            if "\n" in relative or "\r" in relative or "\\" in relative:
                raise SystemExit("Unsupported filename in checksum manifest")
            files.append((relative, path))
    lines = []
    for relative, path in sorted(files):
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        lines.append(f"{digest.hexdigest()}  {relative}\n")
    manifest = ROOT / "SHA256SUMS"
    content = "".join(lines)
    if args.check:
        if not manifest.is_file() or manifest.read_text(encoding="utf-8") != content:
            raise SystemExit("SHA256SUMS is missing or stale; run python3 scripts/generate_checksums.py")
        print(f"SHA256SUMS verified for all {len(lines)} public files")
        return
    manifest.write_text(content, encoding="utf-8")
    print(f"SHA256SUMS written for {len(lines)} public files")


if __name__ == "__main__":
    main()
