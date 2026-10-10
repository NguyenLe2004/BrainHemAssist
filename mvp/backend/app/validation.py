from __future__ import annotations

import gzip
import struct
from pathlib import Path
from typing import Any


class InvalidNifti(ValueError):
    pass


def validate_nifti_filename(filename: str | None) -> str:
    if not filename:
        raise InvalidNifti("A filename is required")
    safe_name = Path(filename).name
    lower = safe_name.lower()
    if not (lower.endswith(".nii") or lower.endswith(".nii.gz")):
        raise InvalidNifti("Only .nii and .nii.gz files are accepted")
    return safe_name


def validate_nifti_header(path: Path) -> None:
    try:
        opener = gzip.open if path.name.lower().endswith(".gz") else open
        with opener(path, "rb") as stream:
            header = stream.read(540)
    except (OSError, EOFError) as exc:
        raise InvalidNifti(f"Cannot read NIfTI file: {exc}") from exc
    if len(header) < 348:
        raise InvalidNifti("NIfTI header is truncated")
    little = struct.unpack("<I", header[:4])[0]
    big = struct.unpack(">I", header[:4])[0]
    header_size = little if little in (348, 540) else big
    if header_size not in (348, 540):
        raise InvalidNifti("Invalid NIfTI header")
    magic_offset = 344 if header_size == 348 else 4
    expected = (b"n+1\0", b"ni1\0") if header_size == 348 else (b"n+2\0\r\n\x1a\n",)
    magic_size = 4 if header_size == 348 else 8
    if header[magic_offset : magic_offset + magic_size] not in expected:
        raise InvalidNifti("Invalid NIfTI magic value")


class InvalidMaskError(InvalidNifti):
    pass


def normalize_binary_annotation(path: Path) -> bool:
    """Canonicalize a single-class annotation to binary foreground in-place.

    BrainHem has one foreground class. NiiVue and older cached browser bundles
    can expose temporary positive values while serializing a stroke, so every
    finite positive value is foreground for both drafts and approved revisions.
    Geometry, affine and all other mask validation still run afterward.
    """
    import nibabel as nib
    import numpy as np

    try:
        image = nib.load(path)
        data = np.asanyarray(image.dataobj)
    except Exception as exc:
        raise InvalidMaskError(f"Cannot read mask NIfTI: {exc}") from exc

    if not np.all(np.isfinite(data)):
        return False
    if np.all((data == 0) | (data == 1)):
        return False

    normalized = (data > 0).astype(np.uint8)
    header = image.header.copy()
    header.set_data_dtype(np.uint8)
    output = nib.Nifti1Image(normalized, image.affine, header=header)
    qform, qform_code = image.get_qform(coded=True)
    sform, sform_code = image.get_sform(coded=True)
    output.set_qform(qform, int(qform_code or 0))
    output.set_sform(sform, int(sform_code or 0))
    normalized_path = path.with_name(
        f"{path.stem}.normalized.nii.gz"
        if path.name.lower().endswith(".gz")
        else f"{path.stem}.normalized.nii"
    )
    nib.save(output, normalized_path)
    normalized_path.replace(path)
    return True


def compute_canonical_nifti_digest(path: Path) -> str:
    import hashlib
    import nibabel as nib
    import numpy as np

    try:
        img = nib.load(path)
    except Exception as exc:
        raise InvalidNifti(f"Failed to load NIfTI image: {exc}") from exc

    shape = img.shape
    if len(shape) != 3:
        raise InvalidNifti(f"Source must be strictly 3D NIfTI, got {len(shape)}D with shape {shape}")
    if any(d <= 0 for d in shape):
        raise InvalidNifti(f"Invalid non-positive dimensions in shape {shape}")

    total_voxels = int(np.prod(shape))
    if total_voxels > 200_000_000:
        raise InvalidNifti(f"Image exceeds maximum voxel threshold ({total_voxels} voxels, max 200M)")

    affine = np.asanyarray(img.affine, dtype=np.float64)
    if not np.all(np.isfinite(affine)):
        raise InvalidNifti("Image affine matrix contains non-finite values (NaN or inf)")

    det = float(np.linalg.det(affine[:3, :3]))
    if not np.isfinite(det) or abs(det) < 1e-9:
        raise InvalidNifti(f"Affine matrix is singular or has invalid determinant ({det})")

    try:
        # Scale to physical float32 values so different storage types with same physical values match
        fdata = img.get_fdata(dtype=np.float32)
    except Exception as exc:
        raise InvalidNifti(f"Failed to read NIfTI voxel data: {exc}") from exc

    if not np.all(np.isfinite(fdata)):
        raise InvalidNifti("Source image contains NaN or infinite values")

    hasher = hashlib.sha256()
    hasher.update(str(tuple(int(s) for s in shape)).encode("utf-8"))
    hasher.update(np.round(affine, 3).tobytes())
    # Little-endian contiguous float32 buffer
    hasher.update(np.ascontiguousarray(fdata, dtype="<f4").tobytes())
    return hasher.hexdigest()


