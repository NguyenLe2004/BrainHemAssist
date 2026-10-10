from __future__ import annotations

import base64
import dataclasses
import io
import json
import zipfile
from pathlib import Path
import shutil
import uuid

import nibabel as nib
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.models import JobStatus
from app.reviewer_auth import password_record

TEST_PASSWORD = "review-test-password-123"
TEST_RECORD = password_record(TEST_PASSWORD)
TEST_AUTH = "Basic " + base64.b64encode(f"test-reviewer:{TEST_PASSWORD}".encode()).decode()


def _create_synthetic_ct(
    path: Path,
    shape: tuple[int, int, int] = (16, 16, 8),
    affine: np.ndarray | None = None,
) -> Path:
    if affine is None:
        # Include an axis flip (negative x spacing) to test coordinate preservation
        affine = np.array([
            [-1.5, 0.0, 0.0, 120.0],
            [0.0, 1.5, 0.0, -100.0],
            [0.0, 0.0, 3.0, -40.0],
            [0.0, 0.0, 0.0, 1.0],
        ])
    data = np.full(shape, -50, dtype=np.int16)
    # Put a synthetic lesion in the middle
    data[6:10, 6:10, 2:5] = 60
    img = nib.Nifti1Image(data, affine)
    nib.save(img, path)
    return path


def _create_mask(
    path: Path,
    source_img: nib.Nifti1Image,
    pattern: str = "box",
) -> Path:
    mask_data = np.zeros(source_img.shape[:3], dtype=np.uint8)
    if pattern == "box":
        mask_data[6:10, 6:10, 2:5] = 1
    elif pattern == "empty":
        pass
    elif pattern == "nonbinary":
        mask_data[6:10, 6:10, 2:5] = 2  # Invalid label
    elif pattern == "nan":
        mask_float = np.zeros(source_img.shape[:3], dtype=np.float32)
        mask_float[6:10, 6:10, 2:5] = np.nan
        img_nan = nib.Nifti1Image(mask_float, source_img.affine)
        img_nan.set_data_dtype(np.float32)
        nib.save(img_nan, path)
        return path
    img = nib.Nifti1Image(mask_data, source_img.affine, header=source_img.header)
    img.set_data_dtype(np.uint8)
    nib.save(img, path)
    return path


def _make_settings(tmp_path: Path, direct_upload: bool = True) -> Settings:
    data_dir = tmp_path / "data"
    accounts = tmp_path / "reviewers.json"
    accounts.write_text(json.dumps({"test-reviewer": TEST_RECORD}))
    return Settings(feedback_user_password="user123", feedback_admin_password="admin123", rbac_enabled=False, 
        reviewer_accounts_file=str(accounts),
        data_dir=data_dir,
        database_path=data_dir / "app.sqlite3",
        inference_command="",
        inference_timeout_seconds=10,
        max_upload_bytes=10 * 1024 * 1024,
        retention_hours=1,
        worker_poll_seconds=0.01,
        direct_upload_enabled=direct_upload,
        dicom_enabled=False,
        simulator_enabled=False,
    )


