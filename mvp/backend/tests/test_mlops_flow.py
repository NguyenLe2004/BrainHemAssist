from __future__ import annotations

import json
import base64
from pathlib import Path

import nibabel as nib
import numpy as np
import pytest

from app.mlops_store import summarize_dataset_cases


def test_dataset_summary_separates_relabelled_cases_from_reference_cohorts() -> None:
    cases = [
        {"source": "labeling", "split": "train", "notes": "GT acceptance; NOT physician review"},
        {"source": "labeling", "split": "train", "notes": "replaced and compared with GT"},
        {"source": "reference-validation", "split": "validation"},
        {"source": "reference-test", "split": "test"},
    ]

    summary = summarize_dataset_cases(cases)

    assert summary["kind"] == "reviewed_label_snapshot"
    assert summary["reviewed_label_cases"] == 2
    assert summary["simulated_gt_review_cases"] == 2
    assert summary["review_method"] == "gt_simulation"
    assert summary["learning_from_labeling"] == 2
    assert summary["learning_from_import"] == 0
    assert summary["reference_validation_cases"] == 1
    assert summary["locked_test_cases"] == 1
    assert summary["trigger_source"] == "approved_labeling_revisions"
from fastapi.testclient import TestClient

from app.annotation_store import AnnotationStore
from app.mlops_store import MLOpsStore, WorkflowError
from app.store import JobStore
from app.config import Settings
from app.main import create_app
from app.reviewer_auth import password_record


def _volume(path: Path, mask: bool = False) -> None:
    data = np.zeros((8, 8, 4), dtype=np.uint8 if mask else np.int16)
    if mask:
        data[2:5, 2:5, 1:3] = 1
    nib.save(nib.Nifti1Image(data, np.eye(4)), path)


def test_controlled_learning_to_frozen_dataset(tmp_path: Path) -> None:
    database = tmp_path / "brainhem.sqlite3"
    jobs = JobStore(database, tmp_path / "jobs")
    annotations = AnnotationStore(database, tmp_path / "annotations")
    mlops = MLOpsStore(database, tmp_path / "mlops")
    jobs.initialize("test-model")
    annotations.initialize()
    mlops.initialize()

    job_id = "job-learning-1"
    job_dir = tmp_path / "jobs" / job_id
    job_dir.mkdir(parents=True)
    source, mask = job_dir / "input.nii.gz", job_dir / "mask.nii.gz"
    _volume(source); _volume(mask, mask=True)
    job = jobs.create(job_id, "case.nii.gz", "nifti", source.stat().st_size,
                      source, mask, model_version="model-v1")
    jobs.finish(job.id, True, volume_ml=1.0, inference_metadata={"confidence": 0.4})
    job = jobs.get(job_id)

    case, _ = annotations.create_case("case-1", "Learning case", source, patient_id="patient-1")
    approved = annotations.save_revision(case.id, mask, "approved", 0, "Dr Label",
                                         reviewed_entire_volume=True)
    candidate = mlops.create_candidate(job=job, assessment="incorrect",
                                       reasons=["false_negative"], priority="critical",
                                       note="missed lesion", created_by="Dr Reader",
                                       annotation_case_id=case.id)
    mlops.add_review(candidate["id"], "Dr Peer", "positive", "ICH", "IPH", "confirmed")
    gold = mlops.adjudicate(candidate["id"], "gold", "Dr Senior", case.id,
                            approved.revision_number, "consensus")
    assert gold["status"] == "gold"
    assert gold["gold_label"]["revision_number"] == approved.revision_number

    dataset = mlops.create_dataset("ICH", "1.0.0", "ML Lead", .7, .15, "frozen test")
    assert dataset["status"] == "frozen"
    assert dataset["num_cases"] == 1
    assert Path(dataset["artifact_path"]).is_file()
    assert len(dataset["artifact_sha256"]) == 64
    assert dataset["manifest"]["cases"][0]["annotation_case_id"] == case.id


