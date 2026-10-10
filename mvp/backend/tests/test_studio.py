import json
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import nibabel as nib
import numpy as np
import pytest
from dataclasses import replace
from types import SimpleNamespace

from app.annotation_store import AnnotationStore
from app.config import Settings
from app.mlops_store import MLOpsStore, WorkflowError
from app.store import JobStore
from app.studio import Recipe, Studio, TrainingPolicy
from app.mlops_store import _sha256


@pytest.fixture
def studio(tmp_path):
    settings = Settings(feedback_user_password="user123", feedback_admin_password="admin123", rbac_enabled=False, data_dir=tmp_path, database_path=tmp_path/"db.sqlite3", inference_command="",
                        inference_timeout_seconds=10, max_upload_bytes=100000, retention_hours=1,
                        worker_poll_seconds=.1, training_command="real-runner {dataset}", validation_command="validate {model}")
    JobStore(settings.database_path,tmp_path/"jobs").initialize("test")
    annotations = AnnotationStore(settings.database_path,tmp_path/"annotations")
    annotations.initialize()
    store = MLOpsStore(settings.database_path,tmp_path/"mlops")
    store.initialize()
    result = Studio(store,settings)
    result.initialize()
    for source_id, count, role in (("dev",30,"development"),("holdout",2,"benchmark")):
        root = tmp_path/source_id
        images, labels = root/"imagesTr", root/"labelsTr"
        images.mkdir(parents=True); labels.mkdir()
        for index in range(count):
            value = index + (100 if role=="benchmark" else 1)
            image = np.full((8,8,4),value,dtype=np.int16)
            mask = np.zeros((8,8,4),dtype=np.uint8); mask[2:5,2:5,1:3]=1
            nib.save(nib.Nifti1Image(image,np.eye(4)),images/f"case{index}_0000.nii.gz")
            nib.save(nib.Nifti1Image(mask,np.eye(4)),labels/f"case{index}.nii.gz")
        result.register_directory(source_id,source_id,images,labels,role)
    return result, annotations


def setup_recipe(studio):
    return studio.save_recipe(Recipe(name="Custom",source_ids=["dev","holdout"]).model_dump(),"test")


def setup_model(studio, recipe):
    dataset = studio.freeze(recipe["id"],"test")
    run = studio.store.create_run(dataset["id"],"full_retrain","initial","test",None,{})
    path = Path(run["output_dir"])/"model.pt"
    path.write_bytes(b"fixture checkpoint")
    studio.store.finish_training(run["id"],{"model_path":str(path),"metrics":{"architecture":"MONAI Residual UNet 2D"}})
    return studio.store.get_run(run["id"])["model_id"]


def test_freeze_isolates_holdout_and_rejects_modified_sources(studio):
    service,_ = studio
    recipe = setup_recipe(service)
    assert service.preview(recipe)["ready"]
    dataset = service.freeze(recipe["id"],"test")
    with zipfile.ZipFile(dataset["artifact_path"]) as archive:
        assert not any(name.startswith("imagesTs/") for name in archive.namelist())
    with zipfile.ZipFile(dataset["evaluation_path"]) as archive:
        assert len([name for name in archive.namelist() if name.startswith("imagesTs/")]) == 2
    original = {c["key"]:c["split"] for c in dataset["manifest"]["cases"]}
    assert original == {c["key"]:c["split"] for c in service.selection(recipe)[0]}
    source = service.records("studio_sources")[0]["cases"][0]
    Path(source["mask"]).write_bytes(b"modified")
    with pytest.raises(WorkflowError,match="thay đổi"):
        service.freeze(recipe["id"],"test")


