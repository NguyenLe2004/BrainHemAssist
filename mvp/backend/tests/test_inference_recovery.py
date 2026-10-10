from dataclasses import replace
from pathlib import Path
import threading
import time
import sys
import sqlite3

import nibabel as nib
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.store import JobStore
from app.worker import InferenceWorker
from app.inference import CommandInferenceAdapter


def setup(tmp_path, command=''):
    source=tmp_path/'source.nii.gz'
    nib.save(nib.Nifti1Image(np.zeros((8,9,3),dtype=np.uint8),np.diag([1,1,3,1])),source)
    settings=Settings(feedback_user_password="user123", feedback_admin_password="admin123", rbac_enabled=False, data_dir=tmp_path/'data',database_path=tmp_path/'data/db.sqlite',
        inference_command=command, inference_timeout_seconds=3,max_upload_bytes=1024**2,
        retention_hours=24,worker_poll_seconds=.01,direct_upload_enabled=True,
        inference_retry_base_seconds=.1,inference_wait_seconds=.1,inference_deadline_seconds=30)
    return source, settings


def wait(client, jid, status, timeout=8):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        job=client.get('/api/v1/jobs/'+jid).json()
        if job['status']==status:return job
        time.sleep(.02)
    raise AssertionError(job)


def upload(client, source):
    with source.open('rb') as f:
        r=client.post('/api/v1/jobs',files={'file':('ct.nii.gz',f,'application/gzip')})
    assert r.status_code==202,r.text
    return r.json()['id']


def test_transient_failure_retries_same_job_and_preserves_attempts(tmp_path):
    counter=tmp_path/'count'; helper=tmp_path/'infer.py'
    helper.write_text(f'''from pathlib import Path
import sys, shutil
p=Path({str(counter)!r}); n=int(p.read_text())+1 if p.exists() else 1; p.write_text(str(n))
if n==1: print('connection refused',file=sys.stderr);sys.exit(9)
shutil.copyfile(sys.argv[1],sys.argv[2])
''')
    src,cfg=setup(tmp_path,f'{sys.executable} {helper} {{input}} {{output}}')
    with TestClient(create_app(cfg)) as c:
        jid=upload(c,src); j=wait(c,jid,'succeeded')
        assert j['attempt_count']==2 and counter.read_text()=='2'
        assert j['error_code'] is None and j['has_result']
        assert c.get('/api/v1/jobs').json()['count']==1


def test_retry_budget_stops_at_three(tmp_path):
    src,cfg=setup(tmp_path,f'{sys.executable} -c "import sys; print(\'connection refused\',file=sys.stderr);sys.exit(1)"')
    with TestClient(create_app(cfg)) as c:
        j=wait(c,upload(c,src),'failed')
        assert j['attempt_count']==3 and j['error_code']=='RUNTIME_UNAVAILABLE'
        assert 'đã dừng' in j['error'] and 'đang thử' not in j['error']
        time.sleep(.4)
        assert c.get('/api/v1/jobs/'+j['id']).json()['attempt_count']==3


def test_service_wait_does_not_consume_attempts_and_recovers(tmp_path,monkeypatch):
    src,cfg=setup(tmp_path,f'cp {{input}} {{output}}')
    ready=threading.Event()
    monkeypatch.setattr(CommandInferenceAdapter,'runtime_ready',lambda self,tier:ready.is_set())
    with TestClient(create_app(cfg)) as c:
        jid=upload(c,src);j=wait(c,jid,'service_wait')
        assert j['attempt_count']==0 and not j['has_result']
        time.sleep(.2)
        ready.set()
        j=wait(c,jid,'succeeded');assert j['attempt_count']==1


@pytest.mark.parametrize('kind',['garbage','shape','affine','nan','nonbinary'])
def test_invalid_outputs_never_published_or_retried(tmp_path,kind):
    src,cfg=setup(tmp_path)
    bad=tmp_path/'bad.nii.gz'
    if kind=='garbage':bad.write_bytes(b'garbage')
    else:
        data=np.zeros((4,4,4) if kind=='shape' else (8,9,3),dtype=np.float32)
        if kind=='nan':data[0,0,0]=np.nan
        if kind=='nonbinary':data[0,0,0]=2
        affine=np.diag([1,1,3,1]);affine[0,3]=10 if kind=='affine' else 0
        nib.save(nib.Nifti1Image(data,affine),bad)
    cfg=replace(cfg,inference_command=f'cp {bad} {{output}}')
    with TestClient(create_app(cfg)) as c:
        jid=upload(c,src);j=wait(c,jid,'failed')
        assert j['attempt_count']==1 and j['error_code']=='OUTPUT_INVALID' and not j['has_result']
        assert c.get('/api/v1/jobs/'+jid+'/result').status_code==409


