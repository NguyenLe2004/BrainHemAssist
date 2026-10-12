"""Geometry checks must finish before a mask's voxel proxy is read."""
from pathlib import Path
from types import SimpleNamespace

import nibabel as nib
import numpy as np
import pytest

from app.validation import (
    InvalidMaskError, InvalidNifti, extract_nifti_geometry,
    normalize_binary_annotation, validate_mask_against_source,
)


class UnreadableVoxels:
    def __array__(self, *args, **kwargs):
        pytest.fail("Invalid geometry must be rejected before reading mask voxels")


@pytest.mark.parametrize("mask_shape,affine", [
    ((16, 16, 16), np.eye(4)),
    ((8, 8, 8, 1), np.eye(4)),
    ((1000, 1000, 1000), np.eye(4)),
    ((2**32, 2**32, 2), np.eye(4)),
    ((8, 8, 8), np.diag([2, 1, 1, 1])),
])
def test_invalid_mask_rejected_before_voxel_read(monkeypatch, mask_shape, affine):
    source = SimpleNamespace(shape=(8, 8, 8), affine=np.eye(4))
    mask = SimpleNamespace(shape=mask_shape, affine=affine, dataobj=UnreadableVoxels())
    monkeypatch.setattr(nib, "load", lambda path: source if path.name == "source.nii" else mask)
    for validate in [normalize_binary_annotation, lambda m, s: validate_mask_against_source(s, m)]:
        with pytest.raises(InvalidMaskError):
            validate(Path("mask.nii"), Path("source.nii"))


def test_source_dimension_product_cannot_overflow(monkeypatch):
    image = SimpleNamespace(shape=(2**32, 2**32, 2))
    monkeypatch.setattr(nib, "load", lambda _: image)
    with pytest.raises(InvalidNifti, match="maximum voxel threshold"):
        extract_nifti_geometry(Path("source.nii"))


def test_valid_annotation_normalizes_and_preserves_geometry(tmp_path):
    affine = np.diag([-1.5, 1.5, 3.0, 1.0])
    data = np.zeros((8, 8, 8), dtype=np.float32)
    data[2, 3, 4] = 7
    source = tmp_path / "source.nii.gz"
    mask = tmp_path / "mask.nii.gz"
    nib.save(nib.Nifti1Image(np.zeros_like(data), affine), source)
    nib.save(nib.Nifti1Image(data, affine), mask)
    assert normalize_binary_annotation(mask, source) is True
    result = validate_mask_against_source(source, mask)
    assert result["voxel_count"] == 1
    np.testing.assert_allclose(result["affine"], affine)
