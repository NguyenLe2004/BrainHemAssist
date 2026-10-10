import dataclasses
import json
import sys
from types import SimpleNamespace

import nibabel as nib
import requests
from fastapi.testclient import TestClient

from app.main import create_app
from test_annotation import _make_settings, _create_synthetic_ct, _create_mask, TEST_AUTH




def test_approval_uses_verified_account_and_rejects_impersonation(tmp_path):
    settings = _make_settings(tmp_path)
    ct = _create_synthetic_ct(tmp_path / 'ct.nii.gz')
    mask = _create_mask(tmp_path / 'mask.nii.gz', nib.load(ct))
    with TestClient(create_app(settings)) as client:
        with ct.open('rb') as f:
            case = client.post('/api/v1/annotations/cases', files={'file': ('ct.nii.gz', f)}).json()
        route = f"/api/v1/annotations/cases/{case['id']}/revisions"
        payload = {'expected_revision': 0, 'status': 'approved', 'reviewer': 'Forged Doctor', 'reviewed_entire_volume': 'true'}
        with mask.open('rb') as f:
            assert client.post(route, data=payload, files={'file': ('mask.nii.gz', f)}).status_code == 401
        assert client.get(f"/api/v1/annotations/cases/{case['id']}").json()['current_revision'] == 0
        with mask.open('rb') as f:
            result = client.post(route, data=payload, files={'file': ('mask.nii.gz', f)}, headers={'Authorization': TEST_AUTH})
        assert result.status_code == 201
        assert result.json()['reviewer'] == 'test-reviewer'
        # Rotating/removing the account immediately invalidates credentials, even from an open UI.
        from pathlib import Path
        Path(settings.reviewer_accounts_file).write_text('{}')
        assert client.post('/api/v1/reviewer/verify', headers={'Authorization': TEST_AUTH}).status_code == 401


def test_missing_accounts_cannot_approve_and_bad_logins_are_limited(tmp_path):
    settings = _make_settings(tmp_path)
    with TestClient(create_app(dataclasses.replace(settings, reviewer_accounts_file=''))) as client:
        login = client.post('/api/v1/auth/login', json={'username': 'user', 'password': 'user123'})
        assert login.status_code == 200
        bearer = {'Authorization': f"Bearer {login.json()['token']}"}
        verified = client.post('/api/v1/reviewer/verify', headers=bearer)
        assert verified.status_code == 200
        assert verified.json()['reviewer'] == 'user'
        assert client.post('/api/v1/reviewer/verify', headers={'Authorization': TEST_AUTH}).status_code == 401
    with TestClient(create_app(settings)) as client:
        for _ in range(10):
            assert client.post('/api/v1/reviewer/verify', headers={'Authorization': 'Basic !!!!'}).status_code == 401
        assert client.post('/api/v1/reviewer/verify', headers={'Authorization': 'Basic !!!!'}).status_code == 429




def test_expired_ai_job_retains_original_seed_and_approved_revision(tmp_path):
    settings = _make_settings(tmp_path)
    app = create_app(settings)
    ct = _create_synthetic_ct(tmp_path / 'ct.nii.gz')
    original = _create_mask(tmp_path / 'original.nii.gz', nib.load(ct))
    edited = tmp_path / 'edited.nii.gz'
    import numpy as np
    from pathlib import Path
    image = nib.load(original)
    nib.save(nib.Nifti1Image(np.zeros(image.shape, dtype=np.uint8), image.affine), edited)
    with TestClient(app) as client:
        app.state.worker.stop()
        with ct.open('rb') as f:
            case = client.post('/api/v1/annotations/cases', files={'file': ('ct.nii.gz', f)}).json()
        case_id = case['id']
        app.state.store.create('expired-job', 'ct.nii.gz', 'nifti', ct.stat().st_size, ct, original,
                               study_id=f'case:{case_id}', model_version='old-model-L', inference_tier='high')
        seed = app.state.annotation_store.save_revision(case_id, original, 'draft', 0, 'test-reviewer',
            seed_job_id='expired-job', seed_tier='high', seed_model_version='old-model-L')
        approved = app.state.annotation_store.save_revision(case_id, edited, 'approved', 1,
            'test-reviewer', reviewed_entire_volume=True)
        app.state.annotation_store.save_revision(case_id, edited, 'draft', 2, 'test-reviewer')
        with app.state.store._connect() as connection:
            connection.execute("DELETE FROM jobs WHERE id='expired-job'")
        for result in (client.get('/api/v1/annotations/cases').json()['items'][0],
                       client.get(f'/api/v1/annotations/cases/{case_id}').json()):
            assert result['ai_status'] == 'archived'
            assert result['ai_job_id'] is None
            assert result['ai_seed_job_id'] == 'expired-job'
            assert result['ai_model_version'] == 'old-model-L'
            assert result['ai_mask_url'] == seed.mask_url
            assert result['ai_volume_ml'] > 0
            assert result['latest_approved_revision'] == approved.revision_number
            assert result['status'] == 'draft'
        assert client.get(seed.mask_url).content == app.state.annotation_store.get_revision_mask_path(case_id, seed.revision_number).read_bytes()
        assert client.get(seed.mask_url).content != app.state.annotation_store.get_revision_mask_path(case_id, approved.revision_number).read_bytes()
        # Missing AI originals must never fall back to an edited descendant label.
        app.state.annotation_store.get_revision_mask_path(case_id, seed.revision_number).unlink()
        result = client.get(f'/api/v1/annotations/cases/{case_id}').json()
        assert result['ai_status'] is None
        assert result['ai_mask_url'] is None


def test_manual_label_is_not_reported_as_ai(tmp_path):
    app = create_app(_make_settings(tmp_path))
    ct = _create_synthetic_ct(tmp_path / 'ct.nii.gz')
    mask = _create_mask(tmp_path / 'mask.nii.gz', nib.load(ct))
    with TestClient(app) as client:
        app.state.worker.stop()
        with ct.open('rb') as f:
            case = client.post('/api/v1/annotations/cases', files={'file': ('ct.nii.gz', f)}).json()
        app.state.annotation_store.save_revision(case['id'], mask, 'approved', 0,
            'test-reviewer', reviewed_entire_volume=True)
        result = client.get(f"/api/v1/annotations/cases/{case['id']}").json()
        assert result['ai_status'] is None
        assert result['ai_mask_url'] is None