def test_empty_binary_mask_is_valid_result(tmp_path):
    src,cfg=setup(tmp_path,'cp {input} {output}')
    with TestClient(create_app(cfg)) as c:
        j=wait(c,upload(c,src),'succeeded')
        assert j['result']['hemorrhage_volume_ml']==0 and j['has_result']


def store_job(tmp_path):
    src,cfg=setup(tmp_path)
    st=JobStore(cfg.database_path,cfg.data_dir/'jobs');st.initialize()
    out=cfg.data_dir/'jobs/j/mask.nii.gz';out.parent.mkdir(parents=True)
    st.create('j','ct','nifti',src.stat().st_size,src,out,study_id='case:1',model_version='model')
    return st,src,out


def test_initialization_preserves_live_lease(tmp_path):
    st,_,_=store_job(tmp_path)
    claimed=st.claim_next('a',60)
    st.initialize()
    assert st.get('j').status.value=='running'
    assert st.claim_next('b',60) is None
    assert st.heartbeat('j',claimed[-1])


def test_stale_attempt_cannot_publish_after_recovery(tmp_path):
    st,src,out=store_job(tmp_path)
    old=st.claim_next('a',60)
    with st._connect() as db:db.execute("UPDATE jobs SET lease_until='2000-01-01' WHERE id='j'")
    new=st.claim_next('b',60)
    assert new[-1]!=old[-1]
    assert not st.publish('j',old[-1],src,0)
    assert src.exists() and not out.exists()
    assert not st.defer('j',old[-1],'TIMEOUT','old',0)


def test_wait_deadline_ends_job(tmp_path):
    st,_,_=store_job(tmp_path)
    with st._connect() as db:db.execute("UPDATE jobs SET deadline_at='2000-01-01' WHERE id='j'")
    assert st.claim_next() is None
    assert st.get('j').status.value=='failed' and st.get('j').error_code=='WAIT_TIMEOUT'


def test_waiting_job_deduplication(tmp_path):
    st,src,out=store_job(tmp_path)
    claimed=st.claim_next();st.defer('j',claimed[-1],'SERVICE_UNAVAILABLE','wait',30,waiting=True)
    job,new=st.create_or_get_active('other','ct','nifti',src.stat().st_size,src,out,'case:1','model')
    assert job.id=='j' and not new
    assert st.find_latest_by_study(['case:1'],'model').id=='j'


def test_database_dispatcher_error_does_not_kill_worker(tmp_path,monkeypatch):
    src,cfg=setup(tmp_path,'cp {input} {output}')
    app=create_app(cfg);st=app.state.store
    original=st.claim_next; calls=[0]
    def flaky(*a,**k):
        calls[0]+=1
        if calls[0]==1:raise sqlite3.OperationalError('database locked')
        return original(*a,**k)
    monkeypatch.setattr(st,'claim_next',flaky)
    with TestClient(app) as c:
        j=wait(c,upload(c,src),'succeeded')
        assert app.state.worker.alive and j['attempt_count']==1

@pytest.mark.parametrize('changed',[False,True])
def test_save_replay_returns_same_revision_or_rejects_changed_payload(tmp_path,changed):
    from test_annotation import _make_settings, _create_synthetic_ct, _create_mask, TEST_AUTH
    cfg=_make_settings(tmp_path);src=_create_synthetic_ct(tmp_path/'ct.nii.gz')
    mask=_create_mask(tmp_path/'mask.nii.gz',nib.load(src))
    with TestClient(create_app(cfg),headers={'Authorization':TEST_AUTH}) as c:
        with src.open('rb') as f:case=c.post('/api/v1/annotations/cases',files={'file':('ct.nii.gz',f)}).json()
        url=f"/api/v1/annotations/cases/{case['id']}/revisions"
        fields={'expected_revision':0,'status':'draft','operation_id':'test-operation','notes':'a'}
        with mask.open('rb') as f:first=c.post(url,data=fields,files={'file':('mask.nii.gz',f)})
        assert first.status_code==201,first.text
        # Simulate lost HTTP response: replay original request after commit.
        if changed:fields['notes']='different payload'
        with mask.open('rb') as f:replay=c.post(url,data=fields,files={'file':('mask.nii.gz',f)})
        if changed:assert replay.status_code==422
        else:
            assert replay.status_code==201,replay.text
            assert replay.json()['revision_number']==first.json()['revision_number']==1
        assert c.get(f"/api/v1/annotations/cases/{case['id']}").json()['current_revision']==1


