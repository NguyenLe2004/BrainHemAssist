from pathlib import Path
import zipfile

import nibabel as nib
import numpy as np
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.simulator import nifti_to_ct_series


def _settings(tmp_path: Path, enabled: bool = True) -> Settings:
    data = tmp_path / "data"
    return Settings(feedback_user_password="user123", feedback_admin_password="admin123", rbac_enabled=False, 
        data_dir=data,
        database_path=data / "app.sqlite3",
        inference_command="",
        inference_timeout_seconds=10,
        max_upload_bytes=8 * 1024 * 1024,
        retention_hours=1,
        worker_poll_seconds=0.01,
        direct_upload_enabled=enabled,
    )


def _dicom_series(tmp_path: Path) -> dict:
    source = tmp_path / "source.nii.gz"
    volume = np.full((16, 18, 5), -20, dtype=np.int16)
    volume[6:10, 7:11, 2:4] = 65
    nib.save(nib.Nifti1Image(volume, np.diag([0.8, 0.8, 3.0, 1.0])), source)
    return nifti_to_ct_series(
        source,
        tmp_path / "dicom",
        patient_id="EXT-001",
        patient_name="TEST^PATIENT",
    )


def test_upload_dicom_folder_creates_readable_case(tmp_path: Path) -> None:
    generated = _dicom_series(tmp_path)
    handles = [path.open("rb") for path in generated["paths"]]
    try:
        files = [
            ("files", (f"IM_{index:04d}.dcm", handle, "application/dicom"))
            for index, handle in enumerate(handles)
        ]
        with TestClient(create_app(_settings(tmp_path))) as client:
            response = client.post(
                "/api/v1/annotations/cases/dicom-upload",
                data={"priority": "stat", "clinical_indication": "Sudden weakness"},
                files=files,
            )
            assert response.status_code == 201, response.text
            case = response.json()
            assert case["source_type"] == "dicom_upload"
            assert case["patient_id"] == "EXT-001"
            assert case["patient_name"] == "TEST PATIENT"
            assert case["priority"] == "stat"
            assert case["clinical_indication"] == "Sudden weakness"
            assert case["study_instance_uid"] == generated["study_instance_uid"]
            source = client.get(f"/api/v1/annotations/cases/{case['id']}/source")
            assert source.status_code == 200
    finally:
        for handle in handles:
            handle.close()


def test_dicom_upload_respects_feature_flag(tmp_path: Path) -> None:
    with TestClient(create_app(_settings(tmp_path, enabled=False))) as client:
        response = client.post(
            "/api/v1/annotations/cases/dicom-upload",
            files={"files": ("image.dcm", b"not-used", "application/dicom")},
        )
    assert response.status_code == 403


def test_same_intake_accepts_one_nifti_case(tmp_path: Path) -> None:
    source = tmp_path / "external-case.nii.gz"
    volume = np.full((12, 14, 5), -30, dtype=np.int16)
    nib.save(nib.Nifti1Image(volume, np.diag([0.8, 0.8, 4.0, 1.0])), source)
    with TestClient(create_app(_settings(tmp_path))) as client, source.open("rb") as handle:
        response = client.post(
            "/api/v1/annotations/cases/dicom-upload",
            data={"priority": "urgent", "clinical_indication": "External NIfTI"},
            files={"files": (source.name, handle, "application/gzip")},
        )
    assert response.status_code == 201, response.text
    case = response.json()
    assert case["source_type"] == "nifti_upload"
    assert case["name"] == "external-case"
    assert case["geometry"]["shape"] == [12, 14, 5]


def test_same_intake_accepts_zip_with_nested_dicom(tmp_path: Path) -> None:
    generated = _dicom_series(tmp_path)
    archive_path = tmp_path / "study.zip"
    with zipfile.ZipFile(archive_path, "w") as archive:
        for path in generated["paths"]:
            archive.write(path, f"PATIENT/STUDY/SERIES/{path.name}")
    with TestClient(create_app(_settings(tmp_path))) as client, archive_path.open("rb") as handle:
        response = client.post(
            "/api/v1/annotations/cases/dicom-upload",
            files={"files": (archive_path.name, handle, "application/zip")},
        )
    assert response.status_code == 201, response.text
    assert response.json()["study_instance_uid"] == generated["study_instance_uid"]
