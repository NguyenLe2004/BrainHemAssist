from __future__ import annotations

import hashlib
import json
import shutil
import uuid
import os
import sqlite3
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import nibabel as nib
import numpy as np
import SimpleITK as sitk

from .models import AnnotationCase, AnnotationRevision
from .validation import (
    compute_canonical_nifti_digest,
    extract_nifti_geometry,
    validate_mask_against_source,
    validate_nifti_header,
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _file_sha256(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(64 * 1024):
            hasher.update(chunk)
    return hasher.hexdigest()


class RevisionConflictError(Exception):
    """Raised when expected_revision does not match the current case revision."""
    pass


class AnnotationStore:
    def __init__(self, database_path: Path, annotations_dir: Path) -> None:
        self.database_path = database_path
        self.annotations_dir = annotations_dir
        self._mask_summary_cache: dict[tuple[str, int, int], tuple[int, int]] = {}

    def _mask_structure_summary(self, path: Path) -> tuple[int, int]:
        """Return (3D components, labeled axial slices), cached by file identity."""
        stat = path.stat()
        key = (str(path), stat.st_mtime_ns, stat.st_size)
        cached = self._mask_summary_cache.get(key)
        if cached is not None:
            return cached
        mask = sitk.Cast(sitk.ReadImage(str(path)) != 0, sitk.sitkUInt8)
        connected = sitk.ConnectedComponentImageFilter()
        # Match the editor's 26-neighbour definition: voxels touching by a
        # face, edge or corner belong to the same selectable 3D component.
        connected.FullyConnectedOn()
        connected.Execute(mask)
        component_count = int(connected.GetObjectCount())
        array_zyx = sitk.GetArrayViewFromImage(mask)
        labeled_slices = int(np.count_nonzero(np.any(array_zyx != 0, axis=(1, 2))))
        summary = (component_count, labeled_slices)
        self._mask_summary_cache[key] = summary
        return summary

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def initialize(self) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.annotations_dir.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS annotation_cases (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    study_instance_uid TEXT,
                    series_instance_uid TEXT,
                    source_job_id TEXT,
                    source_sha256 TEXT NOT NULL,
                    source_digest TEXT NOT NULL DEFAULT '',
                    source_path TEXT NOT NULL,
                    geometry_json TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'draft',
                    current_revision INTEGER NOT NULL DEFAULT 0,
                    latest_approved_revision INTEGER,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    source_type TEXT NOT NULL DEFAULT 'research',
                    patient_id TEXT,
                    patient_name TEXT,
                    study_date TEXT,
                    study_description TEXT,
                    accession_number TEXT,
                    priority TEXT NOT NULL DEFAULT 'routine',
                    clinical_indication TEXT NOT NULL DEFAULT '',
                    FOREIGN KEY (source_job_id) REFERENCES jobs(id) ON DELETE SET NULL
                )
                """
            )
            connection.execute("""CREATE TABLE IF NOT EXISTS annotation_operations (
                case_id TEXT NOT NULL, reviewer TEXT NOT NULL, operation_id TEXT NOT NULL,
                payload_digest TEXT NOT NULL, revision_number INTEGER NOT NULL,
                PRIMARY KEY(case_id, reviewer, operation_id),
                FOREIGN KEY(case_id, revision_number) REFERENCES annotation_revisions(case_id, revision_number) ON DELETE CASCADE
            )""")
            # Schema migrations for existing tables
            case_cols = {row[1] for row in connection.execute("PRAGMA table_info(annotation_cases)").fetchall()}
            if "source_digest" not in case_cols:
                connection.execute("ALTER TABLE annotation_cases ADD COLUMN source_digest TEXT NOT NULL DEFAULT ''")
            for definition in (
                "source_type TEXT NOT NULL DEFAULT 'research'",
                "patient_id TEXT",
                "patient_name TEXT",
                "study_date TEXT",
                "study_description TEXT",
                "accession_number TEXT",
                "priority TEXT NOT NULL DEFAULT 'routine'",
                "clinical_indication TEXT NOT NULL DEFAULT ''",
            ):
                name = definition.split()[0]
                if name not in case_cols:
                    connection.execute(f"ALTER TABLE annotation_cases ADD COLUMN {definition}")

            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS annotation_revisions (
                    id TEXT PRIMARY KEY,
                    case_id TEXT NOT NULL,
                    revision_number INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    mask_path TEXT NOT NULL,
                    mask_sha256 TEXT NOT NULL,
                    volume_ml REAL,
                    voxel_count INTEGER NOT NULL,
                    is_empty_mask INTEGER NOT NULL,
                    reviewed_entire_volume INTEGER NOT NULL DEFAULT 0,
                    reviewer TEXT NOT NULL,
                    notes TEXT,
                    parent_revision INTEGER,
                    seed_job_id TEXT,
                    seed_tier TEXT,
                    seed_model_version TEXT,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (case_id) REFERENCES annotation_cases(id) ON DELETE CASCADE,
                    UNIQUE(case_id, revision_number)
                )
                """
            )
            rev_cols = {row[1] for row in connection.execute("PRAGMA table_info(annotation_revisions)").fetchall()}
            if "seed_model_version" not in rev_cols:
                connection.execute("ALTER TABLE annotation_revisions ADD COLUMN seed_model_version TEXT")
            if "parent_revision" not in rev_cols:
                connection.execute("ALTER TABLE annotation_revisions ADD COLUMN parent_revision INTEGER")

            connection.execute(
                "CREATE INDEX IF NOT EXISTS ix_annotation_cases_study ON annotation_cases(study_instance_uid)"
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS ix_annotation_cases_sha ON annotation_cases(source_sha256)"
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS ix_annotation_cases_digest ON annotation_cases(source_digest)"
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS ix_annotation_revisions_case ON annotation_revisions(case_id, revision_number)"
            )

    def create_case(
        self,
        case_id: str,
        name: str,
        source_file_path: Path,
        study_instance_uid: str | None = None,
        series_instance_uid: str | None = None,
        source_job_id: str | None = None,
        source_type: str = "research",
        patient_id: str | None = None,
        patient_name: str | None = None,
        study_date: str | None = None,
        study_description: str | None = None,
        accession_number: str | None = None,
        priority: str = "routine",
        clinical_indication: str = "",
        deduplicate: bool = True,
    ) -> tuple[AnnotationCase, bool]:
        validate_nifti_header(source_file_path)
        source_digest = compute_canonical_nifti_digest(source_file_path)

        # Atomic deduplication: return existing case if same canonical voxel digest
        # BUT if series_instance_uid is specified for both and differs, preserve identity!
        clean_series = (series_instance_uid or "").strip()
        with self._connect() as connection:
            candidates = connection.execute(
                "SELECT id, series_instance_uid FROM annotation_cases WHERE source_digest = ?",
                (source_digest,),
            ).fetchall() if deduplicate else []
            for cand in candidates:
                cand_series = (cand["series_instance_uid"] or "").strip()
                if not clean_series or not cand_series or clean_series == cand_series:
                    existing = self.get_case(cand["id"])
                    if existing:
                        return existing, False

        case_dir = self.annotations_dir / case_id
        case_dir.mkdir(parents=True, exist_ok=False)

        # Store immutable source CT copy
        immutable_source_path = case_dir / "source.nii.gz"
        # If source is uncompressed .nii, compress to .nii.gz for standard storage
        if source_file_path.name.lower().endswith(".nii") and not source_file_path.name.lower().endswith(".nii.gz"):
            img = nib.load(source_file_path)
            nib.save(img, immutable_source_path)
        else:
            shutil.copy2(source_file_path, immutable_source_path)

        source_sha256 = _file_sha256(immutable_source_path)
        geometry = extract_nifti_geometry(immutable_source_path)
        now_ts = _now()

        # Create initial empty draft revision (revision 0)
        revisions_dir = case_dir / "revisions" / "0"
        revisions_dir.mkdir(parents=True, exist_ok=True)
        initial_mask_path = revisions_dir / "mask.nii.gz"

        # Create 0-filled mask matching source geometry
        source_img = nib.load(immutable_source_path)
        empty_mask_data = np.zeros(source_img.shape[:3], dtype=np.uint8)
        mask_nii = nib.Nifti1Image(empty_mask_data, source_img.affine, header=source_img.header.copy())
        mask_nii.set_data_dtype(np.uint8)
        nib.save(mask_nii, initial_mask_path)
        mask_sha = _file_sha256(initial_mask_path)

        revision_id = f"{case_id}-rev-0"

        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            # Double check deduplication inside transaction to avoid race conditions
            candidates = connection.execute(
                "SELECT id, series_instance_uid FROM annotation_cases WHERE source_digest = ?",
                (source_digest,),
            ).fetchall() if deduplicate else []
            for cand in candidates:
                cand_series = (cand["series_instance_uid"] or "").strip()
                if not clean_series or not cand_series or clean_series == cand_series:
                    shutil.rmtree(case_dir, ignore_errors=True)
                    existing = self.get_case(cand["id"])
                    if existing:
                        return existing, False

            connection.execute(
                """
                INSERT INTO annotation_cases (
                    id, name, study_instance_uid, series_instance_uid, source_job_id,
                    source_sha256, source_digest, source_path, geometry_json, status, current_revision,
                    latest_approved_revision, created_at, updated_at,
                    source_type, patient_id, patient_name, study_date,
                    study_description, accession_number, priority, clinical_indication
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    case_id,
                    name,
                    study_instance_uid,
                    series_instance_uid,
                    source_job_id,
                    source_sha256,
                    source_digest,
                    str(immutable_source_path),
                    json.dumps(geometry),
                    "draft",
                    0,
                    None,
                    now_ts,
                    now_ts,
                    source_type,
                    patient_id,
                    patient_name,
                    study_date,
                    study_description,
                    accession_number,
                    priority,
                    clinical_indication,
                ),
            )
            connection.execute(
                """
                INSERT INTO annotation_revisions (
                    id, case_id, revision_number, status, mask_path, mask_sha256,
                    volume_ml, voxel_count, is_empty_mask, reviewed_entire_volume,
                    reviewer, notes, parent_revision, seed_job_id, seed_tier, seed_model_version, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    revision_id,
                    case_id,
                    0,
                    "draft",
                    str(initial_mask_path),
                    mask_sha,
                    0.0,
                    0,
                    1,
                    0,
                    "system-init",
                    "Initial empty draft",
                    None,
                    None,
                    None,
                    None,
                    now_ts,
                ),
            )

        return self.get_case(case_id), True  # type: ignore[return-value]

    def get_case(self, case_id: str) -> AnnotationCase | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT c.*,
                       r.volume_ml AS current_volume_ml,
                       r.voxel_count AS current_voxel_count,
                       r.reviewer AS current_reviewer,
                       r.mask_path AS current_mask_path,
                       r.parent_revision AS current_parent_revision,
                       r.seed_job_id AS current_seed_job_id,
                       approved.notes AS approved_notes,
                       approved.reviewed_entire_volume AS approved_reviewed_entire_volume
                FROM annotation_cases c
                LEFT JOIN annotation_revisions r
                  ON r.case_id = c.id AND r.revision_number = c.current_revision
                LEFT JOIN annotation_revisions approved
                  ON approved.case_id = c.id AND approved.revision_number = c.latest_approved_revision
                WHERE c.id = ?
                """,
                (case_id,),
            ).fetchone()
        if not row:
            return None
        return self._to_case(row)

    def find_by_study(self, study_instance_uid: str) -> AnnotationCase | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM annotation_cases WHERE study_instance_uid = ? ORDER BY created_at DESC LIMIT 1",
                (study_instance_uid,),
            ).fetchone()
        return self._to_case(row) if row else None

    def find_by_source_sha(self, source_sha256: str) -> AnnotationCase | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM annotation_cases WHERE source_sha256 = ? ORDER BY created_at DESC LIMIT 1",
                (source_sha256,),
            ).fetchone()
        return self._to_case(row) if row else None

    def find_by_source_digest(self, source_digest: str) -> AnnotationCase | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM annotation_cases WHERE source_digest = ? ORDER BY created_at DESC LIMIT 1",
                (source_digest,),
            ).fetchone()
        return self._to_case(row) if row else None

    def list_cases(
        self, limit: int = 50, offset: int = 0, status: str | None = None
    ) -> tuple[list[AnnotationCase], int]:
        where = ""
        parameters: list[Any] = []
        if status:
            where = " WHERE c.status = ?"
            parameters.append(status)
        with self._connect() as connection:
            count = connection.execute(
                f"SELECT COUNT(*) FROM annotation_cases c{where}", parameters
            ).fetchone()[0]
            rows = connection.execute(
                f"""
                SELECT c.*,
                       r.volume_ml AS current_volume_ml,
                       r.voxel_count AS current_voxel_count,
                       r.reviewer AS current_reviewer,
                       r.mask_path AS current_mask_path,
                       r.parent_revision AS current_parent_revision,
                       r.seed_job_id AS current_seed_job_id,
                       approved.notes AS approved_notes,
                       approved.reviewed_entire_volume AS approved_reviewed_entire_volume
                FROM annotation_cases c
                LEFT JOIN annotation_revisions r
                  ON r.case_id = c.id AND r.revision_number = c.current_revision
                LEFT JOIN annotation_revisions approved
                  ON approved.case_id = c.id AND approved.revision_number = c.latest_approved_revision
                {where}
                ORDER BY c.updated_at DESC LIMIT ? OFFSET ?
                """,
                [*parameters, limit, offset],
            ).fetchall()
        items: list[AnnotationCase] = []
        for row in rows:
            item = self._to_case(row)
            mask_value = row["current_mask_path"] if "current_mask_path" in row.keys() else None
            if item.current_revision > 0 and mask_value:
                mask_path = Path(mask_value)
                if mask_path.is_file():
                    try:
                        item.label_component_count, item.labeled_slice_count = self._mask_structure_summary(mask_path)
                    except (OSError, RuntimeError, ValueError):
                        pass
            items.append(item)
        return items, count

    def get_source_path(self, case_id: str) -> Path | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT source_path FROM annotation_cases WHERE id = ?", (case_id,)
            ).fetchone()
        if not row:
            return None
        path = Path(row["source_path"])
        return path if path.is_file() else None

    def get_revision(self, case_id: str, revision_number: int) -> AnnotationRevision | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT * FROM annotation_revisions
                WHERE case_id = ? AND revision_number = ?
                """,
                (case_id, revision_number),
            ).fetchone()
        if not row:
            return None
        return self._to_revision(row)

    def retained_ai_seed(self, case_id: str) -> AnnotationRevision | None:
        """Return a retained original AI mask, never a descendant edited label."""
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM annotation_revisions WHERE case_id = ? "
                "AND revision_number > 0 AND seed_job_id IS NOT NULL "
                "AND parent_revision IS NULL ORDER BY revision_number DESC",
                (case_id,),
            ).fetchall()
        for row in rows:
            if Path(row["mask_path"]).is_file():
                return self._to_revision(row)
        return None

    def list_revisions(self, case_id: str) -> list[AnnotationRevision]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT * FROM annotation_revisions
                WHERE case_id = ?
                ORDER BY revision_number DESC
                """,
                (case_id,),
            ).fetchall()
        return [self._to_revision(row) for row in rows]

    def get_revision_mask_path(self, case_id: str, revision_number: int) -> Path | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT mask_path FROM annotation_revisions
                WHERE case_id = ? AND revision_number = ?
                """,
                (case_id, revision_number),
            ).fetchone()
        if not row:
            return None
        path = Path(row["mask_path"])
        return path if path.is_file() else None

    def save_revision(
        self,
        case_id: str,
        mask_file_path: Path,
        status: str,
        expected_revision: int,
        reviewer: str,
        notes: str = "",
        reviewed_entire_volume: bool = False,
        clear_provenance: bool = False,
        base_revision: int | None = None,
        seed_job_id: str | None = None,
        seed_tier: str | None = None,
        seed_model_version: str | None = None,
        operation_id: str | None = None,
    ) -> AnnotationRevision:
        norm_status = status.strip().lower()
        if norm_status not in {"draft", "approved"}:
            raise ValueError("Revision status must be 'draft' or 'approved'")

        reviewer_clean = (reviewer or "").strip()
        if norm_status == "approved" and not reviewer_clean:
            raise ValueError("Reviewer identity is required to approve a revision")

        source_path = self.get_source_path(case_id)
        if not source_path:
            raise FileNotFoundError(f"Annotation case {case_id} or source file not found")

        # Validate mask geometry, affine, binary labels, NaN
        validation = validate_mask_against_source(source_path, mask_file_path)
        voxel_count = validation["voxel_count"]
        volume_ml = validation["volume_ml"]
        is_empty = validation["is_empty"]

        if norm_status == "approved" and not reviewed_entire_volume:
            raise ValueError(
                "Approval requires explicit whole-volume review acknowledgement confirming the entire volume was reviewed (reviewed_entire_volume=True)"
            )

        if operation_id and (len(operation_id) > 128 or not all(c.isalnum() or c in '-_' for c in operation_id)):
            raise ValueError("Invalid save operation identifier")
        payload_digest = hashlib.sha256(json.dumps({
            "mask": compute_canonical_nifti_digest(mask_file_path), "status": norm_status,
            "expected_revision": expected_revision, "base_revision": base_revision,
            "notes": notes.strip(), "reviewed": reviewed_entire_volume, "clear": clear_provenance,
            "seed_job": seed_job_id, "seed_tier": seed_tier, "seed_model": seed_model_version,
        }, sort_keys=True).encode()).hexdigest() if operation_id else ""

        now_ts = _now()

        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if operation_id:
                prior = connection.execute("SELECT * FROM annotation_operations WHERE case_id=? AND reviewer=? AND operation_id=?",
                                           (case_id, reviewer_clean, operation_id)).fetchone()
                if prior:
                    if prior["payload_digest"] != payload_digest:
                        raise ValueError("Save operation identifier was reused with a different payload")
                    return self.get_revision(case_id, prior["revision_number"])
            case_row = connection.execute(
                "SELECT current_revision, latest_approved_revision FROM annotation_cases WHERE id = ?",
                (case_id,),
            ).fetchone()
            if not case_row:
                raise FileNotFoundError(f"Annotation case {case_id} not found")

            current_rev = int(case_row["current_revision"])
            if current_rev != expected_revision:
                raise RevisionConflictError(
                    f"Revision conflict: expected revision {expected_revision}, but current is {current_rev}"
                )

            effective_base = expected_revision if base_revision is None else base_revision
            if effective_base < 0 or effective_base > current_rev:
                raise ValueError("Base revision must reference an existing revision of this case")
            if effective_base > 0 and not connection.execute(
                "SELECT 1 FROM annotation_revisions WHERE case_id = ? AND revision_number = ?",
                (case_id, effective_base),
            ).fetchone():
                raise ValueError("Base revision does not exist for this case")

            next_rev = current_rev + 1
            rev_dir = self.annotations_dir / case_id / "revisions" / str(next_rev)
            rev_dir.mkdir(parents=True, exist_ok=True)
            target_mask_path = rev_dir / "mask.nii.gz"

            staged_mask_path = rev_dir / f"mask-{uuid.uuid4().hex}.tmp.nii.gz"

            # Always ensure saved as compressed .nii.gz
            if mask_file_path.name.lower().endswith(".nii") and not mask_file_path.name.lower().endswith(".nii.gz"):
                mask_img = nib.load(mask_file_path)
                nib.save(mask_img, staged_mask_path)
            else:
                shutil.copy2(mask_file_path, staged_mask_path)

            with staged_mask_path.open("rb") as saved_file:
                os.fsync(saved_file.fileno())
            os.replace(staged_mask_path, target_mask_path)
            directory_fd = os.open(rev_dir, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
            mask_sha = _file_sha256(target_mask_path)
            rev_id = f"{case_id}-rev-{next_rev}"

            # Effective base revision for parent lineage and provenance inheritance
            parent_rev = effective_base if effective_base > 0 else None
            if not clear_provenance and seed_job_id is None and effective_base > 0:
                base_rev = connection.execute(
                    "SELECT seed_job_id, seed_tier, seed_model_version FROM annotation_revisions WHERE case_id = ? AND revision_number = ?",
                    (case_id, effective_base),
                ).fetchone()
                if base_rev:
                    seed_job_id = base_rev["seed_job_id"]
                    seed_tier = base_rev["seed_tier"]
                    seed_model_version = base_rev["seed_model_version"]

            connection.execute(
                """
                INSERT INTO annotation_revisions (
                    id, case_id, revision_number, status, mask_path, mask_sha256,
                    volume_ml, voxel_count, is_empty_mask, reviewed_entire_volume,
                    reviewer, notes, parent_revision, seed_job_id, seed_tier, seed_model_version, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    rev_id,
                    case_id,
                    next_rev,
                    norm_status,
                    str(target_mask_path),
                    mask_sha,
                    volume_ml,
                    voxel_count,
                    1 if is_empty else 0,
                    1 if reviewed_entire_volume else 0,
                    reviewer_clean or "demo-doctor",
                    notes.strip() if notes else "",
                    parent_rev,
                    seed_job_id,
                    seed_tier,
                    seed_model_version,
                    now_ts,
                ),
            )

            latest_app = (
                next_rev
                if norm_status == "approved"
                else case_row["latest_approved_revision"]
            )
            case_status = "approved" if norm_status == "approved" else "draft"

            connection.execute(
                """
                UPDATE annotation_cases
                SET current_revision = ?, latest_approved_revision = ?, status = ?, updated_at = ?
                WHERE id = ?
                """,
                (next_rev, latest_app, case_status, now_ts, case_id),
            )
            if operation_id:
                connection.execute("INSERT INTO annotation_operations VALUES (?,?,?,?,?)",
                                   (case_id, reviewer_clean, operation_id, payload_digest, next_rev))

        return self.get_revision(case_id, next_rev)  # type: ignore[return-value]

    def operation_revision(self, case_id: str, reviewer: str, operation_id: str):
        with self._connect() as db:
            row = db.execute("SELECT revision_number FROM annotation_operations WHERE case_id=? AND reviewer=? AND operation_id=?",
                             (case_id, reviewer, operation_id)).fetchone()
        return self.get_revision(case_id, row["revision_number"]) if row else None

    def export_dataset(self, output_zip_path: Path) -> dict[str, Any]:
        """Export all approved cases into a structured segmentation dataset zip file.

        Deduplicates same source CTs to avoid accidental duplicate training truth.
        """
        output_zip_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT c.*, r.id as rev_id, r.revision_number, r.mask_path, r.mask_sha256,
                       r.volume_ml, r.voxel_count, r.is_empty_mask, r.reviewed_entire_volume,
                       r.reviewer, r.notes as rev_notes, r.created_at as rev_created_at,
                       r.parent_revision, r.seed_job_id, r.seed_tier, r.seed_model_version
                FROM annotation_cases c
                JOIN annotation_revisions r
                  ON c.id = r.case_id AND c.latest_approved_revision = r.revision_number
                WHERE r.status = 'approved' AND r.reviewed_entire_volume = 1
                ORDER BY c.updated_at DESC
                """
            ).fetchall()

        # Deduplicate by canonical source_digest (fallback to source_sha256)
        seen_digests: set[str] = set()
        approved_cases: list[dict[str, Any]] = []
        for row in rows:
            src_digest = (row["source_digest"] if "source_digest" in row.keys() else None) or row["source_sha256"]
            if src_digest in seen_digests:
                continue
            seen_digests.add(src_digest)
            approved_cases.append(dict(row))

        if not approved_cases:
            raise FileNotFoundError("No approved cases with confirmed whole-volume review available for export")

        now_ts = _now()
        manifest_cases: list[dict[str, Any]] = []
        dataset_entries: list[dict[str, str]] = []

        with zipfile.ZipFile(output_zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for idx, item in enumerate(approved_cases, start=1):
                case_name = f"case_{idx:04d}"
                src_path = Path(item["source_path"])
                mask_path = Path(item["mask_path"])

                if not src_path.is_file() or not mask_path.is_file():
                    continue

                archive_src = f"imagesTr/{case_name}_0000.nii.gz"
                archive_mask = f"labelsTr/{case_name}.nii.gz"

                archive.write(src_path, arcname=archive_src)
                archive.write(mask_path, arcname=archive_mask)

                dataset_entries.append({
                    "image": archive_src,
                    "label": archive_mask,
                })

                geometry = json.loads(item["geometry_json"])
                manifest_cases.append({
                    "case_identifier": case_name,
                    "case_id": item["id"],
                    "case_name": item["name"],
                    "study_instance_uid": item["study_instance_uid"],
                    "series_instance_uid": item["series_instance_uid"],
                    "source_sha256": item["source_sha256"],
                    "source_digest": item.get("source_digest", ""),
                    "source_job_id": item["source_job_id"],
                    "revision_number": item["revision_number"],
                    "revision_status": "approved",
                    "mask_sha256": item["mask_sha256"],
                    "volume_ml": item["volume_ml"],
                    "voxel_count": item["voxel_count"],
                    "is_empty_mask": bool(item["is_empty_mask"]),
                    "reviewed_entire_volume": bool(item["reviewed_entire_volume"]),
                    "reviewer": item["reviewer"],
                    "reviewed_at": item["rev_created_at"],
                    "parent_revision": item.get("parent_revision"),
                    "seed_job_id": item["seed_job_id"],
                    "seed_tier": item["seed_tier"],
                    "seed_model_version": item.get("seed_model_version"),
                    "geometry": geometry,
                })

            dataset_json = {
                "channel_names": {"0": "CT"},
                "labels": {"background": 0, "hemorrhage": 1},
                "numTraining": len(dataset_entries),
                "file_ending": ".nii.gz",
                "dataset": dataset_entries,
            }
            manifest_json = {
                "schema_version": "1.0",
                "exported_at": now_ts,
                "dataset_name": "BrainHemorrhage_Reviewed_Doctor_Dataset",
                "num_cases": len(manifest_cases),
                "cases": manifest_cases,
            }

            archive.writestr(
                "dataset.json",
                json.dumps(dataset_json, indent=2, ensure_ascii=False) + "\n",
            )
            archive.writestr(
                "provenance_manifest.json",
                json.dumps(manifest_json, indent=2, ensure_ascii=False) + "\n",
            )
            archive.writestr(
                "manifest.json",
                json.dumps(manifest_json, indent=2, ensure_ascii=False) + "\n",
            )

        return {
            "num_cases": len(dataset_entries),
            "export_path": str(output_zip_path),
            "exported_at": now_ts,
        }

    @staticmethod
    def _to_case(row: sqlite3.Row) -> AnnotationCase:
        geometry = {}
        if row["geometry_json"]:
            try:
                geometry = json.loads(row["geometry_json"])
            except Exception:
                geometry = {}
        case_id = row["id"]
        latest_approved = row["latest_approved_revision"]
        current_rev = row["current_revision"]
        latest_mask_url = f"/api/v1/annotations/cases/{case_id}/revisions/{current_rev}/mask" if current_rev >= 0 else None

        source_digest = row["source_digest"] if "source_digest" in row.keys() else ""
        approved_notes = (row["approved_notes"] if "approved_notes" in row.keys() else None) or ""
        normalized_notes = approved_notes.lower()
        simulated_gt = any(marker in normalized_notes for marker in (
            "not physician review", "gt acceptance", "replaced and compared with",
        ))
        current_parent = row["current_parent_revision"] if "current_parent_revision" in row.keys() else None
        current_seed_job = row["current_seed_job_id"] if "current_seed_job_id" in row.keys() else None
        return AnnotationCase(
            id=case_id,
            name=row["name"],
            study_instance_uid=row["study_instance_uid"],
            series_instance_uid=row["series_instance_uid"],
            source_job_id=row["source_job_id"],
            source_sha256=row["source_sha256"],
            source_digest=source_digest or "",
            status=row["status"],
            current_revision=current_rev,
            latest_approved_revision=latest_approved,
            created_at=datetime.fromisoformat(row["created_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
            geometry=geometry,
            source_url=f"/api/v1/annotations/cases/{case_id}/source",
            latest_mask_url=latest_mask_url,
            label_volume_ml=row["current_volume_ml"] if "current_volume_ml" in row.keys() else None,
            label_voxel_count=(row["current_voxel_count"] if "current_voxel_count" in row.keys() else 0) or 0,
            annotated_by=row["current_reviewer"] if "current_reviewer" in row.keys() else None,
            label_updated=bool(current_seed_job and current_parent is not None),
            label_review_method=("gt_simulation" if simulated_gt else "reviewed_workflow") if latest_approved is not None else None,
            label_reviewed_entire_volume=bool(row["approved_reviewed_entire_volume"] if "approved_reviewed_entire_volume" in row.keys() else False),
            source_type=(row["source_type"] if "source_type" in row.keys() else "research") or "research",
            patient_id=row["patient_id"] if "patient_id" in row.keys() else None,
            patient_name=row["patient_name"] if "patient_name" in row.keys() else None,
            study_date=row["study_date"] if "study_date" in row.keys() else None,
            study_description=row["study_description"] if "study_description" in row.keys() else None,
            accession_number=row["accession_number"] if "accession_number" in row.keys() else None,
            priority=(row["priority"] if "priority" in row.keys() else "routine") or "routine",
            clinical_indication=(row["clinical_indication"] if "clinical_indication" in row.keys() else "") or "",
        )

    @staticmethod
    def _to_revision(row: sqlite3.Row) -> AnnotationRevision:
        case_id = row["case_id"]
        rev_num = row["revision_number"]
        seed_model_version = row["seed_model_version"] if "seed_model_version" in row.keys() else None
        parent_rev = row["parent_revision"] if "parent_revision" in row.keys() else None
        return AnnotationRevision(
            id=row["id"],
            case_id=case_id,
            revision_number=rev_num,
            status=row["status"],
            mask_sha256=row["mask_sha256"],
            volume_ml=row["volume_ml"],
            voxel_count=row["voxel_count"],
            is_empty_mask=bool(row["is_empty_mask"]),
            reviewed_entire_volume=bool(row["reviewed_entire_volume"]),
            reviewer=row["reviewer"],
            notes=row["notes"] or "",
            parent_revision=parent_rev,
            seed_job_id=row["seed_job_id"],
            seed_tier=row["seed_tier"],
            seed_model_version=seed_model_version,
            created_at=datetime.fromisoformat(row["created_at"]),
            mask_url=f"/api/v1/annotations/cases/{case_id}/revisions/{rev_num}/mask",
        )