def test_annotation_independent_of_inference(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    ct_path = _create_synthetic_ct(tmp_path / "test_ct.nii.gz")
    app = create_app(settings)

    with TestClient(app, headers={"Authorization": TEST_AUTH}) as client:
        # Case creation works even if inference is completely unconfigured
        with ct_path.open("rb") as f:
            resp = client.post(
                "/api/v1/annotations/cases",
                data={"name": "Independent Test Case"},
                files={"file": ("test_ct.nii.gz", f, "application/gzip")},
            )
        assert resp.status_code == 201
        case_data = resp.json()
        assert case_data["name"] == "Independent Test Case"
        assert case_data["current_revision"] == 0
        assert case_data["status"] == "draft"

        # Check source endpoint returns CT
        source_resp = client.get(f"/api/v1/annotations/cases/{case_data['id']}/source")
        assert source_resp.status_code == 200
        assert len(source_resp.content) > 0

        # Check revision 0 exists as initial draft
        revs_resp = client.get(f"/api/v1/annotations/cases/{case_data['id']}/revisions")
        assert revs_resp.status_code == 200
        revs = revs_resp.json()["items"]
        assert len(revs) == 1
        assert revs[0]["revision_number"] == 0
        assert revs[0]["is_empty_mask"] is True


def test_sam2_propagation_is_preview_only(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    ct_path = _create_synthetic_ct(tmp_path / "sam2_ct.nii.gz")
    source_img = nib.load(ct_path)
    seed_path = _create_mask(tmp_path / "sam2_seed.nii.gz", source_img)
    app = create_app(settings)

    class FakePropagator:
        available = True

        @staticmethod
        def predict(_source_path: Path, mask_path: Path, output_path: Path) -> dict:
            image = nib.load(mask_path)
            data = np.asanyarray(image.dataobj).astype(np.uint8)
            data[1, 1, 0] = 1
            nib.save(nib.Nifti1Image(data, image.affine, image.header), output_path)
            return {"seed_slices": [2, 3, 4], "predicted_slices": [0], "seconds": 0.01}

    app.state.sam2_propagator = FakePropagator()
    with TestClient(app, headers={"Authorization": TEST_AUTH}) as client:
        with ct_path.open("rb") as source_file:
            created = client.post(
                "/api/v1/annotations/cases",
                files={"file": ("sam2_ct.nii.gz", source_file, "application/gzip")},
            )
        case_id = created.json()["id"]
        with seed_path.open("rb") as seed_file:
            response = client.post(
                f"/api/v1/annotations/cases/{case_id}/sam2-propagate",
                files={"file": ("seed.nii.gz", seed_file, "application/gzip")},
            )

        assert response.status_code == 200
        metadata = json.loads(base64.b64decode(response.headers["X-SAM2-Metadata"]))
        assert metadata["seed_slices"] == [2, 3, 4]
        assert metadata["predicted_slices"] == [0]
        # A preview must never create a persisted annotation revision.
        revisions = client.get(f"/api/v1/annotations/cases/{case_id}/revisions").json()["items"]
        assert len(revisions) == 1
        assert revisions[0]["revision_number"] == 0


def test_create_from_job_source_identity(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    ct_path = _create_synthetic_ct(tmp_path / "job_ct.nii.gz")
    app = create_app(settings)

    with TestClient(app, headers={"Authorization": TEST_AUTH}) as client:
        # Upload a direct inference job
        with ct_path.open("rb") as f:
            job_resp = client.post(
                "/api/v1/jobs",
                files={"file": ("job_ct.nii.gz", f, "application/gzip")},
            )
        assert job_resp.status_code == 202
        job_id = job_resp.json()["id"]

        # Create annotation case from this job
        case_resp = client.post(
            "/api/v1/annotations/cases",
            data={"job_id": job_id, "name": "From Job Case"},
        )
        assert case_resp.status_code == 201
        case_data = case_resp.json()
        assert case_data["source_job_id"] == job_id
        assert case_data["name"] == "From Job Case"

        # Geometry must match
        src_img = nib.load(ct_path)
        assert case_data["geometry"]["shape"] == list(src_img.shape[:3])


def test_geometry_mismatch_and_invalid_masks_rejected(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    ct_path = _create_synthetic_ct(tmp_path / "source.nii.gz")
    src_img = nib.load(ct_path)
    app = create_app(settings)

    with TestClient(app, headers={"Authorization": TEST_AUTH}) as client:
        with ct_path.open("rb") as f:
            create_resp = client.post(
                "/api/v1/annotations/cases",
                files={"file": ("source.nii.gz", f, "application/gzip")},
            )
        case_id = create_resp.json()["id"]

        # 1. Wrong shape
        wrong_shape_mask = tmp_path / "wrong_shape.nii.gz"
        nib.save(
            nib.Nifti1Image(np.zeros((8, 8, 4), dtype=np.uint8), src_img.affine),
            wrong_shape_mask,
        )
        with wrong_shape_mask.open("rb") as f:
            resp = client.post(
                f"/api/v1/annotations/cases/{case_id}/revisions",
                data={"expected_revision": 0, "status": "draft"},
                files={"file": ("mask.nii.gz", f, "application/gzip")},
            )
        assert resp.status_code == 422
        assert "shape" in resp.json()["detail"].lower()

        # 2. Shifted affine
        shifted_affine = src_img.affine.copy()
        shifted_affine[0, 3] += 15.0  # Shift 15mm along x
        shifted_mask = tmp_path / "shifted.nii.gz"
        nib.save(
            nib.Nifti1Image(np.zeros(src_img.shape[:3], dtype=np.uint8), shifted_affine),
            shifted_mask,
        )
        with shifted_mask.open("rb") as f:
            resp = client.post(
                f"/api/v1/annotations/cases/{case_id}/revisions",
                data={"expected_revision": 0, "status": "draft"},
                files={"file": ("mask.nii.gz", f, "application/gzip")},
            )
        assert resp.status_code == 422
        assert "affine" in resp.json()["detail"].lower()

        # 3. Positive editor labels are canonicalized to binary foreground.
        nonbinary_path = tmp_path / "nonbinary.nii.gz"
        _create_mask(nonbinary_path, src_img, pattern="nonbinary")
        with nonbinary_path.open("rb") as f:
            resp = client.post(
                f"/api/v1/annotations/cases/{case_id}/revisions",
                data={
                    "expected_revision": 0,
                    "status": "approved",
                    "reviewed_entire_volume": "true",
                },
                files={"file": ("mask.nii.gz", f, "application/gzip")},
            )
        assert resp.status_code == 201
        assert resp.json()["voxel_count"] == 48

        # 4. NaN voxels
        nan_path = tmp_path / "nan.nii.gz"
        _create_mask(nan_path, src_img, pattern="nan")
        with nan_path.open("rb") as f:
            resp = client.post(
                f"/api/v1/annotations/cases/{case_id}/revisions",
                data={"expected_revision": 1, "status": "draft"},
                files={"file": ("mask.nii.gz", f, "application/gzip")},
            )
        assert resp.status_code == 422


@pytest.mark.parametrize(
    ("authenticated", "temporary_value"),
    [(False, 2), (True, 2), (True, 255)],
)
def test_editor_draft_normalizes_niivue_temporary_label(
    tmp_path: Path,
    authenticated: bool,
    temporary_value: int,
) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    ct_path = _create_synthetic_ct(tmp_path / "source.nii.gz")
    source_img = nib.load(ct_path)
    temporary_mask_path = _create_mask(
        tmp_path / "niivue-temporary-mask.nii.gz",
        source_img,
        pattern="nonbinary",
    )
    if temporary_value != 2:
        temporary_image = nib.load(temporary_mask_path)
        temporary_data = np.asanyarray(temporary_image.dataobj).copy()
        temporary_data[temporary_data > 0] = temporary_value
        nib.save(
            nib.Nifti1Image(
                temporary_data.astype(np.uint8),
                temporary_image.affine,
                header=temporary_image.header,
            ),
            temporary_mask_path,
        )
    app = create_app(settings)

    # NiiVue may expose label 2 while completing a brush stroke. Clinical
    # training drafts require a named account before normalization/persistence.
    headers = {"Authorization": TEST_AUTH} if authenticated else {}
    with TestClient(app, headers=headers) as client:
        with ct_path.open("rb") as source_file:
            create_resp = client.post(
                "/api/v1/annotations/cases",
                files={"file": ("source.nii.gz", source_file, "application/gzip")},
            )
        assert create_resp.status_code == 201
        case_id = create_resp.json()["id"]

        with temporary_mask_path.open("rb") as mask_file:
            save_resp = client.post(
                f"/api/v1/annotations/cases/{case_id}/revisions",
                data={"expected_revision": 0, "status": "draft"},
                files={"file": ("mask.nii.gz", mask_file, "application/gzip")},
            )
        if not authenticated:
            assert save_resp.status_code == 401
            assert client.get(
                f"/api/v1/annotations/cases/{case_id}"
            ).json()["current_revision"] == 0
            return

        assert save_resp.status_code == 201
        assert save_resp.json()["revision_number"] == 1
        assert save_resp.json()["voxel_count"] == 48

        detail_resp = client.get(f"/api/v1/annotations/cases/{case_id}")
        assert detail_resp.status_code == 200
        assert detail_resp.json()["current_revision"] == 1
        assert detail_resp.json()["label_voxel_count"] == 48

        mask_resp = client.get(
            f"/api/v1/annotations/cases/{case_id}/revisions/1/mask"
        )
        assert mask_resp.status_code == 200
        saved_mask_path = tmp_path / "saved-normalized-mask.nii.gz"
        saved_mask_path.write_bytes(mask_resp.content)
        saved_values = np.unique(np.asanyarray(nib.load(saved_mask_path).dataobj))
        assert set(saved_values.tolist()) == {0, 1}


def test_revision_conflict_optimistic_lock(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    ct_path = _create_synthetic_ct(tmp_path / "source.nii.gz")
    src_img = nib.load(ct_path)
    mask_path = _create_mask(tmp_path / "mask.nii.gz", src_img, pattern="box")
    app = create_app(settings)

    with TestClient(app, headers={"Authorization": TEST_AUTH}) as client:
        with ct_path.open("rb") as f:
            create_resp = client.post(
                "/api/v1/annotations/cases",
                files={"file": ("source.nii.gz", f, "application/gzip")},
            )
        case_id = create_resp.json()["id"]

        # Save revision 1 expecting revision 0 -> SUCCESS
        with mask_path.open("rb") as f:
            resp1 = client.post(
                f"/api/v1/annotations/cases/{case_id}/revisions",
                data={
                    "expected_revision": 0,
                    "status": "draft",
                    "reviewer": "Dr. Alice",
                },
                files={"file": ("mask.nii.gz", f, "application/gzip")},
            )
        assert resp1.status_code == 201
        assert resp1.json()["revision_number"] == 1

        # Concurrent write also expecting revision 0 -> 409 CONFLICT!
        with mask_path.open("rb") as f:
            resp2 = client.post(
                f"/api/v1/annotations/cases/{case_id}/revisions",
                data={
                    "expected_revision": 0,
                    "status": "draft",
                    "reviewer": "Dr. Bob",
                },
                files={"file": ("mask.nii.gz", f, "application/gzip")},
            )
        assert resp2.status_code == 409
        assert "conflict" in resp2.json()["detail"].lower()


def test_save_reload_exact_voxels_and_affine_axis_flips(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    # Affine with diagonal axis flips: negative spacing on x and z
    flipped_affine = np.array([
        [-1.2, 0.0, 0.0, 100.0],
        [0.0, 1.2, 0.0, -80.0],
        [0.0, 0.0, -2.5, 50.0],
        [0.0, 0.0, 0.0, 1.0],
    ])
    ct_path = _create_synthetic_ct(
        tmp_path / "flipped_ct.nii.gz", shape=(20, 20, 10), affine=flipped_affine
    )
    src_img = nib.load(ct_path)

    # Specific voxel pattern
    mask_data = np.zeros(src_img.shape[:3], dtype=np.uint8)
    mask_data[3, 5, 2] = 1
    mask_data[10:15, 12:16, 4:8] = 1
    custom_mask = tmp_path / "custom_mask.nii.gz"
    nib.save(
        nib.Nifti1Image(mask_data, flipped_affine, header=src_img.header),
        custom_mask,
    )

    app = create_app(settings)
    with TestClient(app, headers={"Authorization": TEST_AUTH}) as client:
        with ct_path.open("rb") as f:
            create_resp = client.post(
                "/api/v1/annotations/cases",
                files={"file": ("flipped_ct.nii.gz", f, "application/gzip")},
            )
        case_id = create_resp.json()["id"]

        with custom_mask.open("rb") as f:
            save_resp = client.post(
                f"/api/v1/annotations/cases/{case_id}/revisions",
                data={
                    "expected_revision": 0,
                    "status": "draft",
                    "reviewer": "Dr. Flips",
                },
                files={"file": ("mask.nii.gz", f, "application/gzip")},
            )
        assert save_resp.status_code == 201

        # Download saved mask and check voxel-for-voxel and affine match
        get_mask_resp = client.get(
            f"/api/v1/annotations/cases/{case_id}/revisions/1/mask"
        )
        assert get_mask_resp.status_code == 200

        downloaded_path = tmp_path / "downloaded_mask.nii.gz"
        downloaded_path.write_bytes(get_mask_resp.content)
        reloaded_img = nib.load(downloaded_path)

        assert np.allclose(reloaded_img.affine, flipped_affine, atol=1e-4)
        assert np.array_equal(np.asanyarray(reloaded_img.dataobj), mask_data)


def test_empty_mask_review_acknowledgement(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    ct_path = _create_synthetic_ct(tmp_path / "source.nii.gz")
    src_img = nib.load(ct_path)
    empty_mask = _create_mask(tmp_path / "empty.nii.gz", src_img, pattern="empty")
    app = create_app(settings)

    with TestClient(app, headers={"Authorization": TEST_AUTH}) as client:
        with ct_path.open("rb") as f:
            c = client.post(
                "/api/v1/annotations/cases",
                files={"file": ("source.nii.gz", f, "application/gzip")},
            ).json()
        case_id = c["id"]

        # Attempt to approve an empty mask WITHOUT whole-volume acknowledgement -> REJECTED (422)
        with empty_mask.open("rb") as f:
            resp_fail = client.post(
                f"/api/v1/annotations/cases/{case_id}/revisions",
                data={
                    "expected_revision": 0,
                    "status": "approved",
                    "reviewer": "Dr. Quick",
                    "reviewed_entire_volume": False,
                },
                files={"file": ("mask.nii.gz", f, "application/gzip")},
            )
        assert resp_fail.status_code == 422
        assert "acknowledgement" in resp_fail.json()["detail"].lower()

        # Approve empty mask WITH explicit whole-volume acknowledgement -> ACCEPTED (201)
        with empty_mask.open("rb") as f:
            resp_ok = client.post(
                f"/api/v1/annotations/cases/{case_id}/revisions",
                data={
                    "expected_revision": 0,
                    "status": "approved",
                    "reviewer": "Dr. Thorough",
                    "reviewed_entire_volume": True,
                    "notes": "Verified entirely negative scan on all slices",
                },
                files={"file": ("mask.nii.gz", f, "application/gzip")},
            )
        assert resp_ok.status_code == 201
        assert resp_ok.json()["status"] == "approved"
        assert resp_ok.json()["is_empty_mask"] is True


def test_export_approved_dataset_and_provenance(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    ct1 = _create_synthetic_ct(tmp_path / "ct1.nii.gz")
    ct2 = _create_synthetic_ct(tmp_path / "ct2.nii.gz")
    mask1 = _create_mask(tmp_path / "m1.nii.gz", nib.load(ct1), pattern="box")
    mask2 = _create_mask(tmp_path / "m2.nii.gz", nib.load(ct2), pattern="box")

    app = create_app(settings)
    with TestClient(app, headers={"Authorization": TEST_AUTH}) as client:
        # Case 1: has approved revision
        with ct1.open("rb") as f:
            c1 = client.post(
                "/api/v1/annotations/cases",
                data={"name": "Case One"},
                files={"file": ("ct1.nii.gz", f, "application/gzip")},
            ).json()
        with mask1.open("rb") as f:
            client.post(
                f"/api/v1/annotations/cases/{c1['id']}/revisions",
                data={
                    "expected_revision": 0,
                    "status": "approved",
                    "reviewer": "Dr. Alice",
                    "reviewed_entire_volume": True,
                },
                files={"file": ("mask.nii.gz", f, "application/gzip")},
            )

        # Case 2: only has draft revision (should NOT be exported)
        with ct2.open("rb") as f:
            c2 = client.post(
                "/api/v1/annotations/cases",
                data={"name": "Case Two Draft"},
                files={"file": ("ct2.nii.gz", f, "application/gzip")},
            ).json()
        with mask2.open("rb") as f:
            client.post(
                f"/api/v1/annotations/cases/{c2['id']}/revisions",
                data={
                    "expected_revision": 0,
                    "status": "draft",
                    "reviewer": "Dr. Bob",
                },
                files={"file": ("mask.nii.gz", f, "application/gzip")},
            )

        # Download exported dataset zip
        export_resp = client.get("/api/v1/annotations/export")
        assert export_resp.status_code == 200
        assert export_resp.headers["content-type"] == "application/zip"

        # Inspect zip contents
        zip_buf = io.BytesIO(export_resp.content)
        with zipfile.ZipFile(zip_buf, "r") as archive:
            namelist = archive.namelist()
            assert "dataset.json" in namelist
            assert "provenance_manifest.json" in namelist
            assert "imagesTr/case_0001_0000.nii.gz" in namelist
            assert "labelsTr/case_0001.nii.gz" in namelist
            # Draft case 2 must NOT be present
            assert "imagesTr/case_0002_0000.nii.gz" not in namelist

            dataset_meta = json.loads(archive.read("dataset.json").decode("utf-8"))
            assert dataset_meta["numTraining"] == 1
            assert dataset_meta["labels"] == {"background": 0, "hemorrhage": 1}

            provenance = json.loads(archive.read("provenance_manifest.json").decode("utf-8"))
            assert provenance["num_cases"] == 1
            assert provenance["cases"][0]["reviewer"] == "test-reviewer"
            assert provenance["cases"][0]["case_name"] == "Case One"


def test_annotation_preservation_after_job_retention(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    ct = _create_synthetic_ct(tmp_path / "ct.nii.gz")
    app = create_app(settings)

    with TestClient(app, headers={"Authorization": TEST_AUTH}) as client:
        # Create job
        with ct.open("rb") as f:
            job_id = client.post(
                "/api/v1/jobs",
                files={"file": ("ct.nii.gz", f, "application/gzip")},
            ).json()["id"]

        # Create annotation case from that job
        c = client.post(
            "/api/v1/annotations/cases",
            data={"job_id": job_id, "name": "Preserved Case"},
        ).json()
        case_id = c["id"]

        # Fast forward / trigger job retention cleanup
        store = app.state.store
        # Mark job completed long ago
        with store._connect() as conn:
            conn.execute(
                "UPDATE jobs SET status = 'succeeded', completed_at = '2000-01-01T00:00:00+00:00' WHERE id = ?",
                (job_id,),
            )
        cleaned = store.cleanup_expired(retention_hours=1)
        assert cleaned >= 1

        # Verify job was cleaned up
        assert store.get(job_id) is None

        # Verify annotation case, source file, and revisions remain INTACT!
        case_resp = client.get(f"/api/v1/annotations/cases/{case_id}")
        assert case_resp.status_code == 200
        src_resp = client.get(f"/api/v1/annotations/cases/{case_id}/source")
        assert src_resp.status_code == 200
        assert len(src_resp.content) > 0


def test_seed_from_succeeded_job(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    ct = _create_synthetic_ct(tmp_path / "ct.nii.gz")
    src_img = nib.load(ct)
    app = create_app(settings)

    with TestClient(app, headers={"Authorization": TEST_AUTH}) as client:
        # Create case
        with ct.open("rb") as f:
            case_id = client.post(
                "/api/v1/annotations/cases",
                data={"name": "Seed Target Case"},
                files={"file": ("ct.nii.gz", f, "application/gzip")},
            ).json()["id"]

        # Create a job that succeeds with a mask
        job_id = str(uuid.uuid4())
        job_dir = settings.data_dir / "jobs" / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        input_file = job_dir / "input.nii.gz"
        mask_file = job_dir / "mask.nii.gz"
        shutil.copyfile(ct, input_file)
        _create_mask(mask_file, src_img, pattern="box")
        with app.state.store._connect() as conn:
            conn.execute(
                """
                INSERT INTO jobs (
                    id, status, input_type, original_filename, size_bytes,
                    input_path, output_path, created_at, updated_at, completed_at,
                    volume_ml
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    "succeeded",
                    "nifti",
                    "ct.nii.gz",
                    ct.stat().st_size,
                    str(input_file),
                    str(mask_file),
                    "2026-01-01T00:00:00+00:00",
                    "2026-01-01T00:00:00+00:00",
                    "2026-01-01T00:00:00+00:00",
                    1.25,
                ),
            )

        # Seed the annotation case from this job
        seed_resp = client.post(
            f"/api/v1/annotations/cases/{case_id}/seed",
            data={"job_id": job_id, "expected_revision": 0, "reviewer": "AI-Model"},
        )
        assert seed_resp.status_code == 201
        rev = seed_resp.json()
        assert rev["volume_ml"] > 0


def test_empty_upload_rejected(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    app = create_app(settings)
    with TestClient(app, headers={"Authorization": TEST_AUTH}) as client:
        resp = client.post(
            "/api/v1/annotations/cases",
            data={"name": "Empty Upload Test"},
            files={"file": ("empty.nii.gz", b"", "application/gzip")},
        )
        assert resp.status_code == 422
        assert "empty" in resp.json()["detail"].lower()


def test_approved_revision_requires_whole_volume_review_and_reviewer(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    ct = _create_synthetic_ct(tmp_path / "ct.nii.gz")
    src_img = nib.load(ct)
    mask_box = _create_mask(tmp_path / "mask_box.nii.gz", src_img, pattern="box")
    app = create_app(settings)

    with TestClient(app, headers={"Authorization": TEST_AUTH}) as client:
        with ct.open("rb") as f:
            case_id = client.post(
                "/api/v1/annotations/cases",
                data={"name": "Review Requirement Case"},
                files={"file": ("ct.nii.gz", f, "application/gzip")},
            ).json()["id"]

        # Negative 1: Saving approved revision WITHOUT reviewed_entire_volume on positive mask
        with mask_box.open("rb") as f:
            resp_no_vol = client.post(
                f"/api/v1/annotations/cases/{case_id}/revisions",
                data={
                    "expected_revision": 0,
                    "status": "approved",
                    "reviewer": "Dr. Valid",
                    "reviewed_entire_volume": "false",
                },
                files={"file": ("mask.nii.gz", f, "application/gzip")},
            )
        assert resp_no_vol.status_code == 422
        assert "entire volume" in resp_no_vol.json()["detail"].lower()

        # Negative 2: Saving approved revision without authenticated reviewer
        with mask_box.open("rb") as f:
            resp_no_rev = client.post(
                f"/api/v1/annotations/cases/{case_id}/revisions",
                headers={"Authorization": ""},
                data={
                    "expected_revision": 0,
                    "status": "approved",
                    "reviewer": "   ",
                    "reviewed_entire_volume": "true",
                },
                files={"file": ("mask.nii.gz", f, "application/gzip")},
            )
        assert resp_no_rev.status_code == 401

        # Positive 1: Saving draft WITHOUT reviewed_entire_volume succeeds
        with mask_box.open("rb") as f:
            resp_draft = client.post(
                f"/api/v1/annotations/cases/{case_id}/revisions",
                data={
                    "expected_revision": 0,
                    "status": "draft",
                    "reviewer": "Dr. InProgress",
                    "reviewed_entire_volume": "false",
                },
                files={"file": ("mask.nii.gz", f, "application/gzip")},
            )
        assert resp_draft.status_code == 201
        assert resp_draft.json()["revision_number"] == 1
        assert resp_draft.json()["status"] == "draft"

        # Positive 2: Saving approved WITH reviewed_entire_volume=true succeeds
        with mask_box.open("rb") as f:
            resp_app = client.post(
                f"/api/v1/annotations/cases/{case_id}/revisions",
                data={
                    "expected_revision": 1,
                    "status": "approved",
                    "reviewer": "Dr. Certifier",
                    "reviewed_entire_volume": "true",
                },
                files={"file": ("mask.nii.gz", f, "application/gzip")},
            )
        assert resp_app.status_code == 201
        assert resp_app.json()["revision_number"] == 2
        assert resp_app.json()["status"] == "approved"


def test_case_summary_exposes_relabel_and_gt_review_badges(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    ct = _create_synthetic_ct(tmp_path / "gt-case.nii.gz")
    mask = _create_mask(tmp_path / "gt-mask.nii.gz", nib.load(ct), pattern="box")
    app = create_app(settings)

    with TestClient(app, headers={"Authorization": TEST_AUTH}) as client:
        with ct.open("rb") as source:
            case_id = client.post(
                "/api/v1/annotations/cases",
                data={"name": "INSTANCE 2022 001"},
                files={"file": ("ct.nii.gz", source, "application/gzip")},
            ).json()["id"]

        app.state.annotation_store.save_revision(
            case_id, mask, "draft", 0, "AI seed",
            seed_job_id="model-l-job", seed_tier="high", seed_model_version="brainhem-l-v1",
        )
        app.state.annotation_store.save_revision(
            case_id, mask, "approved", 1, "admin",
            notes="Whole-volume mask replaced and compared with INSTANCE 2022 GT; not physician review.",
            reviewed_entire_volume=True,
        )

        detail = client.get(f"/api/v1/annotations/cases/{case_id}").json()
        listed = next(item for item in client.get("/api/v1/annotations/cases").json()["items"] if item["id"] == case_id)
        for item in (detail, listed):
            assert item["label_updated"] is True
            assert item["label_review_method"] == "gt_simulation"
            assert item["label_reviewed_entire_volume"] is True
            assert item["status"] == "approved"


def test_component_summary_matches_editor_26_neighbour_connectivity(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    app = create_app(settings)
    data = np.zeros((8, 8, 4), dtype=np.uint8)
    data[3, 3, 1] = 1
    data[4, 4, 2] = 1
    path = tmp_path / "diagonal-component.nii.gz"
    nib.save(nib.Nifti1Image(data, np.eye(4)), path)

    component_count, labeled_slices = app.state.annotation_store._mask_structure_summary(path)
    assert component_count == 1
    assert labeled_slices == 2


def _create_succeeded_job(
    app,
    settings: Settings,
    ct: Path,
    pattern: str = "box",
    volume_ml: float = 2.5,
    model_version: str = "baseline-s-v1",
    inference_tier: str = "standard",
) -> str:
    job_id = f"job-{uuid.uuid4().hex[:8]}"
    job_dir = settings.data_dir / "jobs" / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    input_file = job_dir / "input.nii.gz"
    mask_file = job_dir / "mask.nii.gz"
    shutil.copyfile(ct, input_file)
    _create_mask(mask_file, nib.load(ct), pattern=pattern)
    with app.state.store._connect() as conn:
        conn.execute(
            """
            INSERT INTO jobs (
                id, status, input_type, original_filename, size_bytes,
                input_path, output_path, created_at, updated_at, completed_at,
                volume_ml, inference_tier, model_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job_id,
                "succeeded",
                "nifti",
                "ct.nii.gz",
                ct.stat().st_size,
                str(input_file),
                str(mask_file),
                "2026-01-01T00:00:00+00:00",
                "2026-01-01T00:00:00+00:00",
                "2026-01-01T00:00:00+00:00",
                volume_ml,
                inference_tier,
                model_version,
            ),
        )
    return job_id


def test_seed_negative_paths(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    ct1 = _create_synthetic_ct(tmp_path / "ct1.nii.gz", shape=(16, 16, 8))
    # Unrelated CT with different shape/voxels
    ct2 = _create_synthetic_ct(tmp_path / "ct2.nii.gz", shape=(16, 16, 10))
    app = create_app(settings)

    with TestClient(app, headers={"Authorization": TEST_AUTH}) as client:
        with ct1.open("rb") as f:
            case_id = client.post(
                "/api/v1/annotations/cases",
                data={"name": "Seed Target"},
                files={"file": ("ct1.nii.gz", f, "application/gzip")},
            ).json()["id"]

        # 1. Non-existent job
        resp_404 = client.post(
            f"/api/v1/annotations/cases/{case_id}/seed",
            data={"job_id": "non-existent-job-uuid", "expected_revision": 0},
        )
        assert resp_404.status_code == 404

        # 2. Non-succeeded job (queued or running)
        with ct1.open("rb") as f:
            queued_job_id = client.post(
                "/api/v1/jobs",
                files={"file": ("ct1.nii.gz", f, "application/gzip")},
            ).json()["id"]
        resp_409 = client.post(
            f"/api/v1/annotations/cases/{case_id}/seed",
            data={"job_id": queued_job_id, "expected_revision": 0},
        )
        assert resp_409.status_code == 409

        # 3. Succeeded job from an UNRELATED CT (different voxels/shape)
        unrelated_job_id = _create_succeeded_job(app, settings, ct2, volume_ml=2.0)

        resp_unrelated = client.post(
            f"/api/v1/annotations/cases/{case_id}/seed",
            data={"job_id": unrelated_job_id, "expected_revision": 0},
        )
        assert resp_unrelated.status_code == 422
        assert "does not match" in resp_unrelated.json()["detail"].lower() or "voxels" in resp_unrelated.json()["detail"].lower()


def test_run_case_inference_unavailable_tier_503(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    # Ensure high tier is NOT configured
    settings = dataclasses.replace(settings, inference_high_command="")
    ct = _create_synthetic_ct(tmp_path / "ct.nii.gz")
    app = create_app(settings)

    with TestClient(app, headers={"Authorization": TEST_AUTH}) as client:
        with ct.open("rb") as f:
            case_id = client.post(
                "/api/v1/annotations/cases",
                data={"name": "Tier Test Case"},
                files={"file": ("ct.nii.gz", f, "application/gzip")},
            ).json()["id"]

        # Requesting unavailable 'high' tier must be rejected with 503 BEFORE queueing!
        resp_503 = client.post(f"/api/v1/annotations/cases/{case_id}/inference?tier=high", headers={"Authorization": "Basic YWRtaW46YWRtaW4xMjM="})
        assert resp_503.status_code == 503
        assert "unavailable" in resp_503.json()["detail"].lower()


def test_canonical_deduplication_same_source_ct(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    ct_gz = _create_synthetic_ct(tmp_path / "scan.nii.gz")
    # Save the exact same scan as uncompressed .nii
    img = nib.load(ct_gz)
    ct_raw = tmp_path / "scan.nii"
    nib.save(img, ct_raw)

    app = create_app(settings)
    with TestClient(app, headers={"Authorization": TEST_AUTH}) as client:
        with ct_gz.open("rb") as f:
            resp1 = client.post(
                "/api/v1/annotations/cases",
                data={"name": "First Upload"},
                files={"file": ("scan.nii.gz", f, "application/gzip")},
            )
        assert resp1.status_code == 201
        assert resp1.headers["X-Annotation-Reused"] == "false"
        case1 = resp1.json()

        with ct_raw.open("rb") as f:
            resp2 = client.post(
                "/api/v1/annotations/cases",
                data={"name": "Second Upload (Same CT)"},
                files={"file": ("scan.nii", f, "application/octet-stream")},
            )
        assert resp2.status_code in (200, 201)
        assert resp2.headers["X-Annotation-Reused"] == "true"
        case2 = resp2.json()

        # Deduplication: same canonical CT voxels + affine return the existing case!
        assert case1["id"] == case2["id"]


def test_export_empty_returns_404(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    app = create_app(settings)
    with TestClient(app, headers={"Authorization": TEST_AUTH}) as client:
        # No approved cases exist
        resp = client.get("/api/v1/annotations/export")
        assert resp.status_code == 404


def test_validation_rejects_4d_and_nan_and_singular_affine(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    app = create_app(settings)

    with TestClient(app, headers={"Authorization": TEST_AUTH}) as client:
        # 1. Reject 4D source CT
        data_4d = np.zeros((10, 10, 10, 2), dtype=np.int16)
        img_4d = nib.Nifti1Image(data_4d, np.eye(4))
        p_4d = tmp_path / "scan_4d.nii.gz"
        nib.save(img_4d, p_4d)
        with p_4d.open("rb") as f:
            resp = client.post(
                "/api/v1/annotations/cases",
                data={"name": "4D Test"},
                files={"file": ("scan_4d.nii.gz", f, "application/gzip")},
            )
        assert resp.status_code == 422
        assert "strictly 3d" in resp.json()["detail"].lower()

        # 2. Reject NaN in source CT
        data_nan = np.zeros((10, 10, 10), dtype=np.float32)
        data_nan[5, 5, 5] = np.nan
        img_nan = nib.Nifti1Image(data_nan, np.eye(4))
        p_nan = tmp_path / "scan_nan.nii.gz"
        nib.save(img_nan, p_nan)
        with p_nan.open("rb") as f:
            resp = client.post(
                "/api/v1/annotations/cases",
                data={"name": "NaN Test"},
                files={"file": ("scan_nan.nii.gz", f, "application/gzip")},
            )
        assert resp.status_code == 422
        assert "finite" in resp.json()["detail"].lower()

        # 3. Reject singular affine (det = 0)
        data_3d = np.zeros((10, 10, 10), dtype=np.int16)
        img_sing = nib.Nifti1Image(data_3d, np.eye(4))
        singular_affine = np.eye(4, dtype=np.float64)
        singular_affine[2, 2] = 0.0  # zero zoom -> det(affine[:3, :3]) == 0
        img_sing.set_sform(singular_affine, code=2)
        p_sing = tmp_path / "scan_sing.nii.gz"
        nib.save(img_sing, p_sing)
        with p_sing.open("rb") as f:
            resp = client.post(
                "/api/v1/annotations/cases",
                data={"name": "Singular Affine Test"},
                files={"file": ("scan_sing.nii.gz", f, "application/gzip")},
            )
        assert resp.status_code == 422
        assert "singular" in resp.json()["detail"].lower() or "det" in resp.json()["detail"].lower()


def test_provenance_inheritance_and_clearing(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    ct = _create_synthetic_ct(tmp_path / "ct.nii.gz")
    app = create_app(settings)

    with TestClient(app, headers={"Authorization": TEST_AUTH}) as client:
        # Create case
        with ct.open("rb") as f:
            case_id = client.post(
                "/api/v1/annotations/cases",
                data={"name": "Provenance Case"},
                files={"file": ("ct.nii.gz", f, "application/gzip")},
            ).json()["id"]

        # Run job and seed rev 1
        job_id = _create_succeeded_job(app, settings, ct, volume_ml=3.5)

        # Rev 1 seeded from job
        seed_resp = client.post(
            f"/api/v1/annotations/cases/{case_id}/seed",
            data={"job_id": job_id, "expected_revision": 0},
        )
        assert seed_resp.status_code == 201
        rev1 = seed_resp.json()
        assert rev1["revision_number"] == 1
        assert rev1["seed_job_id"] == job_id
        assert rev1["seed_model_version"] is not None
        assert rev1["parent_revision"] is None

        # Rev 2 saved by doctor as draft without passing seed metadata -> inherits provenance!
        mask_path = tmp_path / "mask_rev2.nii.gz"
        _create_mask(mask_path, nib.load(ct), pattern="box")
        with mask_path.open("rb") as f:
            rev2_resp = client.post(
                f"/api/v1/annotations/cases/{case_id}/revisions",
                data={
                    "expected_revision": 1,
                    "status": "draft",
                    "reviewer": "Dr. Minh",
                },
                files={"file": ("mask_rev2.nii.gz", f, "application/gzip")},
            )
        assert rev2_resp.status_code == 201
        rev2 = rev2_resp.json()
        assert rev2["revision_number"] == 2
        assert rev2["parent_revision"] == 1
        assert rev2["seed_job_id"] == job_id
        assert rev2["seed_model_version"] == rev1["seed_model_version"]

        # Rev 3 approved with clear_provenance=True -> breaks AI lineage!
        with mask_path.open("rb") as f:
            rev3_resp = client.post(
                f"/api/v1/annotations/cases/{case_id}/revisions",
                data={
                    "expected_revision": 2,
                    "status": "approved",
                    "reviewer": "Dr. Minh",
                    "reviewed_entire_volume": "true",
                    "clear_provenance": "true",
                },
                files={"file": ("mask_rev3.nii.gz", f, "application/gzip")},
            )
        assert rev3_resp.status_code == 201
        rev3 = rev3_resp.json()
        assert rev3["revision_number"] == 3
        assert rev3["parent_revision"] == 2
        assert rev3["seed_job_id"] is None
        assert rev3["seed_model_version"] is None

        # Check export manifest includes parent_revision
        export_resp = client.get("/api/v1/annotations/export")
        assert export_resp.status_code == 200
        with zipfile.ZipFile(io.BytesIO(export_resp.content)) as zf:
            manifest_name = "provenance_manifest.json" if "provenance_manifest.json" in zf.namelist() else "manifest.json"
            manifest_json = json.loads(zf.read(manifest_name).decode("utf-8"))
            case_entry = next(c for c in manifest_json["cases"] if c["case_id"] == case_id)
            assert case_entry["revision_number"] == 3
            assert case_entry["parent_revision"] == 2
            assert case_entry["seed_model_version"] is None


def test_deduplication_preserves_series_identity(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    ct = _create_synthetic_ct(tmp_path / "ct.nii.gz")
    app = create_app(settings)

    with TestClient(app):
        # Directly create two cases in store with same digest but different series_instance_uid
        case1, created1 = app.state.annotation_store.create_case(
            case_id="case-series-1",
            name="Case Series 1",
            source_file_path=ct,
            series_instance_uid="1.2.840.113619.2.1",
            study_instance_uid="1.2.840.113619.1.1",
        )
        assert created1 is True

        # Same scan digest, different series UID -> must NOT collapse into same case
        case2, created2 = app.state.annotation_store.create_case(
            case_id="case-series-2",
            name="Case Series 2",
            source_file_path=ct,
            series_instance_uid="1.2.840.113619.2.2",
            study_instance_uid="1.2.840.113619.1.1",
        )
        assert created2 is True
        assert case1.id != case2.id


def test_create_case_from_job_no_autoseed_if_case_has_revisions(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    ct = _create_synthetic_ct(tmp_path / "ct.nii.gz")
    app = create_app(settings)

    with TestClient(app, headers={"Authorization": TEST_AUTH}) as client:
        # 1. Doctor uploads CT directly and creates rev 1 approved
        with ct.open("rb") as f:
            case_resp = client.post(
                "/api/v1/annotations/cases",
                data={"name": "Doctor Direct Case"},
                files={"file": ("ct.nii.gz", f, "application/gzip")},
            )
        assert case_resp.status_code == 201
        case_id = case_resp.json()["id"]

        mask_path = tmp_path / "doctor_mask.nii.gz"
        _create_mask(mask_path, nib.load(ct), pattern="box")
        with mask_path.open("rb") as f:
            client.post(
                f"/api/v1/annotations/cases/{case_id}/revisions",
                data={
                    "expected_revision": 0,
                    "status": "approved",
                    "reviewer": "Dr. Nam",
                    "reviewed_entire_volume": "true",
                },
                files={"file": ("doctor_mask.nii.gz", f, "application/gzip")},
            )

        # Verify case is now at rev 1 approved
        c_before = client.get(f"/api/v1/annotations/cases/{case_id}").json()
        assert c_before["current_revision"] == 1
        assert c_before["status"] == "approved"

        # 2. Run a job on the same CT
        job_id = _create_succeeded_job(app, settings, ct, volume_ml=1.2)

        # 3. Create case from this job_id (which deduplicates to the existing case)
        dedup_resp = client.post(
            "/api/v1/annotations/cases",
            data={"job_id": job_id},
        )
        assert dedup_resp.status_code in (200, 201)
        dedup_case = dedup_resp.json()
        assert dedup_case["id"] == case_id

        # MUST NOT auto-seed or destroy doctor's approved rev 1!
        c_after = client.get(f"/api/v1/annotations/cases/{case_id}").json()
        assert c_after["current_revision"] == 1
        assert c_after["status"] == "approved"


def test_save_revision_uncompressed_nii_and_error_codes(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    ct = _create_synthetic_ct(tmp_path / "ct.nii.gz")
    app = create_app(settings)

    with TestClient(app, headers={"Authorization": TEST_AUTH}) as client:
        with ct.open("rb") as f:
            case_id = client.post(
                "/api/v1/annotations/cases",
                data={"name": "Compression Test"},
                files={"file": ("ct.nii.gz", f, "application/gzip")},
            ).json()["id"]

        # Create uncompressed .nii mask
        mask_gz = tmp_path / "temp_mask.nii.gz"
        _create_mask(mask_gz, nib.load(ct), pattern="box")
        mask_raw = tmp_path / "uncompressed_mask.nii"
        nib.save(nib.load(mask_gz), mask_raw)

        # 1. Post uncompressed .nii mask -> accepted and compressed
        with mask_raw.open("rb") as f:
            resp = client.post(
                f"/api/v1/annotations/cases/{case_id}/revisions",
                data={"expected_revision": 0, "status": "draft"},
                files={"file": ("uncompressed_mask.nii", f, "application/octet-stream")},
            )
        assert resp.status_code == 201
        assert resp.json()["revision_number"] == 1

        # Check mask download returns 200
        mask_get = client.get(f"/api/v1/annotations/cases/{case_id}/revisions/1/mask")
        assert mask_get.status_code == 200

        # 2. Non-existent case -> 404
        with mask_gz.open("rb") as f:
            resp_404 = client.post(
                "/api/v1/annotations/cases/non-existent-case-id/revisions",
                data={"expected_revision": 0, "status": "draft"},
                files={"file": ("mask.nii.gz", f, "application/gzip")},
            )
        assert resp_404.status_code == 404

        # 3. Invalid status -> 422
        with mask_gz.open("rb") as f:
            resp_422 = client.post(
                f"/api/v1/annotations/cases/{case_id}/revisions",
                data={"expected_revision": 1, "status": "invalid_status"},
                files={"file": ("mask.nii.gz", f, "application/gzip")},
            )
        assert resp_422.status_code == 422


def test_pacs_annotation_inference_seed_flow(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    settings = dataclasses.replace(settings, inference_command="python -c ''")
    ct = _create_synthetic_ct(tmp_path / "ct.nii.gz")
    app = create_app(settings)

    with TestClient(app, headers={"Authorization": TEST_AUTH}) as client:
        # Create case from direct upload or PACS with specific series_instance_uid and study_instance_uid
        with ct.open("rb") as f:
            case_resp = client.post(
                "/api/v1/annotations/cases",
                data={
                    "name": "PACS Case",
                    "study_instance_uid": "1.2.840.1000",
                    "series_instance_uid": "1.2.840.2000",
                },
                files={"file": ("ct.nii.gz", f, "application/gzip")},
            )
        assert case_resp.status_code == 201
        case_id = case_resp.json()["id"]

        # Run inference on case -> creates job with study_id="series:1.2.840.2000" and dicom-source.json
        inf_resp = client.post(f"/api/v1/annotations/cases/{case_id}/inference?tier=fast", headers={"Authorization": "Basic YWRtaW46YWRtaW4xMjM="})
        assert inf_resp.status_code in (200, 202)
        job_id = inf_resp.json()["id"]

        # Stop worker so it does not race with test simulation
        app.state.worker.stop()
        job_paths = app.state.store.get_paths(job_id)
        assert job_paths is not None
        _create_mask(job_paths[1], nib.load(ct), pattern="box")
        app.state.store.finish(job_id, success=True, volume_ml=2.5)

        # Seed annotation from this job -> must SUCCEED with 201 (NOT fail with 422 wrong study)
        seed_resp = client.post(
            f"/api/v1/annotations/cases/{case_id}/seed",
            data={"job_id": job_id, "expected_revision": 0},
        )
        assert seed_resp.status_code == 201
        rev = seed_resp.json()
        assert rev["revision_number"] == 1
        assert rev["seed_job_id"] == job_id


def test_export_empty_returns_404(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    app = create_app(settings)
    with TestClient(app, headers={"Authorization": TEST_AUTH}) as client:
        resp = client.get("/api/v1/annotations/export")
        assert resp.status_code == 404
        assert "no approved" in resp.json()["detail"].lower()


def test_history_restore_uses_concurrency_token_and_records_displayed_parent_revision(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    ct = _create_synthetic_ct(tmp_path / "ct.nii.gz")
    app = create_app(settings)

    with TestClient(app, headers={"Authorization": TEST_AUTH}) as client:
        # Create case
        with ct.open("rb") as f:
            case_id = client.post(
                "/api/v1/annotations/cases",
                data={"name": "History Restore Test"},
                files={"file": ("ct.nii.gz", f, "application/gzip")},
            ).json()["id"]

        mask_p = tmp_path / "mask.nii.gz"
        _create_mask(mask_p, nib.load(ct), pattern="box")

        # Save rev 1 manual draft
        with mask_p.open("rb") as f:
            client.post(
                f"/api/v1/annotations/cases/{case_id}/revisions",
                data={"expected_revision": 0, "status": "draft", "reviewer": "Dr. A"},
                files={"file": ("mask.nii.gz", f, "application/gzip")},
            )

        # Seed rev 2 from AI job
        job_id = _create_succeeded_job(app, settings, ct, volume_ml=2.0, model_version="baseline-s-seed", inference_tier="standard")
        seed_resp = client.post(
            f"/api/v1/annotations/cases/{case_id}/seed",
            data={"job_id": job_id, "expected_revision": 1},
        )
        assert seed_resp.status_code == 201
        assert seed_resp.json()["revision_number"] == 2

        # Save rev 3 manual edit on top of rev 2
        with mask_p.open("rb") as f:
            r3_resp = client.post(
                f"/api/v1/annotations/cases/{case_id}/revisions",
                data={"expected_revision": 2, "status": "draft", "reviewer": "Dr. B"},
                files={"file": ("mask.nii.gz", f, "application/gzip")},
            )
        assert r3_resp.status_code == 201
        assert r3_resp.json()["revision_number"] == 3

        # Case current_revision is now 3.
        # Doctor views older revision 1, edits it, and saves as new revision.
        # 1. Sending old revision number as expected_revision MUST be rejected with 409 Conflict
        with mask_p.open("rb") as f:
            conflict_resp = client.post(
                f"/api/v1/annotations/cases/{case_id}/revisions",
                data={"expected_revision": 1, "base_revision": 1, "status": "draft", "reviewer": "Dr. C"},
                files={"file": ("mask.nii.gz", f, "application/gzip")},
            )
        assert conflict_resp.status_code == 409

        # 2. Sending case.current_revision (3) as expected_revision with base_revision=1
        # MUST succeed, create rev 4, set parent_revision=1, and inherit provenance from rev 1!
        with mask_p.open("rb") as f:
            restore_resp = client.post(
                f"/api/v1/annotations/cases/{case_id}/revisions",
                data={"expected_revision": 3, "base_revision": 1, "status": "draft", "reviewer": "Dr. C"},
                files={"file": ("mask.nii.gz", f, "application/gzip")},
            )
        assert restore_resp.status_code == 201
        rev4 = restore_resp.json()
        assert rev4["revision_number"] == 4
        assert rev4["parent_revision"] == 1
        assert rev4["seed_job_id"] is None  # Rev 1 was manual, so provenance from rev 1 is manual (None)


def test_invalid_history_parent_is_rejected_without_new_revision(tmp_path: Path) -> None:
    settings = _make_settings(tmp_path, direct_upload=True)
    ct = _create_synthetic_ct(tmp_path / 'ct.nii.gz')
    app = create_app(settings)
    with TestClient(app, headers={"Authorization": TEST_AUTH}) as client:
        with ct.open('rb') as f:
            case_id = client.post('/api/v1/annotations/cases', files={'file': ('ct.nii.gz', f, 'application/gzip')}).json()['id']
        mask = tmp_path / 'mask.nii.gz'
        _create_mask(mask, nib.load(ct), pattern='box')
        for parent in (-1, 1, 999):
            with mask.open('rb') as f:
                response = client.post(f'/api/v1/annotations/cases/{case_id}/revisions', data={'expected_revision': 0, 'base_revision': parent, 'status': 'draft'}, files={'file': ('mask.nii.gz', f, 'application/gzip')})
            assert response.status_code == 422
        assert client.get(f'/api/v1/annotations/cases/{case_id}').json()['current_revision'] == 0