def test_pool_excludes_benchmark_even_after_recompression_and_draft(studio,tmp_path):
    service,annotations = studio
    source = next(s for s in service.records("studio_sources") if s["id"]=="holdout")["cases"][0]
    recompressed = tmp_path/"different-filename.nii.gz"
    nib.save(nib.load(source["image"]),recompressed)
    case,_ = annotations.create_case("benchmark-copy","test",recompressed,patient_id="renamed")
    annotations.save_revision(case.id,Path(source["mask"]),"approved",0,"reviewer",reviewed_entire_volume=True)
    counts,cases = service.pool()
    assert counts["benchmark_excluded"] == 1
    assert cases == []
    # A different filename/compression must not bypass benchmark exclusion.
    service.register_directory("duplicate","Duplicate",Path(source["image"]).parent,Path(source["mask"]).parent)
    recipe = Recipe(name="Dedup",source_ids=["dev","holdout","duplicate"]).model_dump()
    selection,excluded = service.selection(recipe)
    assert excluded == 2
    assert len(selection) == 32


def test_approved_pool_overrides_source_label_without_changing_split(studio,tmp_path):
    service,annotations = studio
    recipe = setup_recipe(service)
    source = next(s for s in service.records("studio_sources") if s["id"]=="dev")["cases"][0]
    before = next(c for c in service.selection(recipe)[0] if c["image_sha256"]==source["image_sha256"])
    case,_ = annotations.create_case("corrected","Corrected",Path(source["image"]),patient_id="patient-alias")
    mask = tmp_path/"correction.nii.gz"
    nib.save(nib.Nifti1Image(np.ones((8,8,4),dtype=np.uint8),np.eye(4)),mask)
    annotations.save_revision(case.id,mask,"approved",0,"reviewer",reviewed_entire_volume=True)
    after = next(c for c in service.selection(recipe)[0] if c["image_sha256"]==source["image_sha256"])
    assert after["source"] == "labeling"
    assert after["mask_sha256"] != source["mask_sha256"]
    assert after["split"] == before["split"]


def test_explicit_source_splits_survive_labeling_override(studio, tmp_path):
    service, annotations = studio
    source = next(s for s in service.records("studio_sources") if s["id"] == "dev")
    for index, case in enumerate(source["cases"]):
        case["split"] = "validation" if index < 5 else "train"
    service.put("studio_sources", source)
    recipe = setup_recipe(service)
    target = source["cases"][0]
    case, _ = annotations.create_case("fixed-split", "Fixed split", Path(target["image"]))
    mask = tmp_path / "fixed-mask.nii.gz"
    nib.save(nib.Nifti1Image(np.ones((8, 8, 4), dtype=np.uint8), np.eye(4)), mask)
    annotations.save_revision(case.id, mask, "approved", 0, "reviewer", reviewed_entire_volume=True)
    selected = service.selection(recipe)[0]
    assert sum(c["split"] == "train" for c in selected) == 25
    assert sum(c["split"] == "validation" for c in selected) == 5
    override = next(c for c in selected if c["image_sha256"] == target["image_sha256"])
    assert override["source"] == "labeling" and override["split"] == "validation"


def test_scheduled_launch_is_single_and_persists_consumption(studio):
    service,_ = studio
    recipe = setup_recipe(service)
    model_id = setup_model(service,recipe)
    service.save_policy(TrainingPolicy(enabled=True,trigger="schedule",recipe_id=recipe["id"],base_model_id=model_id,auto_validate=False).model_dump(),"user")
    policy = service.policy()
    policy["next_at"]=(datetime.now(timezone.utc)-timedelta(days=1)).isoformat()
    service.store.set_runtime_setting("studio_training_policy",json.dumps(policy))
    assert service.policy_status()["due"]
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _:service.launch("scheduler",automatic=True),range(2)))
    assert sum(r is not None for r in results) == 1
    run = next(r for r in results if r)
    assert run["config"]["studio_trigger"] == "schedule"
    status = service.policy_status()
    assert status["new_cases"] == 0
    assert status["last_snapshot"]["recipe_id"] == recipe["id"]
    assert status["last_snapshot"]["dataset_id"] == run["dataset_version_id"]
    restarted = Studio(service.store,service.settings)
    assert restarted.policy()["last_run_id"] == run["id"]
    assert not restarted.policy_status()["due"]


