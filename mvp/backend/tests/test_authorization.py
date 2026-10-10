import gzip
import sqlite3
import time
from dataclasses import replace
import nibabel as nib
import numpy as np
import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.config import Settings
from app.authorization import ROLE_PERMISSIONS, route_permission
from app.account_store import AccountError, AccountStore

PASSWORD='Only-for-isolated-tests-2026!'
@pytest.fixture
def system(tmp_path):
    cfg=Settings(data_dir=tmp_path/'data',database_path=tmp_path/'jobs.sqlite',inference_command='',inference_timeout_seconds=10,max_upload_bytes=1048576,retention_hours=24,worker_poll_seconds=.05,direct_upload_enabled=True,feedback_admin_password=PASSWORD,feedback_user_password=PASSWORD)
    app=create_app(cfg)
    for role in ['viewer','annotator','doctor','model_admin']:
        app.state.accounts.create('test-'+role,PASSWORD,role)
    with TestClient(app) as c:
        def headers(role):
            u='admin' if role=='admin' else 'test-'+role
            r=c.post('/api/v1/auth/login',json={'username':u,'password':PASSWORD})
            assert r.status_code==200
            c.cookies.clear()
            return {'Authorization':'Bearer '+r.json()['token']}
        yield c,app,headers

def image(): return gzip.compress(nib.Nifti1Image(np.zeros((8,9,3),np.uint8),np.eye(4)).to_bytes())
def create_case(c,h):
    r=c.post('/api/v1/annotations/cases',headers=h,data={'name':'RBAC research CT'},files={'file':('ct.nii.gz',image(),'application/gzip')})
    assert r.status_code==201,r.text
    return r.json()['id']

@pytest.mark.parametrize('path',['/api/v1/annotations/cases','/api/v1/jobs','/api/v1/models','/api/v1/studio','/api/v1/admin/accounts','/api/v1/annotations/cases/hidden/source','/api/v1/jobs/hidden/result'])
def test_anonymous_no_workspace_access(system,path):
    c,_,_=system
    assert c.get(path).status_code==401

@pytest.mark.parametrize('role,permission,allowed',[
 ('viewer','label.edit',False),('viewer','inference.create',False),('annotator','label.edit',True),('annotator','label.approve',False),('doctor','label.approve',True),('doctor','model.deploy',False),('doctor','account.manage',False),('model_admin','model.deploy',True),('model_admin','label.approve',False),('model_admin','model.domain_review',False),('admin','account.manage',True)])
def test_policy_separation(role,permission,allowed): assert (permission in ROLE_PERMISSIONS[role])==allowed

@pytest.mark.parametrize('role',['viewer','annotator','doctor','model_admin'])
def test_no_account_escalation_or_audit_access(system,role):
 c,app,h=system; headers=h(role)
 assert c.post('/api/v1/admin/accounts',headers=headers,json={'username':'escalated','password':PASSWORD,'role':'admin'}).status_code==403
 assert c.get('/api/v1/admin/audit',headers=headers).status_code==403
 assert not any(a['username']=='escalated' for a in app.state.accounts.list_accounts())

@pytest.mark.parametrize('role',['viewer','annotator','doctor'])
def test_no_model_release_or_runtime_change(system,role):
 c,app,h=system; headers=h(role)
 assert c.post('/api/v1/studio/runs/no-run/release',headers=headers,json={}).status_code==403
 assert c.put('/api/v1/mlops/automation',headers=headers,json={'auto_analyze_ct':True,'inference_tier':'fast'}).status_code==403
 assert c.get('/api/v1/studio',headers=headers).status_code==403

