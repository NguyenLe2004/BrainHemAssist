from __future__ import annotations

import hashlib
import json
import os
import shlex
import shutil
import sqlite3
import subprocess
from .gpu_admission import gpu_slot
import threading
import time
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import Settings


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _row(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    result = dict(row)
    for key in ("reasons_json", "prediction_json", "config_json", "metrics_json", "manifest_json"):
        if key in result:
            try:
                result[key.removesuffix("_json")] = json.loads(result.pop(key) or "{}")
            except json.JSONDecodeError:
                result[key.removesuffix("_json")] = {}
    return result


def summarize_dataset_cases(cases: list[dict[str, Any]] | None) -> dict[str, Any]:
    """Describe what a frozen dataset contains without conflating provenance with learning data.

    A public cohort can be the origin of a patient case and still not be a
    training source. Cases that travelled through Expert Labeling are marked
    ``source=labeling`` in the immutable manifest. Other cases are reference
    cohorts used for validation or the locked quality test.
    """
    rows = cases if isinstance(cases, list) else []
    reviewed = [case for case in rows if case.get("source") == "labeling"]
    references = [case for case in rows if case.get("source") != "labeling"]
    simulated = [
        case for case in reviewed
        if "not physician review" in str(case.get("notes", "")).lower()
        or "gt acceptance" in str(case.get("notes", "")).lower()
        or "replaced and compared with" in str(case.get("notes", "")).lower()
    ]
    split_count = lambda items, split: sum(case.get("split") == split for case in items)
    return {
        "kind": "reviewed_label_snapshot" if reviewed else "imported_dataset",
        "reviewed_label_cases": len(reviewed),
        "simulated_gt_review_cases": len(simulated),
        "review_method": "gt_simulation" if reviewed and len(simulated) == len(reviewed) else "reviewed_workflow",
        "learning_cases": split_count(rows, "train"),
        "learning_from_labeling": split_count(reviewed, "train"),
        "learning_from_import": split_count(references, "train"),
        "labeling_validation_cases": split_count(reviewed, "validation"),
        "reference_validation_cases": split_count(references, "validation"),
        "locked_test_cases": split_count(rows, "test"),
        "reference_cases": len(references),
        "total_packaged_cases": len(rows),
        "trigger_source": "approved_labeling_revisions",
    }


def _with_dataset_semantics(item: dict[str, Any] | None) -> dict[str, Any] | None:
    if not item:
        return item
    manifest = item.get("manifest") if isinstance(item.get("manifest"), dict) else {}
    item["cohort_summary"] = summarize_dataset_cases(manifest.get("cases"))
    return item


def _with_live_progress(item: dict[str, Any] | None) -> dict[str, Any] | None:
    """Attach runner progress without persisting noisy per-epoch updates."""
    if not item:
        return item
    item["monitor_url"] = f"/model-studio?monitor={item['id']}"
    if item.get("mode")=="postprocess_calibration":
        report_path=Path(str(item.get("output_dir","")))/"postprocess-search.json"
        try:
            if report_path.stat().st_size < 2_000_000:
                report=json.loads(report_path.read_text(encoding="utf-8"))
                item["metrics"]={**(item.get("metrics") or {}),"postprocess_search":report}
                if item.get("status")=="failed" and report.get("selection_status")=="no_feasible_configuration":
                    required=report["constraints"]
                    item["error"]=(f"Không có cấu hình postprocess đạt lesion recall ≥ {required['minimum_lesion_recall']:.2f} "
                                   f"và FP volume ≤ {required['maximum_mean_false_positive_volume_mm3']:g} mm³. Không tạo model mới.")
        except (OSError, ValueError, KeyError, TypeError):
            pass
    if item.get("status") not in {"running", "validating"}:
        return item
    path = Path(str(item.get("output_dir", ""))) / "progress.json"
    try:
        progress = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return item
    metrics = dict(item.get("metrics") or {})
    metrics.update({"history": progress.get("history", metrics.get("history", {})),
                    "device": progress.get("device", metrics.get("device")),
                    "training_cases": progress.get("training_cases", metrics.get("training_cases")),
                    "validation_cases": progress.get("validation_cases", metrics.get("validation_cases")),
                    "live_progress": progress})
    item["metrics"] = metrics
    return item


def _active_learning_signal(item: dict[str, Any]) -> dict[str, Any]:
    """Build an explainable queue score from evidence already stored with a case."""
    prediction = item.get("prediction") if isinstance(item.get("prediction"), dict) else {}
    result = prediction.get("result") if isinstance(prediction.get("result"), dict) else {}
    inference = result.get("inference") if isinstance(result.get("inference"), dict) else {}
    try:
        confidence = max(0.0, min(1.0, float(inference.get("confidence"))))
    except (TypeError, ValueError):
        confidence = 0.5
    try:
        volume_ml = max(0.0, float(result.get("hemorrhage_volume_ml", 0.0)))
    except (TypeError, ValueError):
        volume_ml = 0.0

    uncertainty = 1.0 - confidence
    if 0 < volume_ml <= 1:
        small_lesion = 1.0
    elif volume_ml <= 5:
        small_lesion = 0.65
    elif volume_ml <= 10:
        small_lesion = 0.3
    else:
        small_lesion = 0.05
    difficulty = {"correct": 0.0, "partially_correct": 0.55, "incorrect": 1.0, "difficult": 0.9}.get(
        str(item.get("assessment")), 0.4
    )
    priority = {"low": 0.1, "medium": 0.35, "high": 0.7, "critical": 1.0}.get(
        str(item.get("priority")), 0.35
    )
    reasons = {str(value).lower() for value in (item.get("reasons") or [])}
    valuable_reasons = {
        "model_disagreement", "boundary_uncertainty", "small_lesion", "rare_pattern",
        "false_positive", "false_negative", "missed_lesion", "difficult_case",
    }
    reason_signal = 1.0 if reasons & valuable_reasons else (0.2 if reasons else 0.0)
    score = round(100 * (0.45 * uncertainty + 0.20 * difficulty + 0.15 * small_lesion
                         + 0.15 * reason_signal + 0.05 * priority))
    explanations: list[str] = []
    if uncertainty >= 0.25:
        explanations.append("AI chưa chắc chắn")
    if small_lesion >= 0.65:
        explanations.append("Ổ nhỏ, dễ bỏ sót")
    if difficulty >= 0.8:
        explanations.append("Ca khó / dự đoán sai")
    elif difficulty >= 0.5:
        explanations.append("Mask cần bác sĩ chỉnh")
    if reason_signal >= 1:
        explanations.append("Tín hiệu bất đồng hoặc hiếm")
    if not explanations:
        explanations.append("Bổ sung độ phủ dữ liệu")
    return {
        "score": score,
        "band": "high" if score >= 35 else "medium" if score >= 20 else "low",
        "confidence": round(confidence, 4),
        "uncertainty_proxy": round(uncertainty, 4),
        "volume_ml": round(volume_ml, 3),
        "strategy": "hybrid-clinical-proxy-v1",
        "explanations": explanations[:2],
        "weights": {"uncertainty": 0.45, "difficulty": 0.20, "small_lesion": 0.15,
                    "learning_reason": 0.15, "clinical_priority": 0.05},
    }


class WorkflowError(ValueError):
    pass


class MLOpsStore:
    CANDIDATE_STATES = {"flagged", "triaged", "annotation", "peer_review", "adjudication", "gold", "excluded"}
    ASSESSMENTS = {"correct", "partially_correct", "incorrect", "difficult"}
    PRIORITIES = {"low", "medium", "high", "critical"}
    MODES = {"fine_tune", "full_retrain", "experiment", "site_adaptation", "postprocess_calibration"}

    def __init__(self, database_path: Path, root: Path) -> None:
        self.database_path = database_path
        self.root = root

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def initialize(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS learning_candidates (
                  id TEXT PRIMARY KEY, job_id TEXT UNIQUE, annotation_case_id TEXT,
                  assessment TEXT NOT NULL, reasons_json TEXT NOT NULL, priority TEXT NOT NULL,
                  status TEXT NOT NULL, created_by TEXT NOT NULL, assigned_to TEXT, note TEXT,
                  model_version TEXT, prediction_json TEXT NOT NULL, created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL, FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE SET NULL,
                  FOREIGN KEY(annotation_case_id) REFERENCES annotation_cases(id) ON DELETE SET NULL
                );
                CREATE TABLE IF NOT EXISTS peer_reviews (
                  id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, reviewer TEXT NOT NULL,
                  verdict TEXT NOT NULL, diagnosis TEXT, subtype TEXT, note TEXT, created_at TEXT NOT NULL,
                  FOREIGN KEY(candidate_id) REFERENCES learning_candidates(id) ON DELETE CASCADE,
                  UNIQUE(candidate_id, reviewer)
                );
                CREATE TABLE IF NOT EXISTS gold_labels (
                  candidate_id TEXT PRIMARY KEY, annotation_case_id TEXT NOT NULL, revision_number INTEGER NOT NULL,
                  adjudicator TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL,
                  FOREIGN KEY(candidate_id) REFERENCES learning_candidates(id) ON DELETE RESTRICT,
                  FOREIGN KEY(annotation_case_id) REFERENCES annotation_cases(id) ON DELETE RESTRICT
                );
                CREATE TABLE IF NOT EXISTS dataset_versions (
                  id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL, description TEXT,
                  status TEXT NOT NULL, artifact_path TEXT NOT NULL, artifact_sha256 TEXT NOT NULL,
                  manifest_json TEXT NOT NULL, num_cases INTEGER NOT NULL, created_by TEXT NOT NULL,
                  created_at TEXT NOT NULL, evaluation_path TEXT NOT NULL DEFAULT '',
                  evaluation_sha256 TEXT NOT NULL DEFAULT '', UNIQUE(name, version)
                );
                CREATE TABLE IF NOT EXISTS training_runs (
                  id TEXT PRIMARY KEY, dataset_version_id TEXT NOT NULL, mode TEXT NOT NULL, name TEXT NOT NULL,
                  base_model_id TEXT, config_json TEXT NOT NULL, status TEXT NOT NULL, created_by TEXT NOT NULL,
                  output_dir TEXT NOT NULL, log_path TEXT NOT NULL, error TEXT, metrics_json TEXT,
                  model_id TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL,
                  FOREIGN KEY(dataset_version_id) REFERENCES dataset_versions(id) ON DELETE RESTRICT
                );
                CREATE TABLE IF NOT EXISTS model_versions (
                  id TEXT PRIMARY KEY, name TEXT NOT NULL, training_run_id TEXT NOT NULL UNIQUE,
                  parent_model_id TEXT, artifact_path TEXT NOT NULL, artifact_sha256 TEXT NOT NULL,
                  stage TEXT NOT NULL, metrics_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                  FOREIGN KEY(training_run_id) REFERENCES training_runs(id) ON DELETE RESTRICT
                );
                CREATE TABLE IF NOT EXISTS model_approvals (
                  id TEXT PRIMARY KEY, model_id TEXT NOT NULL, gate TEXT NOT NULL, decision TEXT NOT NULL,
                  approver TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL,
                  FOREIGN KEY(model_id) REFERENCES model_versions(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS model_transitions (
                  id TEXT PRIMARY KEY, model_id TEXT NOT NULL, from_stage TEXT NOT NULL, to_stage TEXT NOT NULL,
                  actor TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL,
                  FOREIGN KEY(model_id) REFERENCES model_versions(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS shadow_evidence (
                  id TEXT PRIMARY KEY, model_id TEXT NOT NULL, report_path TEXT NOT NULL,
                  report_sha256 TEXT NOT NULL, summary_json TEXT NOT NULL, assessor TEXT NOT NULL,
                  note TEXT, created_at TEXT NOT NULL,
                  FOREIGN KEY(model_id) REFERENCES model_versions(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS model_deployments (
                  id TEXT PRIMARY KEY, model_id TEXT NOT NULL, backend TEXT NOT NULL,
                  serving_name TEXT NOT NULL, serving_version TEXT NOT NULL, artifact_sha256 TEXT NOT NULL,
                  status TEXT NOT NULL, created_at TEXT NOT NULL,
                  FOREIGN KEY(model_id) REFERENCES model_versions(id) ON DELETE RESTRICT,
                  UNIQUE(backend, serving_name, serving_version)
                );
                CREATE TABLE IF NOT EXISTS runtime_settings (
                  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS ix_learning_status ON learning_candidates(status, priority, updated_at);
                CREATE UNIQUE INDEX IF NOT EXISTS ux_peer_reviewer ON peer_reviews(candidate_id, reviewer);
                CREATE INDEX IF NOT EXISTS ix_runs_status ON training_runs(status, created_at);
                CREATE INDEX IF NOT EXISTS ix_models_stage ON model_versions(stage, updated_at);
                """
            )
            dataset_columns = {row[1] for row in db.execute("PRAGMA table_info(dataset_versions)").fetchall()}
            if "evaluation_path" not in dataset_columns:
                db.execute("ALTER TABLE dataset_versions ADD COLUMN evaluation_path TEXT NOT NULL DEFAULT ''")
            if "evaluation_sha256" not in dataset_columns:
                db.execute("ALTER TABLE dataset_versions ADD COLUMN evaluation_sha256 TEXT NOT NULL DEFAULT ''")
            db.execute("""UPDATE training_runs SET status=CASE status
                WHEN 'running' THEN 'queued' WHEN 'validating' THEN 'validation_queued' ELSE status END,
                updated_at=? WHERE status IN ('running','validating')""", (_now(),))

    def create_candidate(self, *, job: Any, assessment: str, reasons: list[str], priority: str,
                         note: str, created_by: str, annotation_case_id: str | None = None) -> dict[str, Any]:
        if assessment not in self.ASSESSMENTS:
            raise WorkflowError("Invalid assessment")
        if priority not in self.PRIORITIES:
            raise WorkflowError("Invalid priority")
        if not reasons and assessment != "correct":
            raise WorkflowError("At least one learning reason is required")
        candidate_id, now = str(uuid.uuid4()), _now()
        prediction = {"result": job.result, "artifacts": job.artifacts, "inference_tier": job.inference_tier}
        with self._connect() as db:
            try:
                db.execute(
                    "INSERT INTO learning_candidates VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (candidate_id, job.id, annotation_case_id, assessment, json.dumps(sorted(set(reasons))), priority,
                     "flagged", created_by.strip(), "", note.strip(), job.model_version,
                     json.dumps(prediction), now, now),
                )
            except sqlite3.IntegrityError as exc:
                raise WorkflowError("This inference job is already in the learning queue") from exc
        return self.get_candidate(candidate_id)  # type: ignore[return-value]

    def list_candidates(self, status: str | None = None) -> list[dict[str, Any]]:
        query = "SELECT * FROM learning_candidates"
        params: tuple[Any, ...] = ()
        if status:
            query += " WHERE status = ?"
            params = (status,)
        query += " ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, updated_at DESC"
        with self._connect() as db:
            items = [_row(item) for item in db.execute(query, params).fetchall()]
            for item in items:
                item["reviews"] = [dict(review) for review in db.execute(
                    "SELECT * FROM peer_reviews WHERE candidate_id=? ORDER BY created_at",
                    (item["id"],),
                ).fetchall()]
                item["gold_label"] = _row(db.execute(
                    "SELECT * FROM gold_labels WHERE candidate_id=?", (item["id"],)
                ).fetchone())
                item["annotation"] = _row(db.execute(
                    "SELECT id,name,status,current_revision,latest_approved_revision "
                    "FROM annotation_cases WHERE id=?", (item["annotation_case_id"],)
                ).fetchone()) if item.get("annotation_case_id") else None
                item["active_learning"] = _active_learning_signal(item)
            items.sort(key=lambda value: (
                value.get("status") in {"gold", "excluded"},
                -int(value.get("active_learning", {}).get("score", 0)),
                str(value.get("updated_at", "")),
            ))
            return items  # type: ignore[return-value]

    def get_candidate(self, candidate_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            item = _row(db.execute("SELECT * FROM learning_candidates WHERE id=?", (candidate_id,)).fetchone())
            if item:
                item["reviews"] = [dict(r) for r in db.execute(
                    "SELECT * FROM peer_reviews WHERE candidate_id=? ORDER BY created_at", (candidate_id,)
                ).fetchall()]
                item["gold_label"] = _row(db.execute(
                    "SELECT * FROM gold_labels WHERE candidate_id=?", (candidate_id,)
                ).fetchone())
                item["annotation"] = _row(db.execute(
                    "SELECT id,name,status,current_revision,latest_approved_revision "
                    "FROM annotation_cases WHERE id=?", (item["annotation_case_id"],)
                ).fetchone()) if item.get("annotation_case_id") else None
                item["active_learning"] = _active_learning_signal(item)
            return item

    def update_candidate(self, candidate_id: str, status: str, assigned_to: str,
                         annotation_case_id: str | None, note: str) -> dict[str, Any]:
        if status not in self.CANDIDATE_STATES - {"gold"}:
            raise WorkflowError("Invalid candidate state; use adjudication to create a gold label")
        with self._connect() as db:
            current = db.execute("SELECT status FROM learning_candidates WHERE id=?", (candidate_id,)).fetchone()
            if not current:
                raise KeyError(candidate_id)
            if current["status"] in {"gold", "excluded"}:
                raise WorkflowError("Finalized candidates cannot be changed")
            allowed = {
                "flagged": {"triaged", "annotation"},
                "triaged": {"annotation"},
                "annotation": {"peer_review"},
                "peer_review": {"annotation", "adjudication"},
                "adjudication": {"annotation", "peer_review"},
            }
            if status != current["status"] and status not in allowed.get(current["status"], set()):
                raise WorkflowError(f"Transition {current['status']} -> {status} is not allowed")
            db.execute(
                "UPDATE learning_candidates SET status=?,assigned_to=?,annotation_case_id=COALESCE(?,annotation_case_id),note=?,updated_at=? WHERE id=?",
                (status, assigned_to.strip(), annotation_case_id, note.strip(), _now(), candidate_id),
            )
        return self.get_candidate(candidate_id)  # type: ignore[return-value]

    def add_review(self, candidate_id: str, reviewer: str, verdict: str, diagnosis: str,
                   subtype: str, note: str) -> dict[str, Any]:
        if verdict not in {"positive", "negative", "uncertain", "artifact"}:
            raise WorkflowError("Invalid peer-review verdict")
        with self._connect() as db:
            candidate = db.execute("SELECT status FROM learning_candidates WHERE id=?", (candidate_id,)).fetchone()
            if not candidate:
                raise KeyError(candidate_id)
            if candidate["status"] in {"gold", "excluded"}:
                raise WorkflowError("Finalized candidates cannot be reviewed")
            try:
                db.execute("INSERT INTO peer_reviews VALUES (?,?,?,?,?,?,?,?)", (
                    str(uuid.uuid4()), candidate_id, reviewer.strip(), verdict, diagnosis.strip(), subtype.strip(), note.strip(), _now()
                ))
            except sqlite3.IntegrityError as exc:
                raise WorkflowError("This reviewer already submitted an opinion for the case") from exc
            db.execute("UPDATE learning_candidates SET status='peer_review',updated_at=? WHERE id=?", (_now(), candidate_id))
        return self.get_candidate(candidate_id)  # type: ignore[return-value]

    def adjudicate(self, candidate_id: str, decision: str, adjudicator: str,
                   case_id: str | None, revision: int | None, note: str) -> dict[str, Any]:
        if decision not in {"gold", "excluded"}:
            raise WorkflowError("Decision must be gold or excluded")
        with self._connect() as db:
            candidate = db.execute("SELECT * FROM learning_candidates WHERE id=?", (candidate_id,)).fetchone()
            if not candidate:
                raise KeyError(candidate_id)
            if candidate["status"] in {"gold", "excluded"}:
                raise WorkflowError("Candidate is already finalized")
            effective_case = case_id or candidate["annotation_case_id"]
            if decision == "gold":
                if not effective_case or revision is None:
                    raise WorkflowError("Gold adjudication requires an annotation case and revision")
                approved = db.execute(
                    "SELECT reviewer FROM annotation_revisions WHERE case_id=? AND revision_number=? AND status='approved' AND reviewed_entire_volume=1",
                    (effective_case, revision),
                ).fetchone()
                if not approved:
                    raise WorkflowError("Gold label must reference an approved whole-volume revision")
                reviews = db.execute("SELECT reviewer FROM peer_reviews WHERE candidate_id=?", (candidate_id,)).fetchall()
                required_reviews = 2 if candidate["assessment"] == "difficult" else 1
                if len({item["reviewer"] for item in reviews}) < required_reviews:
                    raise WorkflowError(f"Gold adjudication requires {required_reviews} independent peer review(s)")
                involved = {approved["reviewer"], *(item["reviewer"] for item in reviews)}
                if adjudicator.strip() in involved:
                    raise WorkflowError("Adjudicator must be independent from label approval and peer reviewers")
                db.execute("INSERT INTO gold_labels VALUES (?,?,?,?,?,?)", (
                    candidate_id, effective_case, revision, adjudicator.strip(), note.strip(), _now()
                ))
            db.execute(
                "UPDATE learning_candidates SET status=?,annotation_case_id=COALESCE(?,annotation_case_id),note=?,updated_at=? WHERE id=?",
                (decision, effective_case, note.strip(), _now(), candidate_id),
            )
        return self.get_candidate(candidate_id)  # type: ignore[return-value]

    @staticmethod
    def _split(key: str, train_ratio: float, validation_ratio: float) -> str:
        value = int(hashlib.sha256(key.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
        if value < train_ratio:
            return "train"
        if value < train_ratio + validation_ratio:
            return "validation"
        return "test"

    def create_dataset(self, name: str, version: str, created_by: str, train_ratio: float,
                       validation_ratio: float, description: str) -> dict[str, Any]:
        if not name.strip() or not version.strip():
            raise WorkflowError("Dataset name and version cannot be empty")
        if train_ratio + validation_ratio >= 1:
            raise WorkflowError("Train and validation ratios must leave a non-empty test ratio")
        dataset_id = str(uuid.uuid4())
        dataset_dir = self.root / "datasets" / dataset_id
        dataset_dir.mkdir(parents=True, exist_ok=False)
        archive_path = dataset_dir / "training-dataset.zip"
        holdout_path = dataset_dir / "locked-holdout.zip"
        with self._connect() as db:
            rows = db.execute(
                """SELECT g.*, c.name case_name,c.patient_id,c.source_digest,c.source_sha256,c.source_path,
                          r.mask_path,r.mask_sha256,r.seed_model_version
                   FROM gold_labels g JOIN annotation_cases c ON c.id=g.annotation_case_id
                   JOIN annotation_revisions r ON r.case_id=g.annotation_case_id AND r.revision_number=g.revision_number
                   ORDER BY g.created_at"""
            ).fetchall()
        if not rows:
            shutil.rmtree(dataset_dir)
            raise WorkflowError("No adjudicated gold labels are available")
        seen: set[str] = set()
        cases: list[dict[str, Any]] = []
        try:
            with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive, zipfile.ZipFile(holdout_path, "w", zipfile.ZIP_DEFLATED) as holdout:
                split_index = {"train": [], "validation": [], "test": []}
                for item in rows:
                    digest = item["source_digest"] or item["source_sha256"]
                    if digest in seen:
                        continue
                    seen.add(digest)
                    split = self._split(item["patient_id"] or item["annotation_case_id"], train_ratio, validation_ratio)
                    case_name = f"brainhem_{len(cases)+1:05d}"
                    image_arc = f"imagesTr/{case_name}_0000.nii.gz" if split != "test" else f"imagesTs/{case_name}_0000.nii.gz"
                    label_arc = f"labelsTr/{case_name}.nii.gz" if split != "test" else f"labelsTs/{case_name}.nii.gz"
                    target_archive = archive if split != "test" else holdout
                    target_archive.write(item["source_path"], image_arc)
                    target_archive.write(item["mask_path"], label_arc)
                    split_index[split].append(case_name)
                    cases.append({"case_name": case_name, "annotation_case_id": item["annotation_case_id"],
                                  "revision_number": item["revision_number"], "patient_key": item["patient_id"] or item["annotation_case_id"],
                                  "split": split, "source_sha256": item["source_sha256"], "mask_sha256": item["mask_sha256"],
                                  "seed_model_version": item["seed_model_version"]})
                empty_splits = [key for key, values in split_index.items() if not values]
                # A tiny smoke dataset cannot populate all three independent
                # splits. Keep it frozen for local review, but refuse larger
                # datasets that silently omit a split needed for evaluation.
                if len(cases) >= 3 and empty_splits:
                    raise WorkflowError(
                        "Dataset cannot be frozen because these patient-level splits are empty: "
                        + ", ".join(empty_splits)
                    )
                manifest = {"schema_version": "2.0", "dataset_id": dataset_id, "name": name, "version": version,
                            "created_at": _now(), "created_by": created_by, "description": description,
                            "split_policy": {"unit": "patient", "algorithm": "sha256", "train_ratio": train_ratio,
                                             "validation_ratio": validation_ratio, "test_ratio": 1-train_ratio-validation_ratio},
                            "splits": split_index, "cases": cases}
                dataset_schema = {"channel_names": {"0": "CT"}, "labels": {"background": 0, "hemorrhage": 1},
                          "numTraining": len(split_index["train"]) + len(split_index["validation"]), "file_ending": ".nii.gz"}
                archive.writestr("dataset.json", json.dumps(dataset_schema, indent=2))
                archive.writestr("splits_final.json", json.dumps([{"train": split_index["train"], "val": split_index["validation"]}], indent=2))
                archive.writestr("provenance_manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False))
                holdout.writestr("provenance_manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False))
            sha, holdout_sha, now = _sha256(archive_path), _sha256(holdout_path), _now()
            with self._connect() as db:
                db.execute("""INSERT INTO dataset_versions
                    (id,name,version,description,status,artifact_path,artifact_sha256,manifest_json,num_cases,created_by,created_at,evaluation_path,evaluation_sha256)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
                    dataset_id, name.strip(), version.strip(), description.strip(), "frozen", str(archive_path), sha,
                    json.dumps(manifest), len(cases), created_by.strip(), now, str(holdout_path), holdout_sha
                ))
        except Exception:
            shutil.rmtree(dataset_dir, ignore_errors=True)
            raise
        return self.get_dataset(dataset_id)  # type: ignore[return-value]

    def list_datasets(self) -> list[dict[str, Any]]:
        with self._connect() as db:
            return [_with_dataset_semantics(_row(r)) for r in db.execute("SELECT * FROM dataset_versions ORDER BY created_at DESC").fetchall()]  # type: ignore[misc]

    def get_dataset(self, dataset_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            return _with_dataset_semantics(_row(db.execute("SELECT * FROM dataset_versions WHERE id=?", (dataset_id,)).fetchone()))

    def create_run(self, dataset_id: str, mode: str, name: str, created_by: str,
                   base_model_id: str | None, config: dict[str, Any]) -> dict[str, Any]:
        if mode not in self.MODES:
            raise WorkflowError("Invalid training mode")
        if not name.strip():
            raise WorkflowError("Training run name cannot be empty")
        dataset = self.get_dataset(dataset_id)
        if not dataset or dataset["status"] != "frozen":
            raise WorkflowError("Training requires a frozen dataset version")
        if mode in {"fine_tune", "site_adaptation", "postprocess_calibration"} and not base_model_id:
            raise WorkflowError("This mode requires a base model")
        if base_model_id:
            base_model = self.get_model(base_model_id)
            if not base_model or base_model["stage"] == "rejected" or not Path(base_model["artifact_path"]).is_file():
                raise WorkflowError("Base model does not exist or is not usable")
            if mode != "postprocess_calibration" and Path(base_model["artifact_path"]).suffix.lower() == ".onnx":
                raise WorkflowError("ONNX artifact không có checkpoint huấn luyện tương thích; không thể fine-tune trong bản public")
            if base_model.get("imported") and base_model.get("metrics", {}).get("training_runner") != "extension_runner":
                raise WorkflowError("Checkpoint nhập từ ngoài cần runner tương thích kiến trúc trước khi fine-tune")
        run_id, now = str(uuid.uuid4()), _now()
        output = self.root / "runs" / run_id
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute(
                "SELECT id FROM training_runs WHERE dataset_version_id=? AND mode=? AND name=? "
                "AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1",
                (dataset_id, mode, name.strip()),
            ).fetchone()
            if existing:
                return _row(db.execute("SELECT * FROM training_runs WHERE id=?", (existing["id"],)).fetchone())  # type: ignore[return-value]
            output.mkdir(parents=True, exist_ok=False)
            db.execute("INSERT INTO training_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
                run_id, dataset_id, mode, name.strip(), base_model_id, json.dumps(config), "queued", created_by.strip(),
                str(output), str(output / "training.log"), None, None, None, now, None, None, now
            ))
        return self.get_run(run_id)  # type: ignore[return-value]

    def list_runs(self) -> list[dict[str, Any]]:
        with self._connect() as db:
            return [_with_live_progress(_row(r)) for r in db.execute("SELECT * FROM training_runs ORDER BY created_at DESC").fetchall()]  # type: ignore[misc]

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            return _with_live_progress(_row(db.execute("SELECT * FROM training_runs WHERE id=?", (run_id,)).fetchone()))

    def queue_validation(self, run_id: str) -> dict[str, Any]:
        with self._connect() as db:
            run = db.execute("""SELECT r.status,r.model_id,d.evaluation_path
                FROM training_runs r JOIN dataset_versions d ON d.id=r.dataset_version_id
                WHERE r.id=?""", (run_id,)).fetchone()
            if not run:
                raise KeyError(run_id)
            if run["status"] not in {"succeeded", "failed"} or not run["model_id"]:
                raise WorkflowError("Only a successfully trained model can be validated")
            if not run["evaluation_path"] or not Path(run["evaluation_path"]).is_file():
                raise WorkflowError("Dataset has no physically isolated locked holdout artifact")
            db.execute(
                "UPDATE training_runs SET status='validation_queued',error=NULL,completed_at=NULL,updated_at=? WHERE id=?",
                (_now(), run_id),
            )
        return self.get_run(run_id)  # type: ignore[return-value]

    def claim_work(self) -> dict[str, Any] | None:
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            item = db.execute("SELECT * FROM training_runs WHERE status IN ('queued','validation_queued') ORDER BY created_at LIMIT 1").fetchone()
            if not item:
                return None
            target = "running" if item["status"] == "queued" else "validating"
            db.execute("UPDATE training_runs SET status=?,started_at=COALESCE(started_at,?),updated_at=? WHERE id=?",
                       (target, _now(), _now(), item["id"]))
            return dict(item) | {"work_type": target}

    def finish_training(self, run_id: str, result: dict[str, Any]) -> None:
        run = self.get_run(run_id)
        if not run:
            raise KeyError(run_id)
        artifact = Path(str(result.get("model_path", ""))).resolve()
        output = Path(run["output_dir"]).resolve()
        if not artifact.is_file() or not artifact.is_relative_to(output):
            raise WorkflowError("run-result.json must reference a model_path inside the run output directory")
        model_id, now = str(uuid.uuid4()), _now()
        metrics = result.get("metrics") if isinstance(result.get("metrics"), dict) else {}
        parent = self.get_model(run["base_model_id"]) if run.get("base_model_id") else None
        parent_metrics = (parent or {}).get("metrics") or {}
        variant = str((run.get("config") or {}).get("model_variant") or parent_metrics.get("model_variant") or "S").upper()
        metrics = {**metrics,
                   "training_runner": metrics.get("training_runner") or parent_metrics.get("training_runner"),
                   "model_variant": variant, "supported_variants": [variant], "fine_tune_variants": metrics.get("fine_tune_variants", [variant]),
                   "display_name": run["name"]}
        with self._connect() as db:
            db.execute("INSERT INTO model_versions VALUES (?,?,?,?,?,?,?,?,?,?)", (
                model_id, run["name"], run_id, run["base_model_id"], str(artifact), _sha256(artifact),
                "candidate", json.dumps(metrics), now, now
            ))
            db.execute("UPDATE training_runs SET status='succeeded',metrics_json=?,model_id=?,completed_at=?,updated_at=? WHERE id=?",
                       (json.dumps(metrics), model_id, now, now, run_id))

    def finish_validation(self, run_id: str, result: dict[str, Any]) -> None:
        run = self.get_run(run_id)
        if not run or not run["model_id"]:
            raise WorkflowError("Training model is missing")
        validation_metrics = result.get("metrics") if isinstance(result.get("metrics"), dict) else None
        if not validation_metrics:
            raise WorkflowError("validation-result.json must contain non-empty metrics")
        # Validation augments the training record. Keeping the measured loss
        # history allows Model Studio to render the completed experiment rather
        # than replacing it with only the final holdout summary.
        metrics = {**(run.get("metrics") or {}), **validation_metrics}
        gate = metrics.get("quality_gate") if isinstance(metrics.get("quality_gate"), dict) else {}
        required_dice = float(gate.get("dice", .5))
        required_recall = float(gate.get("recall", .8))
        measured_dice = float(validation_metrics.get("mean_dice", 0.0))
        measured_recall = float(validation_metrics.get("lesion_recall", 0.0))
        gate_passed = measured_dice >= required_dice and measured_recall >= required_recall
        metrics["validation_gate"] = {
            "passed": gate_passed,
            "measured": {"dice": measured_dice, "recall": measured_recall},
            "required": {"dice": required_dice, "recall": required_recall},
        }
        now = _now()
        with self._connect() as db:
            if gate_passed:
                db.execute("UPDATE model_versions SET stage='technical_validated',metrics_json=?,updated_at=? WHERE id=?",
                           (json.dumps(metrics), now, run["model_id"]))
                db.execute("UPDATE training_runs SET status='validated',metrics_json=?,error=NULL,completed_at=?,updated_at=? WHERE id=?",
                           (json.dumps(metrics), now, now, run_id))
            else:
                reason = (f"Independent validation gate failed: Dice {measured_dice:.4f}/{required_dice:.4f}, "
                          f"lesion recall {measured_recall:.4f}/{required_recall:.4f}")
                db.execute("UPDATE model_versions SET stage='candidate',metrics_json=?,updated_at=? WHERE id=?",
                           (json.dumps(metrics), now, run["model_id"]))
                db.execute("UPDATE training_runs SET status='failed',metrics_json=?,error=?,completed_at=?,updated_at=? WHERE id=?",
                           (json.dumps(metrics), reason, now, now, run_id))

    def fail_work(self, run_id: str, error: str) -> None:
        with self._connect() as db:
            db.execute("UPDATE training_runs SET status='failed',error=?,completed_at=?,updated_at=? WHERE id=?",
                       (error[:4000], _now(), _now(), run_id))

    def list_models(self) -> list[dict[str, Any]]:
        with self._connect() as db:
            models = [_row(r) for r in db.execute("SELECT * FROM model_versions ORDER BY created_at DESC").fetchall()]
            for model in models:
                model["approvals"] = [dict(a) for a in db.execute("SELECT * FROM model_approvals WHERE model_id=? ORDER BY created_at", (model["id"],)).fetchall()]
                model["shadow_evidence"] = [dict(e) | {"summary": json.loads(e["summary_json"])} for e in db.execute("SELECT * FROM shadow_evidence WHERE model_id=? ORDER BY created_at", (model["id"],)).fetchall()]
                model["deployments"] = [dict(d) for d in db.execute("SELECT * FROM model_deployments WHERE model_id=? ORDER BY created_at", (model["id"],)).fetchall()]
            if db.execute("SELECT 1 FROM sqlite_master WHERE name='imported_models'").fetchone():
                models = [json.loads(r[0]) for r in db.execute("SELECT payload FROM imported_models")] + models
            return models  # type: ignore[return-value]

    def get_model(self, model_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            model = _row(db.execute("SELECT * FROM model_versions WHERE id=?", (model_id,)).fetchone())
            if not model and db.execute("SELECT 1 FROM sqlite_master WHERE name='imported_models'").fetchone():
                row = db.execute("SELECT payload FROM imported_models WHERE id=?", (model_id,)).fetchone()
                model = json.loads(row[0]) if row else None
            return model

    def approve_model(self, model_id: str, gate: str, decision: str, approver: str, note: str) -> dict[str, Any]:
        if gate not in {"clinical", "qa"} or decision not in {"approved", "rejected"}:
            raise WorkflowError("Invalid approval gate or decision")
        model = self.get_model(model_id)
        if not model:
            raise KeyError(model_id)
        with self._connect() as db:
            if decision == "approved":
                expected_stage = "technical_validated" if gate == "clinical" else "clinical_validated"
                if model["stage"] != expected_stage:
                    raise WorkflowError(f"The {gate} gate requires model stage {expected_stage}")
                run = db.execute("SELECT created_by FROM training_runs WHERE id=?", (model["training_run_id"],)).fetchone()
                prior = db.execute("SELECT gate,approver FROM model_approvals WHERE model_id=? AND decision='approved'", (model_id,)).fetchall()
                if run and run["created_by"] == approver.strip():
                    raise WorkflowError("Model developer cannot approve their own candidate")
                if any(item["approver"] == approver.strip() for item in prior):
                    raise WorkflowError("Clinical and QA gates require independent approvers")
                if any(item["gate"] == gate for item in prior):
                    raise WorkflowError(f"The {gate} gate is already approved")
            db.execute("INSERT INTO model_approvals VALUES (?,?,?,?,?,?,?)", (
                str(uuid.uuid4()), model_id, gate, decision, approver.strip(), note.strip(), _now()
            ))
            if decision == "rejected":
                db.execute("UPDATE model_versions SET stage='rejected',updated_at=? WHERE id=?", (_now(), model_id))
            elif gate == "clinical" and model["stage"] == "technical_validated":
                db.execute("UPDATE model_versions SET stage='clinical_validated',updated_at=? WHERE id=?", (_now(), model_id))
        return self.get_model(model_id)  # type: ignore[return-value]

    def transition_model(self, model_id: str, target: str, actor: str, note: str) -> dict[str, Any]:
        self.validate_transition(model_id, target)
        model = self.get_model(model_id)
        with self._connect() as db:
            approvals = {r["gate"] for r in db.execute(
                "SELECT gate FROM model_approvals WHERE model_id=? AND decision='approved'", (model_id,)
            ).fetchall()}
            if target == "shadow" and not {"clinical", "qa"}.issubset(approvals):
                raise WorkflowError("Shadow deployment requires clinical and QA approvals")
            if target == "production":
                if not {"clinical", "qa"}.issubset(approvals):
                    raise WorkflowError("Production promotion requires clinical and QA approvals")
                deployment = db.execute("SELECT * FROM model_deployments WHERE model_id=? AND status='ready' ORDER BY created_at DESC LIMIT 1", (model_id,)).fetchone()
                if not deployment:
                    raise WorkflowError("Production promotion requires a ready serving deployment")
                db.execute("UPDATE model_versions SET stage='archived',updated_at=? WHERE stage='production'", (_now(),))
                db.execute("INSERT INTO runtime_settings(key,value,updated_at) VALUES ('production_triton_version',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", (deployment["serving_version"], _now()))
                db.execute("INSERT INTO runtime_settings(key,value,updated_at) VALUES ('production_model_id',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", (model_id, _now()))
            db.execute("UPDATE model_versions SET stage=?,updated_at=? WHERE id=?", (target, _now(), model_id))
            db.execute("INSERT INTO model_transitions VALUES (?,?,?,?,?,?,?)", (
                str(uuid.uuid4()), model_id, model["stage"], target, actor.strip(), note.strip(), _now()
            ))
        return self.get_model(model_id)  # type: ignore[return-value]

    def validate_transition(self, model_id: str, target: str) -> None:
        model = self.get_model(model_id)
        if not model:
            raise KeyError(model_id)
        allowed = {("clinical_validated", "shadow"), ("shadow", "production"),
                   ("production", "archived"), ("shadow", "rejected")}
        if (model["stage"], target) not in allowed:
            raise WorkflowError(f"Transition {model['stage']} -> {target} is not allowed")
        if target in {"shadow", "production"}:
            with self._connect() as db:
                approvals = {r["gate"] for r in db.execute(
                    "SELECT gate FROM model_approvals WHERE model_id=? AND decision='approved'", (model_id,)
                ).fetchall()}
            if not {"clinical", "qa"}.issubset(approvals):
                raise WorkflowError(f"{target.title()} requires clinical and QA approvals")
        if target == "production":
            with self._connect() as db:
                evidence = db.execute("SELECT 1 FROM shadow_evidence WHERE model_id=? LIMIT 1", (model_id,)).fetchone()
            if not evidence:
                raise WorkflowError("Production promotion requires an immutable shadow evaluation report")
            with self._connect() as db:
                deployment = db.execute("SELECT 1 FROM model_deployments WHERE model_id=? AND status='ready' LIMIT 1", (model_id,)).fetchone()
            if not deployment:
                raise WorkflowError("Production promotion requires a ready Triton deployment")

    def record_deployment(self, model_id: str, backend: str, serving_name: str,
                          serving_version: str, artifact_sha256: str) -> dict[str, Any]:
        deployment_id, now = str(uuid.uuid4()), _now()
        with self._connect() as db:
            db.execute("INSERT INTO model_deployments VALUES (?,?,?,?,?,?,?,?)", (
                deployment_id, model_id, backend, serving_name, serving_version, artifact_sha256, "ready", now
            ))
        return {"id": deployment_id, "model_id": model_id, "backend": backend,
                "serving_name": serving_name, "serving_version": serving_version,
                "artifact_sha256": artifact_sha256, "status": "ready", "created_at": now}

    def get_runtime_setting(self, key: str) -> str | None:
        with self._connect() as db:
            row = db.execute("SELECT value FROM runtime_settings WHERE key=?", (key,)).fetchone()
        return row["value"] if row else None

    def set_runtime_setting(self, key: str, value: str) -> None:
        with self._connect() as db:
            db.execute(
                "INSERT INTO runtime_settings(key,value,updated_at) VALUES (?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
                (key, value, _now()),
            )

    def add_shadow_evidence(self, model_id: str, source: Path, assessor: str, note: str) -> dict[str, Any]:
        model = self.get_model(model_id)
        if not model:
            raise KeyError(model_id)
        if model["stage"] != "shadow":
            raise WorkflowError("Shadow evidence can only be attached to a shadow model")
        try:
            summary = json.loads(source.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise WorkflowError("Shadow report must be valid JSON") from exc
        if not isinstance(summary, dict) or int(summary.get("num_studies", 0)) < 1 or not isinstance(summary.get("metrics"), dict) or not summary["metrics"]:
            raise WorkflowError("Shadow report requires num_studies > 0 and non-empty metrics")
        evidence_id = str(uuid.uuid4())
        target_dir = self.root / "shadow" / model_id
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / f"{evidence_id}.json"
        shutil.copy2(source, target)
        with self._connect() as db:
            db.execute("INSERT INTO shadow_evidence VALUES (?,?,?,?,?,?,?,?)", (
                evidence_id, model_id, str(target), _sha256(target), json.dumps(summary), assessor, note.strip(), _now()
            ))
        return {"id": evidence_id, "model_id": model_id, "report_sha256": _sha256(target), "summary": summary,
                "assessor": assessor, "note": note.strip()}


class TrainingWorker:
    def __init__(self, store: MLOpsStore, settings: Settings) -> None:
        self.store, self.settings = store, settings
        self._stop, self._wake = threading.Event(), threading.Event()
        self._thread: threading.Thread | None = None
        self.scheduler = None

    @property
    def alive(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def start(self) -> None:
        if self.alive:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="training-worker", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set(); self._wake.set()
        if self._thread:
            self._thread.join(timeout=5)

    def notify(self) -> None:
        self._wake.set()

    def _execute(self, item: dict[str, Any]) -> None:
        run = self.store.get_run(item["id"])
        if not run:
            return
        dataset = self.store.get_dataset(run["dataset_version_id"])
        model = self.store.get_model(run["model_id"]) if run.get("model_id") else None
        validating = item["work_type"] == "validating"
        template = self.settings.validation_command if validating else self.settings.training_command
        if not template:
            raise WorkflowError(f"{'Validation' if validating else 'Training'} command is not configured")
        output = Path(run["output_dir"])
        config_path = output / "config.json"
        runner_config = dict(run["config"])
        runner_config["_workflow_mode"] = run["mode"]
        base_model_path = (
            (self.store.get_model(run["base_model_id"]) or {}).get("artifact_path", "")
            if run.get("base_model_id") else ""
        )
        # Registry imports may predate absolute-path normalization. The runner
        # executes in its own output directory, not the application's cwd.
        runner_config["_base_model_path"] = str(Path(base_model_path).resolve()) if base_model_path else ""
        source_model = model if validating else (self.store.get_model(run["base_model_id"]) if run.get("base_model_id") else None)
        runner_config["_training_runner"] = (source_model or {}).get("metrics", {}).get("training_runner", "monai_resunet")
        config_path.write_text(json.dumps(runner_config, indent=2), encoding="utf-8")
        dataset_artifact = dataset.get("evaluation_path") if validating else dataset["artifact_path"]
        dataset_artifact = str(Path(dataset_artifact).resolve()) if dataset_artifact else ""
        values = {"dataset": dataset_artifact, "output_dir": str(output), "run_id": run["id"],
                  "config": str(config_path.resolve()), "model": str(Path(model["artifact_path"]).resolve()) if model else "",
                  "base_model": runner_config["_base_model_path"]}
        command = shlex.split(template.format(**values))
        log_path = Path(run["log_path"])
        with log_path.open("a", encoding="utf-8") as log:
            log.write(f"[{_now()}] exec: {shlex.join(command)}\n")
            log.flush()
            log.write(f"[{_now()}] waiting for workstation GPU slot\n"); log.flush()
            with gpu_slot(self.settings.data_dir / "gpu-resource.lock", wait=True, stop=self._stop) as gpu_fd:
                completed = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=self.settings.training_timeout_seconds,
                                       cwd=output, env=os.environ.copy(), check=False, pass_fds=(gpu_fd,))
        if completed.returncode:
            raise WorkflowError(f"Runner exited with code {completed.returncode}; see training.log")
        result_path = output / ("validation-result.json" if validating else "run-result.json")
        if not result_path.is_file():
            raise WorkflowError(f"Runner did not create {result_path.name}")
        result = json.loads(result_path.read_text(encoding="utf-8"))
        if validating:
            self.store.finish_validation(run["id"], result)
        else:
            self.store.finish_training(run["id"], result)

    def _run(self) -> None:
        while not self._stop.is_set():
            if self.scheduler:
                self.scheduler()
            item = self.store.claim_work()
            if item:
                try:
                    self._execute(item)
                except Exception as exc:
                    self.store.fail_work(item["id"], str(exc))
                continue
            self._wake.wait(1.0); self._wake.clear()