def test_count_trigger_only_counts_new_approved_pool_revisions(studio,tmp_path):
    service,annotations = studio
    recipe = setup_recipe(service)
    model_id = setup_model(service,recipe)
    service.save_policy(TrainingPolicy(enabled=True,trigger="count",min_new_cases=1,recipe_id=recipe["id"],base_model_id=model_id).model_dump(),"user")
    assert service.policy_status()["new_cases"] == 30
    assert not service.policy_status()["due"]  # Imported data is not new labeling.
    image = tmp_path/"new-patient.nii.gz"
    nib.save(nib.Nifti1Image(np.full((8,8,4),222,dtype=np.int16),np.eye(4)),image)
    mask = tmp_path/"new-mask.nii.gz"
    nib.save(nib.Nifti1Image(np.ones((8,8,4),dtype=np.uint8),np.eye(4)),mask)
    case,_ = annotations.create_case("new-patient","New",image,patient_id="new")
    annotations.save_revision(case.id,mask,"draft",0,"labeler")
    assert not service.policy_status()["due"]
    annotations.save_revision(case.id,mask,"approved",1,"reviewer",reviewed_entire_volume=True)
    assert service.policy_status()["new_pool_cases"] == 1
    assert service.policy_status()["due"]


def test_runner_failure_restores_consumption_and_requires_reenable(studio):
    service, _ = studio
    recipe = setup_recipe(service)
    model_id = setup_model(service, recipe)
    service.save_policy(TrainingPolicy(enabled=True, trigger="count", recipe_id=recipe["id"],
                        base_model_id=model_id, auto_validate=False).model_dump(), "user")
    policy = service.policy()
    policy["consumed"] = ["previously-successful-label"]
    service.store.set_runtime_setting("studio_training_policy", json.dumps(policy))
    run = service.launch("user")
    assert service.policy()["consumed_before_launch"] == ["previously-successful-label"]
    service.store.fail_work(run["id"], "runner exploded")
    service.tick()
    assert service.policy()["consumed"] == ["previously-successful-label"]
    assert service.policy_status()["new_cases"] == 30
    assert not service.policy()["enabled"]
    assert "runner exploded" in service.policy()["last_error"]
    assert "consumed_before_launch" not in service.policy()
    service.tick()
    assert len(service.store.list_runs()) == 2  # original model and one failed attempt


def test_quality_failure_does_not_retry_consumed_labels(studio):
    service, _ = studio
    recipe = setup_recipe(service)
    model_id = setup_model(service, recipe)
    service.save_policy(TrainingPolicy(enabled=True, trigger="count", recipe_id=recipe["id"],
                        base_model_id=model_id, auto_validate=False).model_dump(), "user")
    run = service.launch("user")
    path = Path(run["output_dir"]) / "trained.pt"
    path.write_bytes(b"fixture checkpoint")
    service.store.finish_training(run["id"], {"model_path": str(path), "metrics": {}})
    service.store.finish_validation(run["id"], {"metrics": {"mean_dice": .1, "lesion_recall": .1}})
    consumed = service.policy()["consumed"]
    service.tick()
    assert service.policy()["enabled"]
    assert service.policy()["consumed"] == consumed
    assert service.policy_status()["new_cases"] == 0


def test_worker_resolves_relative_imported_checkpoint_before_changing_cwd(studio, tmp_path, monkeypatch):
    from dataclasses import replace
    from types import SimpleNamespace
    from app.mlops_store import TrainingWorker
    service, _ = studio
    recipe = setup_recipe(service)
    path = service.root / "relative.pth"
    path.write_bytes(b"fixture")
    monkeypatch.chdir(tmp_path)
    service.put("imported_models", {"id": "relative", "name": "Relative checkpoint", "stage": "reference",
                "imported": True, "artifact_path": str(path.relative_to(tmp_path)),
                "metrics": {"training_runner": "extension_runner", "supported_variants": ["S"]}})
    settings = replace(service.settings, training_command="runner --base {base_model} --config {config}")
    dataset = service.freeze(recipe["id"], "test")
    run = service.store.create_run(dataset["id"], "fine_tune", "Relative path", "test", "relative", {})
    def execute(command, **kwargs):
        config = json.loads((Path(run["output_dir"]) / "config.json").read_text())
        assert config["_base_model_path"] == str(path.resolve())
        assert command[2] == str(path.resolve())
        assert Path(command[4]).is_absolute()
        artifact = Path(run["output_dir"]) / "model.pth"
        artifact.write_bytes(b"trained")
        (Path(run["output_dir"]) / "run-result.json").write_text(json.dumps({"model_path": str(artifact), "metrics": {}}))
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr("app.mlops_store.subprocess.run", execute)
    worker = TrainingWorker(service.store, settings)
    worker._execute(service.store.claim_work())
    assert service.store.get_run(run["id"])["status"] == "succeeded"


