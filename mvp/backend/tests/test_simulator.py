from __future__ import annotations

import base64
import dataclasses
import json
from pathlib import Path

import nibabel as nib
import numpy as np
import pydicom
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.reviewer_auth import password_record
from app.simulator import nifti_to_ct_series


def _image(path: Path) -> bytes:
    volume = np.full((12, 14, 3), -20, dtype=np.int16)
    volume[4:8, 5:9, 1] = 65
    nib.save(nib.Nifti1Image(volume, np.diag([0.8, 0.8, 3.0, 1.0])), path)
    return path.read_bytes()


def _settings(tmp_path: Path, enabled: bool) -> Settings:
    data = tmp_path / "data"
    return Settings(feedback_user_password="user123", feedback_admin_password="admin123", rbac_enabled=False, 
        data_dir=data,
        database_path=data / "jobs.sqlite3",
        inference_command="",
        inference_timeout_seconds=10,
        max_upload_bytes=1024 * 1024,
        retention_hours=24,
        worker_poll_seconds=0.01,
        orthanc_url="http://orthanc.test",
        dicom_enabled=True,
        simulator_enabled=enabled,
    )


def test_generates_anonymized_ct_dicom_geometry(tmp_path: Path) -> None:
    source = tmp_path / "source.nii"
    _image(source)
    result = nifti_to_ct_series(
        source,
        tmp_path / "dicom",
        patient_id="ANON-UNIT-001",
        patient_name="ANONYMOUS^SIMULATOR",
    )
    assert result["slices"] == 3
    paths = result["paths"]
    assert len(paths) == 3
    first = pydicom.dcmread(paths[0])
    assert first.Modality == "CT"
    assert first.PatientID == "ANON-UNIT-001"
    assert first.PatientName == "ANONYMOUS^SIMULATOR"
    assert first.SeriesDescription == "Head NCCT Brain"
    assert [float(value) for value in first.PixelSpacing] == pytest.approx([0.8, 0.8])
    assert float(first.SliceThickness) == 3.0
    assert first.StudyInstanceUID == result["study_instance_uid"]


def test_simulator_endpoint_sends_c_store(monkeypatch, tmp_path: Path) -> None:
    sent: dict = {}

    def fake_send(path: Path, **kwargs) -> None:
        sent["count"] = len(list(path.glob("*.dcm")))
        sent.update(kwargs)

    monkeypatch.setattr("app.main.send_c_store", fake_send)
    content = _image(tmp_path / "fixture.nii")
    with TestClient(create_app(_settings(tmp_path, True))) as client:
        response = client.post(
            "/api/v1/simulator/acquisitions",
            data={"patient_id": "anon-demo-007"},
            files={"file": ("fixture.nii", content, "application/octet-stream")},
        )
    assert response.status_code == 201
    payload = response.json()
    assert payload["status"] == "stored"
    assert payload["patient_id"] == "ANON-DEMO-007"
    assert payload["instances_sent"] == 3
    assert payload["calling_aet"] == "CT_SIMULATOR"
    assert payload["called_aet"] == "BRAINHEM_PACS"
    assert sent["count"] == 3
    assert not list((tmp_path / "data" / "simulator").glob("*"))


def test_simulator_is_separate_and_requires_anonymized_id(tmp_path: Path) -> None:
    content = _image(tmp_path / "fixture.nii")
    with TestClient(create_app(_settings(tmp_path, False))) as client:
        disabled = client.post(
            "/api/v1/simulator/acquisitions",
            data={"patient_id": "ANON-DEMO-001"},
            files={"file": ("fixture.nii", content, "application/octet-stream")},
        )
    assert disabled.status_code == 404

    with TestClient(create_app(_settings(tmp_path, True))) as client:
        phi_like = client.post(
            "/api/v1/simulator/acquisitions",
            data={"patient_id": "NGUYEN-VAN-A"},
            files={"file": ("fixture.nii", content, "application/octet-stream")},
        )
    assert phi_like.status_code == 422


def test_studio_policy_selects_model_and_auto_queues_uploaded_ct(tmp_path: Path) -> None:
    password = "automation-test-password"
    accounts = tmp_path / "reviewers.json"
    accounts.write_text(json.dumps({"mlops-admin": password_record(password)}))
    auth = "Basic " + base64.b64encode(f"mlops-admin:{password}".encode()).decode()
    configured = dataclasses.replace(
        _settings(tmp_path, True),
        orthanc_url="",
        dicom_enabled=False,
        direct_upload_enabled=True,
        inference_command="false",
        reviewer_accounts_file=str(accounts),
        feedback_admin_username="mlops-admin",
        feedback_admin_password=password,
    )
    content = _image(tmp_path / "auto-fixture.nii")
    with TestClient(create_app(configured)) as client:
        saved = client.put(
            "/api/v1/mlops/automation",
            headers={"Authorization": auth},
            json={"auto_analyze_ct": True, "inference_tier": "fast", "extension_enabled": False},
        )
        assert saved.status_code == 200
        assert client.get("/api/v1/mlops/automation").json()["inference_tier"] == "fast"
        received = client.post(
            "/api/v1/simulator/acquisitions",
            data={"patient_id": "ANON-AUTO-001"},
            files={"file": ("auto-fixture.nii", content, "application/octet-stream")},
        )
        assert received.status_code == 201
        payload = received.json()
        assert payload["transmission_mode"] == "local_dicom_gateway"
        assert payload["auto_inference"]["tier"] == "fast"
        assert payload["annotation_case_id"]