def test_training_requires_real_runner_artifact_contract(tmp_path: Path) -> None:
    database = tmp_path / "brainhem.sqlite3"
    mlops = MLOpsStore(database, tmp_path / "mlops")
    # Minimal referenced frozen dataset for store-level contract test.
    mlops.initialize()
    artifact = tmp_path / "dataset.zip"
    artifact.write_bytes(b"dataset")
    now = "2026-01-01T00:00:00+00:00"
    with mlops._connect() as db:
        db.execute("""INSERT INTO dataset_versions
            (id,name,version,description,status,artifact_path,artifact_sha256,manifest_json,num_cases,created_by,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)""", (
            "ds-1", "ICH", "1", "", "frozen", str(artifact), "sha", json.dumps({}), 1, "lead", now
        ))
    run = mlops.create_run("ds-1", "full_retrain", "candidate-v2", "engineer", None, {"epochs": 1})
    output = Path(run["output_dir"])
    model = output / "model.pt"
    model.write_bytes(b"real checkpoint bytes")
    mlops.finish_training(run["id"], {"model_path": str(model), "metrics": {"loss": 0.25}})
    completed = mlops.get_run(run["id"])
    registered = mlops.get_model(completed["model_id"])
    assert completed["status"] == "succeeded"
    assert registered["stage"] == "candidate"
    assert registered["artifact_sha256"]

    # Promotion is gated by measured validation, two approvals, real deployment
    # stage order, and an immutable prospective shadow report.
    mlops.finish_validation(run["id"], {"metrics": {"mean_dice": .75, "lesion_recall": .96}})
    mlops.approve_model(registered["id"], "clinical", "approved", "Dr Clinical", "ok")
    mlops.approve_model(registered["id"], "qa", "approved", "QA Lead", "ok")
    shadow = mlops.transition_model(registered["id"], "shadow", "Release Lead", "shadow")
    assert shadow["stage"] == "shadow"
    mlops.record_deployment(
        registered["id"], "triton", "baseline_s", "2", registered["artifact_sha256"]
    )
    report = tmp_path / "shadow.json"
    report.write_text(json.dumps({"num_studies": 25, "metrics": {"lesion_recall": .95}}))
    evidence = mlops.add_shadow_evidence(registered["id"], report, "Monitor", "prospective")
    assert evidence["report_sha256"]
    production = mlops.transition_model(registered["id"], "production", "Release Lead", "promote")
    assert production["stage"] == "production"
    assert mlops.get_runtime_setting("production_triton_version") == "2"