def test_imported_baseline_never_goes_to_incompatible_runner(studio):
    service,_ = studio
    recipe = setup_recipe(service)
    path = service.root/"baseline.pth";path.write_bytes(b"baseline")
    service.put("imported_models",{"id":"baseline","name":"Baseline S","artifact_path":str(path),"stage":"reference","imported":True,
                                   "metrics":{"supported_variants":["S"]}})
    service.save_policy(TrainingPolicy(enabled=True,trigger="count",min_new_cases=1,recipe_id=recipe["id"],base_model_id="baseline").model_dump(),"user")
    assert "extension" in service.policy_status()["blocker"]
    with pytest.raises(WorkflowError,match="extension"):
        service.launch("user")
    assert service.store.list_runs() == []


def test_extension_policy_launches_candidate_with_generic_batch(studio):
    from dataclasses import replace
    service,_ = studio
    service.settings=replace(service.settings,training_command="extension-runner train --config {config}")
    recipe=setup_recipe(service)
    path=service.root/"verified-baseline.pth";path.write_bytes(b"fixture")
    service.put("imported_models",{"id":"ready","name":"Baseline","artifact_path":str(path),"stage":"reference","imported":True,
                                   "metrics":{"training_runner":"extension_runner","supported_variants":["S"]}})
    payload=TrainingPolicy(recipe_id=recipe["id"],base_model_id="ready",batch_size=4).model_dump()
    service.save_policy(payload,"user")
    assert service.policy_status()["blocker"] is None
    run=service.launch("user")
    assert run["base_model_id"]=="ready"
    assert run["status"]=="queued"
    assert run["config"]["batch_size"]==4
    assert run["config"]["finetune_scope"]=="adapter_head"
    assert run["config"]["auto_validate"]
    assert service.store.get_model("ready")["stage"]=="reference"
    artifact=Path(run["output_dir"])/"fine-tuned.pth";artifact.write_bytes(b"child")
    service.store.finish_training(run["id"],{"model_path":str(artifact),"metrics":{"training_runner":"extension_runner"}})
    child=service.store.get_model(service.store.get_run(run["id"])["model_id"])
    assert child["metrics"]["model_variant"]=="S"
    assert child["metrics"]["fine_tune_variants"]==["S"]
    assert any(option["model_id"]==child["id"] and option["variants"]==["S"] for option in service.fine_tune_options())


def test_only_configured_baseline_s_can_be_finetuned(studio):
    service,_ = studio
    recipe = setup_recipe(service)
    for model_id in ("baseline-s", "baseline-m"):
        path = service.root/f"{model_id}.pth"
        path.write_bytes(b"fixture")
        service.put("imported_models", {"id":model_id,"name":model_id,"artifact_path":str(path),
                    "stage":"reference","imported":True,"metrics":{"training_runner":"extension_runner"}})
    service.store.set_runtime_setting("studio_finetune_model_id", "baseline-s")
    payload = TrainingPolicy(recipe_id=recipe["id"],base_model_id="baseline-m",batch_size=4).model_dump()
    assert service.training_blocker("baseline-m") == "Model này chưa hỗ trợ Fine-tune"
    with pytest.raises(WorkflowError,match="chưa có biến thể"):
        service.save_policy(payload,"user")