def test_real_draft_and_approval_permissions(system):
 c,app,h=system; doctor=h('doctor'); annotator=h('annotator'); viewer=h('viewer'); manager=h('model_admin')
 case=create_case(c,doctor)
 data={'status':'draft','expected_revision':'0','operation_id':'draft-1','reviewer':'forged-admin'}
 r=c.post(f'/api/v1/annotations/cases/{case}/revisions',headers=annotator,data=data,files={'file':('mask.nii.gz',image(),'application/gzip')})
 assert r.status_code==201,r.text
 assert r.json()['reviewer']=='test-annotator'
 for headers in [viewer,manager]:
  assert c.post(f'/api/v1/annotations/cases/{case}/revisions',headers=headers,data={**data,'expected_revision':'1'},files={'file':('m.nii.gz',image())}).status_code==403
 # Approve via same HTTP endpoint must not bypass permission by changing form.
 data={'status':'approved','expected_revision':'1','reviewed_entire_volume':'true','operation_id':'approve-1'}
 r=c.post(f'/api/v1/annotations/cases/{case}/revisions',headers=annotator,data=data,files={'file':('m.nii.gz',image())})
 assert r.status_code==403,r.text
 assert app.state.annotation_store.get_case(case).current_revision==1
 r=c.post(f'/api/v1/annotations/cases/{case}/revisions',headers=doctor,data=data,files={'file':('m.nii.gz',image())})
 assert r.status_code==201,r.text
 assert r.json()['status']=='approved'
 assert c.get(f'/api/v1/annotations/cases/{case}/source',headers=viewer).status_code==200
 assert c.get(f'/api/v1/annotations/cases/{case}/source').status_code==401
 assert c.get('/api/v1/annotations/export',headers=doctor).status_code==403

def test_model_review_gate_payload_cannot_bypass_role(system):
 c,_,h=system
 r=c.post('/api/v1/models/missing/approvals',headers=h('model_admin'),json={'gate':'clinical','decision':'approved','approver':'forged'})
 assert r.status_code==403,r.text
 r=c.post('/api/v1/models/missing/approvals',headers=h('doctor'),json={'gate':'qa','decision':'approved','approver':'forged'})
 assert r.status_code==403,r.text
 # Correct gate reaches business validation (404); no model state mutated.
 assert c.post('/api/v1/models/missing/approvals',headers=h('doctor'),json={'gate':'clinical','decision':'approved','approver':'forged'}).status_code==404

def test_account_change_revokes_old_session(system):
 c,app,h=system; a=h('admin'); token=h('annotator')
 assert c.get('/api/v1/auth/me',headers=token).status_code==200
 r=c.patch('/api/v1/admin/accounts/test-annotator',headers=a,json={'role':'viewer'})
 assert r.status_code==200
 assert c.get('/api/v1/auth/me',headers=token).status_code==401
 assert c.get('/api/v1/auth/me',headers=h('viewer')).json()['permissions']==['case.read','job.read','label.read']
 new=h('annotator')
 assert c.get('/api/v1/auth/me',headers=new).json()['role']=='viewer'
 assert c.patch('/api/v1/admin/accounts/test-annotator',headers=a,json={'active':False}).status_code==200
 assert c.get('/api/v1/auth/me',headers=new).status_code==401
 assert c.post('/api/v1/auth/login',json={'username':'test-annotator','password':PASSWORD}).status_code==401

def test_sessions_survive_process_and_expire_without_plain_tokens(system):
 c,app,h=system; token=h('doctor'); raw=token['Authorization'].split()[1]
 reopened=AccountStore(app.state.accounts.path)
 assert reopened.session(raw)['role']=='doctor'
 with reopened.db() as db:
  rows=list(db.execute('SELECT digest FROM access_sessions'))
  assert all(r['digest']!=raw for r in rows)
  db.execute('UPDATE access_sessions SET expires_at=?',(time.time()-1,))
 assert c.get('/api/v1/auth/me',headers=token).status_code==401

