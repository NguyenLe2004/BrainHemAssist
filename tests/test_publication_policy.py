"""Regression checks for deliberate documentation and binary exceptions."""
import hashlib
import importlib.util
from pathlib import Path

import pytest


@pytest.fixture
def policy(tmp_path):
    source = Path(__file__).resolve().parents[1] / "scripts/check_public_tree.py"
    spec = importlib.util.spec_from_file_location("publication_policy", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.ROOT = tmp_path
    return module


def write(policy, name, content):
    path = policy.ROOT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


@pytest.mark.parametrize("name", ["models/README.md", "docs/SETUP.md"])
def test_documentation_exception_still_scans_credentials(policy, name):
    doc = write(policy, name, "Reviewed public documentation")
    assert policy.check() == 0
    doc.write_text("-----BEGIN " + "PRIVATE KEY-----", encoding="utf-8")
    assert policy.check() == 1


@pytest.mark.parametrize("name", ["models/internal.md", "docs/AGENTS.md", "data/README.md", "docs/unreviewed.png"])
def test_unapproved_documents_and_images_remain_rejected(policy, name):
    write(policy, name, "Unapproved material")
    assert policy.check() == 1


def test_approved_binary_exception_requires_exact_bytes(policy):
    path = write(policy, "docs/images/reviewed.png", "Reviewed bytes")
    policy.PUBLIC_BINARY = {"docs/images/reviewed.png": hashlib.sha256(path.read_bytes()).hexdigest()}
    assert policy.check() == 0
    path.write_bytes(b"Changed bytes")
    assert policy.check() == 1


def test_approved_path_does_not_allow_symlink(policy):
    target = write(policy, "source.txt", "Reviewed source")
    doc = policy.ROOT / "models/README.md"
    doc.parent.mkdir()
    doc.symlink_to(target)
    assert policy.check() == 1


@pytest.mark.parametrize("strict", [False, True])
@pytest.mark.parametrize("name", ["node_modules", "dist", ".venv-public"])
def test_build_directory_symlink_cannot_bypass_policy(policy, tmp_path, name, strict):
    target = tmp_path.parent / f"external-{name}"
    target.mkdir(exist_ok=True)
    (policy.ROOT / name).symlink_to(target, target_is_directory=True)
    assert policy.check(strict=strict) == 1