def test_independent_validation_must_pass_all_quality_gates(tmp_path: Path) -> None:
    database = tmp_path / "brainhem.sqlite3"
    mlops = MLOpsStore(database, tmp_path / "mlops")
    mlops.initialize()
    artifact = tmp_path / "dataset.zip"; artifact.write_bytes(b"dataset")
    evaluation = tmp_path / "holdout.zip"; evaluation.write_bytes(b"holdout")
    now = "2026-01-01T00:00:00+00:00"
    with mlops._connect() as db:
        db.execute("""INSERT INTO dataset_versions
            (id,name,version,description,status,artifact_path,artifact_sha256,manifest_json,num_cases,created_by,created_at,evaluation_path,evaluation_sha256)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            ("ds-gate", "ICH", "1", "", "frozen", str(artifact), "sha", "{}", 20, "lead", now,
             str(evaluation), "holdout-sha"))
    run = mlops.create_run("ds-gate", "full_retrain", "candidate", "engineer", None,
                           {"quality_gate_dice": .5, "quality_gate_recall": .8})
    model_path = Path(run["output_dir"]) / "model.pt"; model_path.write_bytes(b"checkpoint")
    mlops.finish_training(run["id"], {"model_path": str(model_path), "metrics": {"quality_gate": {"dice": .5, "recall": .8}}})
    mlops.finish_validation(run["id"], {"metrics": {"mean_dice": .72, "lesion_recall": .61}})
    failed = mlops.get_run(run["id"])
    assert failed["status"] == "failed"
    assert failed["metrics"]["validation_gate"]["passed"] is False
    assert mlops.get_model(failed["model_id"])["stage"] == "candidate"


def test_flag_endpoint_authenticates_reader_and_preserves_ai_seed(tmp_path: Path) -> None:
    password = "long-clinical-password"
    accounts = tmp_path / "reviewers.json"
    accounts.write_text(json.dumps({"dr-reader": password_record(password)}))
    data = tmp_path / "data"
    settings = Settings(feedback_user_password="user123", feedback_admin_password="admin123", rbac_enabled=False, data_dir=data, database_path=data / "db.sqlite3", inference_command="",
                        inference_timeout_seconds=10, max_upload_bytes=10_000_000,
                        retention_hours=1, worker_poll_seconds=.1,
                        reviewer_accounts_file=str(accounts), direct_upload_enabled=True)
    source = tmp_path / "source.nii.gz"; mask = tmp_path / "mask.nii.gz"
    _volume(source); _volume(mask, mask=True)
    auth = "Basic " + base64.b64encode(f"dr-reader:{password}".encode()).decode()
    app = create_app(settings)
    with TestClient(app) as client:
        app.state.worker.stop()
        with source.open("rb") as stream:
            job = client.post("/api/v1/jobs", files={"file": ("source.nii.gz", stream, "application/gzip")}).json()
        paths = app.state.store.get_paths(job["id"])
        paths[1].write_bytes(mask.read_bytes())
        app.state.store.finish(job["id"], True, volume_ml=1.0)
        unauthenticated = client.post("/api/v1/learning/candidates", json={
            "job_id": job["id"], "assessment": "incorrect", "reasons": ["false_negative"]
        })
        assert unauthenticated.status_code == 401
        flagged = client.post("/api/v1/learning/candidates", headers={"Authorization": auth}, json={
            "job_id": job["id"], "assessment": "incorrect", "reasons": ["false_negative"],
            "priority": "critical", "created_by": "spoofed-name"
        })
        assert flagged.status_code == 201, flagged.text
        payload = flagged.json()
        assert payload["created_by"] == "dr-reader"
        assert payload["annotation_case_id"]
        revisions = client.get(f"/api/v1/annotations/cases/{payload['annotation_case_id']}/revisions").json()["items"]
        assert revisions[0]["seed_job_id"] == job["id"]


def test_learning_list_contains_reviews_and_enforces_ordered_transitions(tmp_path: Path) -> None:
    database = tmp_path / "brainhem.sqlite3"
    jobs = JobStore(database, tmp_path / "jobs")
    annotations = AnnotationStore(database, tmp_path / "annotations")
    mlops = MLOpsStore(database, tmp_path / "mlops")
    jobs.initialize("test-model")
    annotations.initialize()
    mlops.initialize()
    job_dir = tmp_path / "jobs" / "job-1"; job_dir.mkdir(parents=True)
    source, mask = job_dir / "input.nii.gz", job_dir / "mask.nii.gz"
    _volume(source); _volume(mask, mask=True)
    job = jobs.create("job-1", "case.nii.gz", "nifti", source.stat().st_size, source, mask, model_version="v1")
    jobs.finish(job.id, True, volume_ml=1.0)
    candidate = mlops.create_candidate(job=jobs.get(job.id), assessment="incorrect",
                                       reasons=["false_positive"], priority="high", note="x",
                                       created_by="reader", annotation_case_id=None)
    mlops.add_review(candidate["id"], "peer", "negative", "", "", "confirmed")
    listed = mlops.list_candidates()[0]
    assert len(listed["reviews"]) == 1
    assert listed["reviews"][0]["reviewer"] == "peer"
    with pytest.raises(WorkflowError, match="Transition peer_review -> flagged"):
        mlops.update_candidate(candidate["id"], "flagged", "reader", None, "")


def test_training_input_validation_rejects_blank_names_and_unknown_base(tmp_path: Path) -> None:
    mlops = MLOpsStore(tmp_path / "brainhem.sqlite3", tmp_path / "mlops")
    mlops.initialize()
    artifact = tmp_path / "dataset.zip"; artifact.write_bytes(b"dataset")
    now = "2026-01-01T00:00:00+00:00"
    with mlops._connect() as db:
        db.execute("""INSERT INTO dataset_versions
            (id,name,version,description,status,artifact_path,artifact_sha256,manifest_json,num_cases,created_by,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)""", ("ds-1", "ICH", "1", "", "frozen", str(artifact), "sha", "{}", 1, "lead", now))
    with pytest.raises(WorkflowError, match="name cannot be empty"):
        mlops.create_run("ds-1", "experiment", "   ", "engineer", None, {})
    with pytest.raises(WorkflowError, match="Base model does not exist"):
        mlops.create_run("ds-1", "fine_tune", "candidate", "engineer", "missing", {})
    with pytest.raises(WorkflowError, match="requires a base model"):
        mlops.create_run("ds-1", "postprocess_calibration", "calibrate", "engineer", None, {})

    root_run = mlops.create_run("ds-1", "full_retrain", "original", "engineer", None, {})
    root_artifact = Path(root_run["output_dir"]) / "model.pt"
    root_artifact.write_bytes(b"original checkpoint")
    mlops.finish_training(root_run["id"], {"model_path": str(root_artifact), "metrics": {}})
    root_model_id = mlops.get_run(root_run["id"])["model_id"]
    child_run = mlops.create_run("ds-1", "fine_tune", "candidate-child", "engineer", root_model_id, {})
    child_artifact = Path(child_run["output_dir"]) / "model.pt"
    child_artifact.write_bytes(b"candidate checkpoint")
    mlops.finish_training(child_run["id"], {"model_path": str(child_artifact), "metrics": {}})
    child_model_id = mlops.get_run(child_run["id"])["model_id"]
    chained = mlops.create_run("ds-1", "fine_tune", "next-generation", "engineer", child_model_id, {"model_variant":"S"})
    assert chained["base_model_id"] == child_model_id
    assert chained["status"] == "queued"
