"""Reject private material before staging or packaging this source snapshot."""
import argparse
import hashlib
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
LOCAL_BUILD = {".git", "node_modules", "dist", "__pycache__", ".pytest_cache"}
PRIVATE_DIRS = {"data", "datasets", "demo", "artifacts", "task-evidence", "backups",
                "third_party", "training", "private-build", "releases", "secrets",
                "operator-secrets", ".codex", ".claude", "evidence", "models"}
PRIVATE_SUFFIXES = (".md", ".nii", ".nii.gz", ".dcm", ".dicom", ".npy", ".npz",
                    ".sqlite", ".sqlite3", ".db", ".pt", ".pth", ".ckpt",
                    ".safetensors", ".onnx", ".engine", ".plan", ".bhm", ".whl",
                    ".pem", ".key", ".p12", ".pfx", ".log", ".pid", ".jsonl",
                    ".csv", ".zip", ".tar", ".tar.gz", ".pyc")
PUBLIC_BINARY = {
    "models/baseline_s.onnx": "92bc39b59ba8edd9f59241baa0b6ebe707690d92257cccc32c5933dbdc282ee5",
    "models/baseline_s.int8.onnx": "e4e81c678bfdd920a7070ffbdca20eb01dc77da2a16478b7012b47819c4f8845",
    "docs/images/clinical-workspace.png": "843cff8fa937c11d519c78114d1cd51386b391ffd832d9f96febb19ba2b7b86f",
}
PUBLIC_DOCS = {"README.md", "models/README.md", "docs/SETUP.md"}

TEXT_SUFFIXES = {".py", ".js", ".jsx", ".mjs", ".css", ".html", ".json", ".txt",
                 ".rst", ".toml", ".ini", ".yaml", ".yml", ".pbtxt", ".Dockerfile"}
SPECIAL_NAMES = {"LICENSE", "NOTICE", ".gitignore", ".dockerignore",
                 ".env.example", "Dockerfile", "Dockerfile.triton"}
SECRETS = {
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    "GitHub credential": re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b"),
    "AWS access key": re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "Slack credential": re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b"),
    "personal machine path": re.compile(r"/(?:home|Users)/[^/\s]+/"),
}


def check(strict=False):
    problems = []
    for path in sorted(ROOT.rglob("*")):
        rel = path.relative_to(ROOT)
        if any(part in LOCAL_BUILD or part.startswith(".venv") for part in rel.parts):
            if strict and path.is_file():
                problems.append(f"{rel}: local build file in export")
            continue
        if path.is_symlink():
            problems.append(f"{rel}: symlink is not allowed")
            continue
        if not path.is_file():
            continue
        if rel.as_posix() in PUBLIC_BINARY:
            if hashlib.sha256(path.read_bytes()).hexdigest() != PUBLIC_BINARY[rel.as_posix()]:
                problems.append(f"{rel}: approved binary checksum mismatch")
            continue
        if rel.as_posix() not in PUBLIC_DOCS and any(part in PRIVATE_DIRS for part in rel.parts):
            problems.append(f"{rel}: private directory")
        if rel.as_posix() not in PUBLIC_DOCS and path.name.lower().endswith(PRIVATE_SUFFIXES):
            problems.append(f"{rel}: private or binary extension")
        if path.name.startswith(("AGENTS", "CLAUDE", "GEMINI", ".aider")):
            problems.append(f"{rel}: agent file")
        if path.name.startswith(".env") and path.name != ".env.example":
            problems.append(f"{rel}: local environment file")
        if rel.as_posix() not in PUBLIC_DOCS and path.name not in SPECIAL_NAMES and path.suffix not in TEXT_SUFFIXES and path.suffix != ".svg":
            problems.append(f"{rel}: unreviewed file type")
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeError:
            problems.append(f"{rel}: binary or invalid UTF-8 content")
            continue
        for label, pattern in SECRETS.items():
            if pattern.search(content):
                # Report only location and rule, never the matched value.
                problems.append(f"{rel}: {label}")
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        print(f"Public source check failed: {len(problems)} finding(s)", file=sys.stderr)
        return 1
    print("Public source check passed")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strict", action="store_true", help="Also reject local build output")
    sys.exit(check(parser.parse_args().strict))