def extract_nifti_geometry(path: Path) -> dict[str, Any]:
    import nibabel as nib
    import numpy as np

    try:
        img = nib.load(path)
    except Exception as exc:
        raise InvalidNifti(f"Failed to load NIfTI geometry: {exc}") from exc

    shape = img.shape
    if len(shape) != 3:
        raise InvalidNifti(f"Source must be strictly 3D NIfTI, got {len(shape)}D with shape {shape}")
    if any(d <= 0 for d in shape):
        raise InvalidNifti(f"Invalid non-positive dimensions: {shape}")

    total_voxels = int(np.prod(shape))
    if total_voxels > 200_000_000:
        raise InvalidNifti(f"Image exceeds maximum voxel threshold ({total_voxels} voxels, max 200M)")

    affine = np.asanyarray(img.affine, dtype=np.float64)
    if not np.all(np.isfinite(affine)):
        raise InvalidNifti("Image affine matrix contains non-finite values")

    det = float(np.linalg.det(affine[:3, :3]))
    if not np.isfinite(det) or abs(det) < 1e-9:
        raise InvalidNifti(f"Affine matrix is singular or invalid (det={det})")

    zooms = [float(z) for z in img.header.get_zooms()[:3]]
    sform_code = int(img.get_sform(coded=True)[1])
    qform_code = int(img.get_qform(coded=True)[1])
    return {
        "shape": [int(s) for s in shape],
        "zooms": zooms,
        "affine": affine.tolist(),
        "sform_code": sform_code,
        "qform_code": qform_code,
    }


def validate_mask_against_source(source_path: Path, mask_path: Path) -> dict[str, Any]:
    import nibabel as nib
    import numpy as np

    try:
        source_img = nib.load(source_path)
    except Exception as exc:
        raise InvalidNifti(f"Cannot read source NIfTI: {exc}") from exc

    try:
        mask_img = nib.load(mask_path)
    except Exception as exc:
        raise InvalidMaskError(f"Cannot read mask NIfTI: {exc}") from exc

    if len(source_img.shape) != 3:
        raise InvalidNifti(f"Source image must be strictly 3D, got {len(source_img.shape)}D with shape {source_img.shape}")
    if len(mask_img.shape) != 3:
        raise InvalidMaskError(f"Mask must be strictly 3D, got {len(mask_img.shape)}D with shape {mask_img.shape}")

    source_shape = tuple(int(s) for s in source_img.shape)
    mask_shape = tuple(int(s) for s in mask_img.shape)

    if source_shape != mask_shape:
        raise InvalidMaskError(
            f"Mask shape {mask_shape} does not match source shape {source_shape}"
        )

    if not np.all(np.isfinite(mask_img.affine)) or not np.all(np.isfinite(source_img.affine)):
        raise InvalidMaskError("Affine matrix contains NaN or infinite values")

    if not np.allclose(mask_img.affine, source_img.affine, atol=1e-3, rtol=1e-4):
        raise InvalidMaskError(
            "Mask affine matrix does not match source affine (shifted or rotated)"
        )

    voxel_vol_mm3 = abs(float(np.linalg.det(source_img.affine[:3, :3])))
    if not np.isfinite(voxel_vol_mm3) or voxel_vol_mm3 < 1e-9:
        raise InvalidNifti(f"Source affine has singular or invalid determinant: {voxel_vol_mm3}")

    try:
        mask_data = np.asanyarray(mask_img.dataobj)
    except Exception as exc:
        raise InvalidMaskError(f"Cannot read mask voxel data: {exc}") from exc

    if not np.all(np.isfinite(mask_data)):
        raise InvalidMaskError("Mask contains NaN or infinite values")

    # Verify binary 0/1 labels
    unique_vals = np.unique(mask_data)
    for val in unique_vals:
        if val not in (0, 1):
            raise InvalidMaskError(
                f"Mask contains non-binary label value: {val}. Only 0 and 1 are accepted"
            )

    voxel_count = int(np.count_nonzero(mask_data == 1))
    volume_ml = round(voxel_count * voxel_vol_mm3 / 1000.0, 4)

    return {
        "shape": list(source_shape),
        "zooms": [float(z) for z in source_img.header.get_zooms()[:3]],
        "affine": source_img.affine.tolist(),
        "voxel_count": voxel_count,
        "volume_ml": volume_ml,
        "is_empty": voxel_count == 0,
    }