def test_admin_self_lock_last_admin_and_input_validation(system):
 c,app,h=system; a=h('admin')
 for body in [{'active':False},{'role':'viewer'},{'active':'false'},{'bogus':1}]:
  assert c.patch('/api/v1/admin/accounts/admin',headers=a,json=body).status_code==422
 assert c.post('/api/v1/admin/accounts',headers=a,json={'username':'weak','password':'short','role':'doctor'}).status_code==422
 assert c.post('/api/v1/admin/accounts',headers=a,json={'username':'valid','password':PASSWORD,'role':'root'}).status_code==422
 assert c.post('/api/v1/admin/accounts',headers=a,json={'username':'created-doctor','password':PASSWORD,'role':'doctor'}).status_code==201
 assert c.post('/api/v1/admin/accounts',headers=a,json={'username':'created-doctor','password':PASSWORD,'role':'doctor'}).status_code==422
 with pytest.raises(AccountError): app.state.accounts.update('admin','other-admin',active=False)

def test_logout_and_unknown_route_denial_audit_no_secret(system):
 c,app,h=system; a=h('admin'); d=h('doctor')
 assert c.post('/api/v1/auth/logout',headers=d).status_code==204
 assert c.get('/api/v1/jobs',headers=d).status_code==401
 assert c.post('/api/v1/unknown/future-route',headers=a,json={'password':'must-not-be-logged'}).status_code==403
 events=c.get('/api/v1/admin/audit',headers=a).json()['items']
 assert any(e['status']==403 for e in events)
 assert 'must-not-be-logged' not in str(events) and PASSWORD not in str(events)
 assert all('token' not in e for e in events)

def test_every_business_route_has_an_explicit_policy(system):
 _,app,_=system
 public={'/api/v1/auth/login','/api/v1/health','/api/v1/support/status','/api/v1/support/chat','/api/v1/feedback','/api/v1/feedback/status'}
 for route in app.routes:
  path=getattr(route,'path','')
  if not path.startswith('/api/v1/') or path in public:continue
  for method in route.methods-{'OPTIONS'}:
   assert route_permission(method,path) is not None,(method,path)

def test_cookie_thumbnails_and_csrf_guard(system):
 c,app,h=system
 doctor=h('doctor');case=create_case(c,doctor)
 r=c.post('/api/v1/auth/login',json={'username':'test-viewer','password':PASSWORD})
 assert 'HttpOnly' in r.headers['set-cookie'] and 'SameSite=strict' in r.headers['set-cookie']
 assert c.get(f'/api/v1/annotations/cases/{case}/source').status_code==200
 assert c.post('/api/v1/auth/logout',headers={'Origin':'https://attacker.invalid'}).status_code==403
 assert c.post('/api/v1/auth/logout',headers={'Origin':'http://testserver'}).status_code==204
 assert c.get(f'/api/v1/annotations/cases/{case}/source').status_code==401

def test_rate_limit_and_bad_account_types(system):
 c,_,h=system;a=h('admin')
 assert c.patch('/api/v1/admin/accounts/test-viewer',headers=a,json={'password':{'wrong':'type'}}).status_code==422
 for _ in range(10): assert c.post('/api/v1/auth/login',json={'username':'invalid','password':'bad'}).status_code==401
 assert c.post('/api/v1/auth/login',json={'username':'invalid','password':'bad'}).status_code==429

def test_read_model_review_and_inference_roles(system):
 c,_,h=system
 doctor=h('doctor');manager=h('model_admin');viewer=h('viewer');annotator=h('annotator')
 assert c.get('/api/v1/models',headers=doctor).status_code==200
 assert c.get('/api/v1/models',headers=manager).status_code==200
 assert c.get('/api/v1/models',headers=viewer).status_code==403
 case=create_case(c,doctor)
 for headers in [manager,viewer]:
  assert c.post(f'/api/v1/annotations/cases/{case}/inference',headers=headers,json={'inference_tier':'fast','extension_enabled':False}).status_code==403
 # Inference-authorized role reaches configured-runtime validation.
 assert c.post(f'/api/v1/annotations/cases/{case}/inference',headers=annotator,json={'inference_tier':'fast','extension_enabled':False}).status_code==503
 assert c.post('/api/v1/annotations/unknown-future-operation',headers=doctor).status_code==403