def test_file_publication_failure_keeps_previous_revision(tmp_path,monkeypatch):
    from test_annotation import _make_settings, _create_synthetic_ct, _create_mask, TEST_AUTH
    import app.annotation_store as module
    cfg=_make_settings(tmp_path);src=_create_synthetic_ct(tmp_path/'ct.nii.gz')
    mask=_create_mask(tmp_path/'mask.nii.gz',nib.load(src))
    app=create_app(cfg)
    with TestClient(app,headers={'Authorization':TEST_AUTH},raise_server_exceptions=False) as c:
        with src.open('rb') as f:case=c.post('/api/v1/annotations/cases',files={'file':('ct.nii.gz',f)}).json()
        original=module.os.replace
        def disk_full(*a,**k):raise OSError('No space left on device')
        monkeypatch.setattr(module.os,'replace',disk_full)
        with mask.open('rb') as f:r=c.post(f"/api/v1/annotations/cases/{case['id']}/revisions",data={'expected_revision':0,'status':'draft','operation_id':'disk-failure'},files={'file':('mask.nii.gz',f)})
        assert r.status_code==500
        assert app.state.annotation_store.get_case(case['id']).current_revision==0
        monkeypatch.setattr(module.os,'replace',original)


def test_gpu_busy_waits_without_consuming_retry_budget(tmp_path):
    from app.gpu_admission import gpu_slot
    src,cfg=setup(tmp_path,'cp {input} {output}')
    with TestClient(create_app(cfg)) as c:
        with gpu_slot(cfg.data_dir/'gpu-resource.lock'):
            jid=upload(c,src);j=wait(c,jid,'service_wait')
            assert j['attempt_count']==0 and j['error_code']=='GPU_BUSY'
        j=wait(c,jid,'succeeded');assert j['attempt_count']==1


def test_timeout_kills_spawned_process_before_retry(tmp_path):
    from app.inference import InferenceError
    import os
    marker=tmp_path/'child-alive'
    helper=tmp_path/'hang.py'
    helper.write_text(f'''import subprocess,time,sys
subprocess.Popen([sys.executable,'-c',"import time;from pathlib import Path;time.sleep(1);Path({str(marker)!r}).write_text('still running')"])
time.sleep(10)
''')
    src,cfg=setup(tmp_path,f'{sys.executable} {helper} {{input}} {{output}}')
    adapter=CommandInferenceAdapter(settings=cfg,timeout_seconds=.2)
    with pytest.raises(InferenceError) as caught:adapter.run('j',src,tmp_path/'out.nii.gz')
    assert caught.value.code=='TIMEOUT' and caught.value.retryable
    time.sleep(1.1);assert not marker.exists()


def test_expired_running_job_past_deadline_is_not_reclaimed(tmp_path):
    st,_,_=store_job(tmp_path)
    st.claim_next('first',60)
    with st._connect() as db:
        db.execute("UPDATE jobs SET lease_until='2000-01-01', deadline_at='2000-01-01' WHERE id='j'")
    assert st.claim_next('second',60) is None
    job=st.get('j')
    assert job.status.value=='failed' and job.error_code=='WAIT_TIMEOUT'
    assert job.completed_at is not None and job.attempt_count==1


def test_expired_last_attempt_has_completion_time_for_retention(tmp_path):
    st,_,_=store_job(tmp_path)
    st.claim_next('first',60)
    with st._connect() as db:
        db.execute("UPDATE jobs SET lease_until='2000-01-01', attempt_count=max_attempts WHERE id='j'")
    assert st.claim_next('second',60) is None
    assert st.get('j').status.value=='failed' and st.get('j').completed_at is not None
