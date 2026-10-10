from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class JobStatus(str, Enum):
    queued = "queued"
    running = "running"
    retry_wait = "retry_wait"
    service_wait = "service_wait"
    succeeded = "succeeded"
    failed = "failed"


class InferenceTier(str, Enum):
    fast = "fast"
    standard = "standard"
    high = "high"


class Job(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    status: JobStatus
    input_type: str
    inference_tier: str = "fast"
    extension_enabled: bool = False
    study_id: str | None = None
    model_version: str | None = None
    original_filename: str
    size_bytes: int
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None
    error: str | None = None
    attempt_count: int = 0
    max_attempts: int = 3
    next_attempt_at: datetime | None = None
    error_code: str | None = None
    progress: int = 0
    stage: str = "queued"
    has_result: bool = False
    result: dict[str, Any] = Field(default_factory=dict)
    artifacts: dict[str, str] = Field(default_factory=dict)
    review: dict[str, str] = Field(default_factory=dict)


class ReviewRequest(BaseModel):
    decision: str
    note: str = ""
    expected_reviewed_at: str | None = None


class JobList(BaseModel):
    items: list[Job]
    count: int
    limit: int
    offset: int


class Health(BaseModel):
    status: str
    inference_configured: bool
    worker_alive: bool
    pacs_configured: bool = False
    dicom_enabled: bool = False
    simulator_enabled: bool = False
    inference_backend: str = "command"
    triton_configured: bool = False
    triton_ready: bool = False
    triton_model: str | None = None


class TierCapability(BaseModel):
    tier: str
    name: str
    description: str
    available: bool
    model_version: str
    command_configured: bool
    service_status: str = "unverified"


class Capabilities(BaseModel):
    direct_upload_enabled: bool
    dicom_enabled: bool
    simulator_enabled: bool
    default_tier: str = "fast"
    tiers: dict[str, TierCapability]
    checked_at: datetime | None = None
    reviewer_auth_configured: bool = False
    medsam2_available: bool = False


class AutomationSettingsUpdate(BaseModel):
    auto_analyze_ct: bool
    inference_tier: InferenceTier = InferenceTier.fast
    extension_enabled: bool = False


class AnnotationCase(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    study_instance_uid: str | None = None
    series_instance_uid: str | None = None
    source_job_id: str | None = None
    source_sha256: str
    source_digest: str = ""
    status: str = "draft"
    current_revision: int = 0
    latest_approved_revision: int | None = None
    created_at: datetime
    updated_at: datetime
    geometry: dict[str, Any] = Field(default_factory=dict)
    source_url: str = ""
    latest_mask_url: str | None = None
    label_volume_ml: float | None = None
    label_voxel_count: int = 0
    label_component_count: int = 0
    labeled_slice_count: int = 0
    annotated_by: str | None = None
    label_updated: bool = False
    label_review_method: str | None = None
    label_reviewed_entire_volume: bool = False
    ai_status: str | None = None
    ai_job_id: str | None = None
    ai_tier: str | None = None
    ai_model_version: str | None = None
    ai_seed_job_id: str | None = None
    ai_mask_url: str | None = None
    ai_volume_ml: float | None = None
    ai_result_at: datetime | None = None
    source_type: str = "research"
    patient_id: str | None = None
    patient_name: str | None = None
    study_date: str | None = None
    study_description: str | None = None
    accession_number: str | None = None
    priority: str = "routine"
    clinical_indication: str = ""


class AnnotationRevision(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    case_id: str
    revision_number: int
    status: str
    mask_sha256: str
    volume_ml: float | None = None
    voxel_count: int = 0
    is_empty_mask: bool = False
    reviewed_entire_volume: bool = False
    reviewer: str
    notes: str = ""
    parent_revision: int | None = None
    seed_job_id: str | None = None
    seed_tier: str | None = None
    seed_model_version: str | None = None
    created_at: datetime
    mask_url: str = ""



class AnnotationCaseCreateRequest(BaseModel):
    name: str | None = None
    study_id: str | None = None
    job_id: str | None = None


class AnnotationCaseList(BaseModel):
    items: list[AnnotationCase]
    count: int
    limit: int
    offset: int


class AnnotationRevisionList(BaseModel):
    items: list[AnnotationRevision]
    count: int


class LearningCandidateCreate(BaseModel):
    job_id: str
    assessment: str
    reasons: list[str] = Field(default_factory=list)
    priority: str = "medium"
    note: str = ""
    created_by: str = "demo-radiologist"


class LearningCandidateUpdate(BaseModel):
    status: str
    assigned_to: str = ""
    annotation_case_id: str | None = None
    note: str = ""


class PeerReviewCreate(BaseModel):
    reviewer: str
    verdict: str
    diagnosis: str = ""
    subtype: str = ""
    note: str = ""


class AdjudicationRequest(BaseModel):
    decision: str
    adjudicator: str
    annotation_case_id: str | None = None
    revision_number: int | None = None
    note: str = ""


class DatasetVersionCreate(BaseModel):
    name: str
    version: str
    created_by: str
    train_ratio: float = Field(0.7, gt=0, lt=1)
    validation_ratio: float = Field(0.15, gt=0, lt=1)
    description: str = ""


class TrainingRunCreate(BaseModel):
    dataset_version_id: str
    mode: str
    name: str
    created_by: str
    base_model_id: str | None = None
    config: dict[str, Any] = Field(default_factory=dict)


class ApprovalCreate(BaseModel):
    gate: str
    decision: str
    approver: str
    note: str = ""


class ModelTransitionRequest(BaseModel):
    target_stage: str
    actor: str
    note: str = ""


class SupportChatRequest(BaseModel):
    question: str = Field(min_length=2, max_length=600)
    session_id: str = Field(min_length=8, max_length=80)
    page: str = Field(default="", max_length=120)


class SupportChatResponse(BaseModel):
    answer: str
    resolved: bool
    source: str
    references: list[dict[str, str]] = Field(default_factory=list)
    quota_remaining: int
    escalated: bool = False


class FeedbackRequest(BaseModel):
    role: str = Field(min_length=2, max_length=60)
    category: str = Field(default="suggestion", min_length=2, max_length=40)
    message: str = Field(min_length=1, max_length=5000)
    contact: str = Field(default="", max_length=160)
    page: str = Field(default="", max_length=200)
    website: str = Field(default="", max_length=200)


class AppLoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=160)


class FeedbackResponse(BaseModel):
    delivered: bool
    reference: str
    message: str
    quota_remaining: int
