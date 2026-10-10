"""Dataset recipes and durable training policies for AI Studio.

Source records are immutable; recipes freeze concrete revisions before a run.
The scheduler is called by the single training worker, never by browser polling.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import threading
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from pydantic import BaseModel, Field

from .mlops_store import WorkflowError, _now, _sha256, summarize_dataset_cases
from .validation import compute_canonical_nifti_digest
from .local_release import LocalReleaseManager


class SourceImport(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    role: str = "development"


class Recipe(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    source_ids: list[str] = Field(default_factory=list)
    include_pool: bool = True
    excluded_annotation_case_ids: list[str] = Field(default_factory=list)
    validation_percent: int = Field(20, ge=10, le=40)
    max_cases_per_source: int = Field(0, ge=0, le=100000)


class TrainingPolicy(BaseModel):
    enabled: bool = False
    trigger: str = "manual"
    recipe_id: str = ""
    base_model_id: str = ""
    model_variant: str = "S"
    min_new_cases: int = Field(10, ge=1, le=100000)
    interval_days: int = Field(7, ge=1, le=365)
    epochs: int = Field(18, ge=1, le=1000)
    learning_rate: float = Field(0.0001, gt=0, le=0.1)
    batch_size: int = Field(4, ge=1, le=128)
    auto_validate: bool = True
    auto_deploy: bool = False
    follow_deployed_model: bool = True
    finetune_scope: str = "adapter_head"


TRAINING_UNAVAILABLE_REASON = "Bản public chỉ có Baseline S ONNX cho inference; chưa cung cấp checkpoint PT/PTH, mã model huấn luyện và training runtime."


class Studio:
    def __init__(self, store, settings):
        self.store, self.settings = store, settings
        self.root = store.root / "studio"
        self.lock = threading.RLock()
        self.releases = LocalReleaseManager(self)

    def initialize(self):
        self.root.mkdir(parents=True, exist_ok=True)
        with self.store._connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS studio_sources (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS studio_recipes (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS imported_models (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
            """)
        self.releases.initialize()

    def records(self, table):
        if table not in {"studio_sources", "studio_recipes", "imported_models"}:
            raise ValueError("Unknown catalog")
        with self.store._connect() as db:
            return [json.loads(row[0]) for row in db.execute(f"SELECT payload FROM {table} ORDER BY rowid DESC")]

    def put(self, table, item):
        if table not in {"studio_sources", "studio_recipes", "imported_models"}:
            raise ValueError("Unknown catalog")
        with self.store._connect() as db:
            db.execute(f"INSERT INTO {table} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
                       (item["id"], json.dumps(item)))
        return item

    def register_directory(self, source_id, name, images, labels, role="development", expected=None):
        """Operator bootstrap: reference existing local data without uploading copies."""
        existing = next((s for s in self.records("studio_sources") if s["id"] == source_id), None)
        if existing and existing["cases"]:
            for case in existing["cases"]:
                if not case.get("source_digest"):
                    case["source_digest"] = compute_canonical_nifti_digest(Path(case["image"]))
            self.put("studio_sources", existing)
            return
        cases = []
        for image in sorted(Path(images).glob("*_0000.nii.gz")):
            key = image.name.removesuffix("_0000.nii.gz")
            mask = Path(labels) / f"{key}.nii.gz"
            if mask.is_file():
                cases.append({"key": f"{source_id}:{key}", "image": str(image.resolve()), "mask": str(mask.resolve()),
                              "image_sha256": _sha256(image), "mask_sha256": _sha256(mask), "revision": 1,
                              "source_digest": compute_canonical_nifti_digest(image)})
        self.put("studio_sources", {"id": source_id, "name": name, "role": role, "cases": cases,
                                   "expected_cases": expected, "created_at": _now(), "origin": "local"})

    def import_zip(self, source: Path, name: str, role: str):
        if role not in {"development", "benchmark"}:
            raise WorkflowError("Vai trò dataset không hợp lệ")
        import nibabel as nib
        import numpy as np
        source_id = str(uuid.uuid4())
        folder = self.root / "sources" / source_id
        folder.mkdir(parents=True)
        try:
            with zipfile.ZipFile(source) as archive:
                members = archive.infolist()
                if sum(m.file_size for m in members) > 30 * 1024**3 or len(members) > 100000:
                    raise WorkflowError("Dataset vượt giới hạn 30 GB giải nén / 100.000 tệp")
                for member in members:
                    path = Path(member.filename)
                    if path.is_absolute() or ".." in path.parts or (member.external_attr >> 16) & 0o170000 == 0o120000:
                        raise WorkflowError("ZIP chứa đường dẫn không hợp lệ")
                archive.extractall(folder)
            cases = []
            for image in sorted(folder.rglob("*_0000.nii.gz")):
                if image.parent.name not in {"imagesTr", "imagesTs"}:
                    continue
                stem = image.name.removesuffix("_0000.nii.gz")
                mask = image.parent.parent / image.parent.name.replace("images", "labels") / f"{stem}.nii.gz"
                if not mask.is_file():
                    raise WorkflowError(f"Thiếu mask: {stem}")
                x, y = nib.load(image), nib.load(mask)
                if len(x.shape) != 3 or x.shape != y.shape or not np.allclose(x.affine, y.affine, atol=1e-3):
                    raise WorkflowError(f"Ảnh / nhãn lệch geometry: {stem}")
                values = np.asarray(y.dataobj)
                if not np.isfinite(values).all() or not np.isin(values, [0, 1]).all():
                    raise WorkflowError(f"Mask {stem} cần là nhãn nhị phân 0/1")
                cases.append({"key": f"{source_id}:{stem}", "image": str(image), "mask": str(mask),
                              "image_sha256": _sha256(image), "mask_sha256": _sha256(mask), "revision": 1,
                              "source_digest": compute_canonical_nifti_digest(image)})
            if not cases:
                raise WorkflowError("ZIP cần imagesTr/*_0000.nii.gz và labelsTr/*.nii.gz (mỗi study một volume)")
            return self.put("studio_sources", {"id": source_id, "name": name.strip(), "role": role,
                                               "cases": cases, "created_at": _now(), "origin": "upload"})
        except Exception as exc:
            shutil.rmtree(folder)
            if isinstance(exc, WorkflowError):
                raise
            raise WorkflowError("Không đọc được dataset ZIP / NIfTI. Kiểm tra định dạng và cặp ảnh, nhãn.") from exc

    def pool(self):
        with self.store._connect() as db:
            rows = db.execute("""SELECT c.id,c.name,c.patient_id,c.source_path,c.source_sha256,c.source_digest,c.current_revision,
                       r.revision_number,r.mask_path,r.mask_sha256,r.status,r.reviewer,r.notes,
                       r.reviewed_entire_volume,r.seed_job_id,r.seed_tier,r.seed_model_version
                FROM annotation_cases c LEFT JOIN annotation_revisions r
                ON r.case_id=c.id AND r.revision_number=c.current_revision""").fetchall()
        reserved = {value for s in self.records("studio_sources") if s["role"] == "benchmark" for c in s["cases"]
                    for value in (c.get("source_digest"), c["image_sha256"]) if value}
        cases, counts = [], {"total": len(rows), "approved": 0, "pending": 0, "benchmark_excluded": 0}
        for row in rows:
            if row["status"] != "approved":
                counts["pending"] += 1
                continue
            if row["source_digest"] in reserved or row["source_sha256"] in reserved:
                counts["benchmark_excluded"] += 1
                continue
            counts["approved"] += 1
            cases.append({"key": "label:" + (row["patient_id"] or row["id"]), "image": row["source_path"],
                          "mask": row["mask_path"], "image_sha256": row["source_sha256"], "mask_sha256": row["mask_sha256"],
                          "revision": row["revision_number"], "annotation_case_id": row["id"], "source_digest": row["source_digest"],
                          "reviewer": row["reviewer"], "notes": row["notes"],
                          "reviewed_entire_volume": bool(row["reviewed_entire_volume"]),
                          "seed_job_id": row["seed_job_id"], "seed_tier": row["seed_tier"],
                          "seed_model_version": row["seed_model_version"]})
        return counts, cases

    def selection(self, recipe):
        sources = {s["id"]: s for s in self.records("studio_sources")}
        selected = []
        excluded_pool_count = 0
        for source_id in recipe["source_ids"]:
            source = sources.get(source_id)
            if not source or not source["cases"]:
                raise WorkflowError("Nguồn dữ liệu chưa có tệp trên máy. Hãy nhập dataset trước.")
            cases = sorted(source["cases"], key=lambda c: hashlib.sha256(c["key"].encode()).hexdigest())
            if recipe["max_cases_per_source"] and source["role"] != "benchmark":
                cases = cases[:recipe["max_cases_per_source"]]
            selected.extend(dict(c, source=source_id, role=source["role"]) for c in cases)
        if recipe["include_pool"]:
            excluded_ids = set(recipe.get("excluded_annotation_case_ids", []))
            for case in self.pool()[1]:
                if case["annotation_case_id"] in excluded_ids:
                    excluded_pool_count += 1
                    continue
                selected.append(dict(case, source="labeling", role="development"))
        # Benchmark membership wins even if the same image was reuploaded or labeled.
        reserved = {value for s in sources.values() if s["role"] == "benchmark" for c in s["cases"]
                    for value in (c.get("source_digest"), c["image_sha256"]) if value}
        seen, result, excluded = set(), [], excluded_pool_count
        original_keys = {c.get("source_digest") or c["image_sha256"]: c["key"]
                         for c in selected if c["source"] != "labeling"}
        original_splits = {c.get("source_digest") or c["image_sha256"]: c.get("split")
                           for c in selected if c["source"] != "labeling"}
        for case in sorted(selected, key=lambda c: 0 if c["role"] == "benchmark" else 1 if c["source"] == "labeling" else 2):
            digest = case.get("source_digest") or case["image_sha256"]
            if digest in seen or case["image_sha256"] in seen or ((digest in reserved or case["image_sha256"] in reserved) and case["role"] != "benchmark"):
                excluded += 1
                continue
            seen.add(digest)
            seen.add(case["image_sha256"])
            # Patient-level assignment is stable across versions and source limits.
            split_key = original_keys.get(digest, case["key"])
            split = "test" if case["role"] == "benchmark" else (
                "validation" if int(hashlib.sha256(split_key.encode()).hexdigest()[:8], 16) / 0xffffffff < recipe["validation_percent"] / 100 else "train")
            fixed_split = original_splits.get(digest)
            if case["role"] != "benchmark" and fixed_split is not None:
                if fixed_split not in {"train", "validation"}:
                    raise WorkflowError("Development source split must be train or validation")
                split = fixed_split
            result.append(dict(case, split=split))
        return result, excluded

    def preview(self, recipe):
        cases, excluded = self.selection(recipe)
        splits = {s: sum(c["split"] == s for c in cases) for s in ("train", "validation", "test")}
        cohorts = summarize_dataset_cases(cases)
        return {"num_cases": len(cases), "splits": splits, "excluded": excluded,
                "ready": all(splits.values()), "pool_cases": cohorts["reviewed_label_cases"],
                "cohorts": cohorts}

    def save_recipe(self, recipe, actor):
        item = dict(recipe, id=str(uuid.uuid4()), created_by=actor, created_at=_now())
        self.preview(item)
        return self.put("studio_recipes", item)

    def freeze(self, recipe_id, actor):
        recipe = next((r for r in self.records("studio_recipes") if r["id"] == recipe_id), None)
        if not recipe:
            raise WorkflowError("Không tìm thấy tập tùy chọn")
        cases, excluded = self.selection(recipe)
        if not all(any(c["split"] == split for c in cases) for split in ("train", "validation", "test")):
            raise WorkflowError("Cần đủ train, validation và benchmark test riêng trước khi tạo phiên bản")
        dataset_id, now = str(uuid.uuid4()), _now()
        folder = self.store.root / "datasets" / dataset_id
        folder.mkdir(parents=True)
        development, holdout = folder / "training-dataset.zip", folder / "locked-holdout.zip"
        manifest = {"schema_version": "4.0", "recipe_id": recipe_id, "name": recipe["name"], "cases": [],
                    "splits": {"train": [], "validation": [], "test": []}, "excluded": excluded,
                    "excluded_annotation_case_ids": recipe.get("excluded_annotation_case_ids", []),
                    "split_policy": {"unit": "patient", "benchmark_isolated": True, "validation_percent": recipe["validation_percent"]}}
        try:
            with zipfile.ZipFile(development, "w", zipfile.ZIP_DEFLATED) as train, zipfile.ZipFile(holdout, "w", zipfile.ZIP_DEFLATED) as test:
                for index, case in enumerate(cases):
                    name = f"studio_{index:05d}"
                    is_test = case["split"] == "test"
                    target, suffix = (test, "Ts") if is_test else (train, "Tr")
                    # Fail rather than silently freezing modified source data.
                    if _sha256(Path(case["image"])) != case["image_sha256"] or _sha256(Path(case["mask"])) != case["mask_sha256"]:
                        raise WorkflowError("Dữ liệu nguồn đã thay đổi; cần nhập một phiên bản nguồn mới")
                    target.write(case["image"], f"images{suffix}/{name}_0000.nii.gz")
                    target.write(case["mask"], f"labels{suffix}/{name}.nii.gz")
                    manifest["splits"][case["split"]].append(name)
                    manifest["cases"].append({k: v for k, v in dict(case, case_name=name).items() if k not in {"image", "mask", "role"}})
                manifest["cohort_summary"] = summarize_dataset_cases(manifest["cases"])
                manifest["provenance_type"] = "labeling_workflow_snapshot" if manifest["cohort_summary"]["reviewed_label_cases"] else "imported_dataset"
                train.writestr("dataset.json", json.dumps({"channel_names": {"0": "CT"}, "labels": {"background": 0, "hemorrhage": 1},
                                                          "numTraining": len(cases) - len(manifest["splits"]["test"]), "file_ending": ".nii.gz"}))
                train.writestr("splits_final.json", json.dumps([{"train": manifest["splits"]["train"], "val": manifest["splits"]["validation"]}]))
                for archive in (train, test):
                    archive.writestr("provenance_manifest.json", json.dumps(manifest))
            with self.store._connect() as db:
                db.execute("""INSERT INTO dataset_versions
                    (id,name,version,description,status,artifact_path,artifact_sha256,manifest_json,num_cases,created_by,created_at,evaluation_path,evaluation_sha256)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""", (dataset_id, recipe["name"], now, "Snapshot nhãn đã duyệt từ workflow Labeling; cohort tham chiếu chỉ dùng đánh giá", "frozen", str(development),
                    _sha256(development), json.dumps(manifest), len(cases), actor, now, str(holdout), _sha256(holdout)))
        except Exception:
            shutil.rmtree(folder)
            raise
        return self.store.get_dataset(dataset_id)

    def policy(self):
        saved = self.store.get_runtime_setting("studio_training_policy")
        defaults = dict(TrainingPolicy().model_dump(), updated_at=None, last_run_id=None, consumed=[])
        return defaults | json.loads(saved) if saved else defaults

    def model_variants(self, model):
        """Return variants that may continue training from this concrete checkpoint."""
        if not model or Path(model.get("artifact_path", "")).suffix.lower() == ".onnx":
            return []
        metrics = model.get("metrics") or {}
        variants = metrics.get("fine_tune_variants") if "fine_tune_variants" in metrics else metrics.get("supported_variants")
        if isinstance(variants, list):
            return [str(value).upper() for value in variants if str(value).upper() in {"S"}]
        variant = metrics.get("model_variant")
        if variant and str(variant).upper() in {"S"}:
            return [str(variant).upper()]
        root_id = self.store.get_runtime_setting("studio_finetune_model_id")
        if model.get("id") == root_id:
            return ["S"]
        parent = self.store.get_model(model.get("parent_model_id")) if model.get("parent_model_id") else None
        return self.model_variants(parent) if parent else []

    def fine_tune_options(self):
        root_id = self.store.get_runtime_setting("studio_finetune_model_id")
        options = []
        for model in self.store.list_models():
            variants = self.model_variants(model)
            if not variants or model.get("stage") in {"rejected", "archived"}:
                continue
            metrics = model.get("metrics") or {}
            options.append({"model_id": model["id"], "name": metrics.get("display_name") or model["name"],
                            "model_variant": variants[0], "variants": variants, "stage": model.get("stage"),
                            "is_baseline": model["id"] == root_id})
        return options

    def training_blocker(self, model_id, model_variant=None):
        model = self.store.get_model(model_id) if model_id else None
        if not model:
            return "Chọn model nền"
        if Path(model.get("artifact_path", "")).suffix.lower() == ".onnx":
            return TRAINING_UNAVAILABLE_REASON
        if model.get("metrics",{}).get("training_runner")=="extension_postprocess":
            return "Model postprocess chỉ dùng hiệu chỉnh và đánh giá; chọn checkpoint Fine-tune gốc"
        variants = self.model_variants(model)
        if not variants:
            return "Model này chưa hỗ trợ Fine-tune"
        selected = (model_variant or variants[0]).upper()
        if selected not in variants:
            return "Model đã chọn không khớp checkpoint Fine-tune"
        if not Path(model["artifact_path"]).is_file():
            return "Thiếu checkpoint model nền"
        if model.get("metrics", {}).get("training_runner") == "extension_runner":
            if not self.settings.training_command:
                return "Chưa cấu hình extension cho training worker"
        elif model.get("imported"):
            return "Chưa cấu hình extension fine-tune tương thích với model đã nhập"
        if model.get("metrics", {}).get("demo_baseline"):
            return "Model demo không tương thích runner segmentation"
        if not self.settings.training_command:
            return "Chưa cấu hình training worker"
        return None

    def save_policy(self, payload, actor):
        if payload["trigger"] not in {"manual", "count", "schedule", "either"}:
            raise WorkflowError("Trigger không hợp lệ")
        if payload["enabled"] and payload["trigger"] == "manual":
            raise WorkflowError("Chọn điều kiện tự động trước khi bật")
        if not any(r["id"] == payload["recipe_id"] for r in self.records("studio_recipes")):
            raise WorkflowError("Hãy chọn tập tùy chọn")
        if not self.store.get_model(payload["base_model_id"]):
            raise WorkflowError("Hãy chọn model nền")
        payload["model_variant"] = str(payload.get("model_variant") or "S").upper()
        variants = self.model_variants(self.store.get_model(payload["base_model_id"]))
        if not variants:
            raise WorkflowError("Model này chưa có biến thể hỗ trợ fine-tune")
        if payload["model_variant"] not in variants:
            raise WorkflowError(f"Model này chỉ hỗ trợ fine-tune biến thể {', '.join(variants)}")
        if payload["finetune_scope"] not in {"adapter_head", "full"}:
            raise WorkflowError("Chế độ fine-tune không hợp lệ")
        model = self.store.get_model(payload["base_model_id"])
        if payload.get("auto_deploy"):
            if not payload.get("auto_validate"):
                raise WorkflowError("Tự deploy bắt buộc bật đánh giá độc lập sau training")
            release_blocker = self.releases.blocker(model)
            if release_blocker:
                raise WorkflowError(release_blocker)
        previous = self.policy()
        changed = any(previous.get(k) != payload[k] for k in ("recipe_id", "base_model_id", "model_variant"))
        item = dict(payload, updated_at=_now(), updated_by=actor,
                    next_at=(datetime.now(timezone.utc) + timedelta(days=payload["interval_days"])).isoformat(),
                    last_run_id=previous.get("last_run_id"), consumed=[] if changed else previous.get("consumed", []), last_error=None)
        if not changed and "consumed_before_launch" in previous:
            item["consumed_before_launch"] = previous["consumed_before_launch"]
        with self.lock:
            self.store.set_runtime_setting("studio_training_policy", json.dumps(item))
        return item

    def policy_status(self):
        policy = self.policy()
        recipe = next((r for r in self.records("studio_recipes") if r["id"] == policy["recipe_id"]), None)
        cases, error = [], None
        if recipe:
            try:
                cases = self.selection(recipe)[0]
            except WorkflowError as exc:
                error = str(exc)
        consumed = set(policy.get("consumed", []))
        new = [c for c in cases if c["split"] != "test" and c["image_sha256"] + ":" + c["mask_sha256"] not in consumed]
        new_pool = [c for c in new if c["source"] == "labeling"]
        active = next((r for r in self.store.list_runs() if r["status"] in {"queued", "running", "validation_queued", "validating"}), None)
        releasing = next((r for r in self.releases.list() if r["status"] in {"queued", "building"}), None)
        if not active and releasing:
            active = {"id": releasing["run_id"]}
        blocker = error or ("Chọn tập tùy chọn" if not recipe else None) or self.training_blocker(policy["base_model_id"], policy.get("model_variant"))
        if not blocker and not all(any(c["split"] == s for c in cases) for s in ("train", "validation", "test")):
            blocker = "Tập dữ liệu cần đủ train, validation và benchmark riêng"
        count_due = len(new_pool) >= policy["min_new_cases"]
        time_due = bool(policy.get("next_at") and datetime.now(timezone.utc) >= datetime.fromisoformat(policy["next_at"]))
        due = (policy["trigger"] == "count" and count_due or policy["trigger"] == "schedule" and time_due or policy["trigger"] == "either" and (count_due or time_due))
        reason = blocker or ("Đang có một lần chạy; lần tiếp theo sẽ chờ" if active else
                            ("Chạy thủ công" if policy["trigger"] == "manual" else "Tự động đang tắt; bật kế hoạch để theo dõi điều kiện") if not policy["enabled"] else "Chưa có dữ liệu / nhãn mới" if not new else
                            "Đủ điều kiện, worker sẽ bắt đầu" if due else
                            f"Chờ {max(0, policy['min_new_cases']-len(new_pool))} nhãn mới hoặc đến lịch" if policy["trigger"] == "either" else
                            "Chờ đến lịch" if policy["trigger"] == "schedule" else f"Chờ thêm {max(0, policy['min_new_cases']-len(new_pool))} nhãn đã duyệt")
        last_snapshot = None
        if policy.get("last_run_id"):
            last_run = self.store.get_run(policy["last_run_id"])
            last_dataset = self.store.get_dataset(last_run["dataset_version_id"]) if last_run else None
            if last_dataset:
                last_snapshot = {"dataset_id": last_dataset["id"], "created_at": last_dataset["created_at"],
                                 "recipe_id": last_dataset.get("manifest", {}).get("recipe_id"),
                                 **last_dataset.get("cohort_summary", {})}
        return dict(policy=policy, recipe=recipe, new_cases=len(new), new_pool_cases=len(new_pool), total_cases=len(cases),
                    blocker=blocker, reason=reason, active_run_id=active["id"] if active else None,
                    due=bool(due and policy["enabled"] and new and not active and not blocker),
                    current_cohorts=summarize_dataset_cases(cases), last_snapshot=last_snapshot)

    def launch(self, actor, automatic=False):
        with self.lock:
            status = self.policy_status()
            if automatic and not status["due"]:
                return None
            if status["blocker"] or status["active_run_id"]:
                raise WorkflowError(status["blocker"] or "Đang có một lần chạy")
            policy = status["policy"]
            dataset = self.freeze(policy["recipe_id"], actor)
            config = {k: policy[k] for k in ("epochs", "learning_rate", "batch_size")}
            config["finetune_scope"] = policy.get("finetune_scope", "adapter_head")
            config["model_variant"] = policy.get("model_variant", "S")
            config.update(amp=True, quality_gate_dice=.5, quality_gate_recall=.8,
                          studio_trigger=policy["trigger"] if automatic else "manual", auto_validate=policy["auto_validate"],
                          auto_deploy=policy.get("auto_deploy", False))
            stamp = datetime.now().astimezone().strftime("%d/%m/%Y · %H:%M")
            run = self.store.create_run(dataset["id"], "fine_tune", f"Model {stamp}", actor, policy["base_model_id"], config)
            policy.update(last_run_id=run["id"], last_error=None, consumed_before_launch=list(policy.get("consumed", [])),
                          consumed=[c["image_sha256"] + ":" + c["mask_sha256"] for c in dataset["manifest"]["cases"] if c["split"] != "test"],
                          next_at=(datetime.now(timezone.utc)+timedelta(days=policy["interval_days"])).isoformat())
            self.store.set_runtime_setting("studio_training_policy", json.dumps(policy))
            return run

    def tick(self):
        try:
            with self.lock:
                policy = self.policy()
                last = self.store.get_run(policy["last_run_id"]) if policy.get("last_run_id") else None
                if last and last["status"] == "failed" and not last.get("model_id") and "consumed_before_launch" in policy:
                    # A runner/system failure did not learn these labels. Keep
                    # them eligible, but require operator re-enable to avoid a
                    # GPU retry loop. Quality-gate failures keep consumption.
                    policy.update(consumed=policy.pop("consumed_before_launch"), enabled=False,
                                  last_error=f"Training failed ({last['id']}): {last.get('error') or 'Unknown runner error'}")
                    self.store.set_runtime_setting("studio_training_policy", json.dumps(policy))
            if self.settings.validation_command:
                for run in self.store.list_runs():
                    if run["status"] == "succeeded" and run.get("config", {}).get("auto_validate"):
                        self.store.queue_validation(run["id"])
            self.releases.tick()
            if policy["enabled"]:
                self.launch("studio-scheduler", automatic=True)
        except Exception as exc:
            with self.lock:
                policy = self.policy()
                policy["last_error"] = str(exc)
                # Avoid repeating a failing freeze/launch indefinitely.
                policy["enabled"] = False
                self.store.set_runtime_setting("studio_training_policy", json.dumps(policy))

    def catalog(self):
        sources = [{k: v for k, v in s.items() if k != "cases"} | {"num_cases": len(s["cases"]), "available": bool(s["cases"]),
                   "workflow_role": "locked_evaluation" if s["role"] == "benchmark" else "reference_cohort",
                   "counts_toward_label_trigger": False,
                   "managed_by": "system" if s.get("origin") == "local" else "user"}
                   for s in self.records("studio_sources")]
        recipes = []
        for recipe in self.records("studio_recipes"):
            try:
                preview = self.preview(recipe)
            except WorkflowError as exc:
                preview = {"ready": False, "error": str(exc), "splits": {}}
            recipes.append(dict(recipe, preview=preview))
        live_release = self.releases.live()
        return {"sources": sources, "recipes": recipes, "pool": self.pool()[0], "training": self.policy_status(),
                "releases": [{k: v for k, v in r.items() if k != "output_dir"} for r in self.releases.list()],
                "auto_deploy": {"configured": self.releases.configured, "scope": "local_research", "supported_variants": ["S"] if self.releases.configured else []},
                "serving": {"model_version": live_release["tag"] if live_release else self.settings.model_version, "backend": self.settings.inference_backend_label,
                            "registered_model_id": self.store.get_runtime_setting("studio_serving_reference"),
                            "fine_tune_model_id": self.store.get_runtime_setting("studio_finetune_model_id")},
                "fine_tune_options": self.fine_tune_options(),
                "model_readiness": {m["id"]: self.training_blocker(m["id"]) for m in self.store.list_models()}}