def test_zip_rejects_traversal_and_nonbinary_labels(studio,tmp_path):
    service,_ = studio
    archive = tmp_path/"bad.zip"
    with zipfile.ZipFile(archive,"w") as output:
        output.writestr("../outside.nii.gz",b"bad")
    with pytest.raises(WorkflowError,match="đường dẫn"):
        service.import_zip(archive,"Bad","development")
    assert not (service.root/"sources/outside.nii.gz").exists()
    image = tmp_path/"image.nii.gz"
    mask = tmp_path/"mask.nii.gz"
    nib.save(nib.Nifti1Image(np.ones((8,8,4),dtype=np.int16),np.eye(4)),image)
    nib.save(nib.Nifti1Image(np.full((8,8,4),2,dtype=np.uint8),np.eye(4)),mask)
    with zipfile.ZipFile(archive,"w") as output:
        output.write(image,"imagesTr/case_0000.nii.gz")
        output.write(mask,"labelsTr/case.nii.gz")
    with pytest.raises(WorkflowError,match="0/1"):
        service.import_zip(archive,"Multiclass","development")


def test_policy_api_auth_validation_and_safe_baseline_block(studio):
    from app.main import create_app
    from fastapi.testclient import TestClient
    service,_ = studio
    recipe=setup_recipe(service)
    path=service.root/"baseline.pth";path.write_bytes(b"checkpoint")
    service.put("imported_models",{"id":"baseline","name":"Baseline","imported":True,"stage":"reference","artifact_path":str(path),"benchmark_path":"/private/report.json",
                                   "metrics":{"supported_variants":["S"]}})
    app=create_app(service.settings)
    with TestClient(app) as client:
        payload=TrainingPolicy(recipe_id=recipe["id"],base_model_id="baseline").model_dump()
        assert client.put("/api/v1/studio/policy",json=payload).status_code==401
        response=client.post("/api/v1/auth/login",json={"username":"user","password":"user123"})
        headers={"Authorization":"Bearer "+response.json()["token"]}
        assert client.put("/api/v1/studio/policy",json=payload,headers=headers).status_code==403
        assert client.post("/api/v1/studio/launch",headers=headers).status_code==403
        response=client.post("/api/v1/auth/login",json={"username":"admin","password":"admin123"})
        headers={"Authorization":"Bearer "+response.json()["token"]}
        response=client.put("/api/v1/studio/policy",json=payload,headers=headers)
        assert response.status_code==200,response.text
        assert response.json()["updated_by"]=="admin"
        assert client.put("/api/v1/studio/policy",json=dict(payload,interval_days=0),headers=headers).status_code==422
        status=client.get("/api/v1/studio").json()
        assert status["training"]["policy"]["recipe_id"]==recipe["id"]
        assert client.post("/api/v1/studio/launch",headers=headers).status_code==503
        models=client.get("/api/v1/models").json()["items"]
        assert "artifact_path" not in models[0]
        assert "benchmark_path" not in models[0]
        assert service.store.list_runs()==[]



def test_public_release_hook_cannot_activate_models(studio):
    service, _ = studio
    assert service.releases.configured is False
    with pytest.raises(WorkflowError, match="not included"):
        service.releases.queue("candidate", "operator")
    assert service.releases.live() is None
    assert service.releases.list() == []
    with pytest.raises(WorkflowError, match="unavailable"):
        service.releases.resolve("brainhem-s-auto-unknown")


def test_onnx_cannot_advertise_or_queue_fine_tuning(studio, tmp_path):
    service, _ = studio
    recipe = setup_recipe(service)
    dataset = service.freeze(recipe["id"], "test")
    path = tmp_path / "baseline_s.onnx"
    path.write_bytes(b"synthetic onnx placeholder")
    service.put("imported_models", {"id": "onnx-only", "name": "Baseline S",
        "artifact_path": str(path), "stage": "reference", "imported": True,
        "metrics": {"training_runner": "extension_runner", "fine_tune_variants": ["S"], "allow_fine_tune": True}})
    service.store.set_runtime_setting("studio_finetune_model_id", "onnx-only")
    assert service.model_variants(service.store.get_model("onnx-only")) == []
    assert "ONNX" in service.training_blocker("onnx-only")
    assert not any(option["model_id"] == "onnx-only" for option in service.fine_tune_options())
    for mode in ("fine_tune", "site_adaptation", "full_retrain", "experiment"):
        with pytest.raises(WorkflowError, match="ONNX"):
            service.store.create_run(dataset["id"], mode, "Blocked", "test", "onnx-only", {})
    assert not service.store.list_runs()
