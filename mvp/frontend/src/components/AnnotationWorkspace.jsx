import { useEffect, useRef, useState, useCallback } from "react";
import {
  DRAG_MODE,
  MULTIPLANAR_TYPE,
  NVImage,
  Niivue,
  SHOW_RENDER,
  SLICE_TYPE,
} from "@niivue/niivue";
import {
  API_BASE,
  getCapabilities,
  listAnnotationCases,
  createAnnotationCase,
  getAnnotationCase,
  getAnnotationSourceUrl,
  listAnnotationRevisions,
  getAnnotationMaskUrl,
  saveAnnotationRevision,
  getSavedOperation,
  seedAnnotationFromJob,
  runCaseInference,
  exportDatasetUrl,
  listStudies,
  listJobs,
  getJob,
  fetchWithRetry,
  propagateWithSam2,
} from "../api";
import { draftKey, putDraft, getDraft, removeDraft, matchingDraft } from "../draftStore";
import { alignedSam2Mask } from "../sam2Preview";
import { unionDrawingBounds, updateDrawingTextureBox } from "../drawingTexture";
import { trackJob, jobMessage, ACTIVE_JOB_STATUSES, rememberJob, recalledJob } from "../jobTracking";
import { prepareLabelingCase } from "../labelingHandoff";
import { Icon } from "../icons";
import { attachViewer, disposeViewer } from "../viewerLifecycle";
import { useAppAuth } from "./AppAuth";
import { CONFIDENCE_COLORMAP, installConfidenceColormap } from "../viewerConfidence";
import { fillClosedBrushStroke, rasterizeBrushStroke } from "../brushRaster";
import {updateComponentDisplay,clearComponentDisplay,focusComponentCamera} from "../componentDisplay";
import {displayName, hasApprovedLabel, archivedAiResult} from "../caseLibrary";
import "./AnnotationWorkspace.css";
import "./LabelEditor.css";
import "./LabelDetails.css";

const WINDOWS = {
  brain: { label: "Nhu mô não", level: 40, width: 80 },
  subdural: { label: "Dưới màng cứng", level: 75, width: 215 },
  stroke: { label: "Đột quỵ", level: 40, width: 40 },
  bone: { label: "Cửa sổ xương", level: 600, width: 2800 },
};

const LABEL_VIEWS = [
  { id: "axial", label: "Axial", type: SLICE_TYPE.AXIAL, axis: 2 },
  { id: "coronal", label: "Coronal", type: SLICE_TYPE.CORONAL, axis: 1 },
  { id: "sagittal", label: "Sagittal", type: SLICE_TYPE.SAGITTAL, axis: 0 },
  { id: "render", label: "3D", type: SLICE_TYPE.RENDER, axis: null },
];

const LABEL_DRAW_LUT = {
  R: [0, 255, 255, 42], G: [0, 45, 210, 205], B: [0, 82, 55, 255], A: [0, 255, 255, 210], I: [0, 1, 2, 3],
};

function componentId(region) {
  return region ? `C${region.number}` : "—";
}

function componentSliceText(region) {
  if (!region) return "—";
  const count = region.sliceEnd - region.sliceStart + 1;
  return `Lát ${region.sliceStart + 1}–${region.sliceEnd + 1} · ${count} lát`;
}

function componentCenterText(region) {
  if (!region?.center) return "—";
  return `X ${region.center[0] + 1} · Y ${region.center[1] + 1} · Z ${region.center[2] + 1}`;
}

function stabilizeComponentNumbers(nextRegions, previousRegions) {
  if (!previousRegions.length) return nextRegions;
  const usedNumbers = new Set();
  let nextNumber = previousRegions.reduce((maximum, region) => Math.max(maximum, region.number || 0), 0) + 1;
  for (const region of nextRegions) {
    const exact = previousRegions.find(previous => previous.key === region.key && !usedNumbers.has(previous.number));
    let match = exact;
    if (!match) {
      const candidates = previousRegions
        .filter(previous => !usedNumbers.has(previous.number))
        .map(previous => ({
          previous,
          distance: previous.center.reduce((sum, value, axis) => sum + ((value - region.center[axis]) ** 2), 0),
          allowance: Math.max(36, ((previous.sliceEnd - previous.sliceStart + 1) * 1.5) ** 2),
        }))
        .filter(candidate => candidate.distance <= candidate.allowance)
        .sort((a, b) => a.distance - b.distance);
      match = candidates[0]?.previous || null;
    }
    region.number = match?.number || nextNumber++;
    usedNumbers.add(region.number);
  }
  return nextRegions.sort((a, b) => a.number - b.number);
}

function smoothMaskDisplay(viewer) {
  const gl = viewer?.gl;
  if (!gl || !viewer.drawTexture) return;
  gl.bindTexture(gl.TEXTURE_3D, viewer.drawTexture);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
}

function normalizeBinaryMask(bitmap) {
  if (!bitmap) return false;
  let changed = false;
  for (let index = 0; index < bitmap.length; index += 1) {
    const binary = bitmap[index] > 0 ? 1 : 0;
    if (bitmap[index] !== binary) {
      bitmap[index] = binary;
      changed = true;
    }
  }
  return changed;
}

async function serializeDrawingMask(volume, binaryMask) {
  // Some source CTs carry long DICOM metadata extensions. NiiVue 0.69 writes
  // those extension bytes twice when exporting a drawing, shifting the voxel
  // payload. The server then reads metadata bytes as mask voxels, producing
  // thin fragments on boundary slices and, for some files, a 500 response.
  // Labels do not need source metadata extensions: geometry and affine remain
  // in the NIfTI header, so omit extensions only for this export operation.
  const extensions = volume.extensions;
  volume.extensions = [];
  try {
    return await volume.saveToUint8Array("mask.nii.gz", binaryMask);
  } finally {
    volume.extensions = extensions;
  }
}

function normalizeMaskForSave(bitmap) {
  if (!bitmap) return false;
  let changed = false;
  for (let index = 0; index < bitmap.length; index += 1) {
    const binary = bitmap[index] === 3 ? 0 : (bitmap[index] > 0 ? 1 : 0);
    if (bitmap[index] !== binary) {
      bitmap[index] = binary;
      changed = true;
    }
  }
  return changed;
}

const TIER_META = {
  fast: { label: "S", badge: "S", note: "" },
  standard: { label: "M", badge: "M", note: "" },
  high: { label: "L", badge: "L", note: "" },
};

const VIEW_KEY = "brainhem.label-view.v1";
function readView() {
  try { const v=JSON.parse(sessionStorage.getItem(VIEW_KEY)); return v && typeof v.caseId==="string" && Number.isInteger(v.slice) && v.slice>=0 && WINDOWS[v.windowKey] ? v : null; } catch { return null; }
}

function formatStudyDate(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length !== 8) return value || "Chưa có ngày chụp";
  return `${digits.slice(6, 8)}/${digits.slice(4, 6)}/${digits.slice(0, 4)}`;
}

function caseSourceLabel(caseItem) {
  if (!caseItem) return "Chưa rõ nguồn";
  if (caseItem.series_instance_uid) return `PACS · Series ${caseItem.series_number || "—"}`;
  return "NIfTI nghiên cứu";
}

export default function AnnotationWorkspace({ onSwitchToWorkstation, onDirtyChange, onRegisterBeforeLeave, initialCaseId, onCaseChange }) {
  const {account,authorization}=useAppAuth();
  const canApprove=account.permissions?.includes("label.approve");
  const canInfer=account.permissions?.includes("inference.create");
  const restoreViewRef = useRef(readView());
  const restoreAttemptedRef = useRef(false);
  const [viewerReady, setViewerReady] = useState(false);
  const canvasRef = useRef(null);
  const niivueRef = useRef(null);
  const referenceCanvasRefs = useRef({});
  const referenceCardRefs = useRef({});
  const referenceNiivueRefs = useRef({});
  const crosshairUpdateRef = useRef({ timer: null, pending: null });
  const crosshairLockedRef = useRef(false);
  const referenceResizeRef = useRef(null);
  const referenceRefreshTimerRef = useRef(null);
  const referenceRefreshFrameRef = useRef(null);
  const referenceRefreshSeqRef = useRef(0);
  const brushPreviewRef = useRef(null);
  const brushCursorFrameRef = useRef(null);
  const brushCursorEventRef = useRef(null);
  const originalDrawingRefreshRef = useRef(null);
  const originalDrawSceneRef = useRef(null);
  const strokeDrawFrameRef = useRef(null);
  const strokeTextureFrameRef = useRef(null);
  const strokeRasterFrameRef = useRef(null);
  const strokePathRef = useRef(null);
  const strokeEndTimerRef = useRef(null);
  const postEditTimerRef = useRef(null);
  const drawingSliceScratchRef = useRef({ coronal: null, sagittal: null });
  const loadSeqRef = useRef(0);
  const pollIntervalRef = useRef(null);
  const pollTokenRef = useRef(0);
  const activeCaseIdRef = useRef(null);
  const initialAiSeedAttemptsRef = useRef(new Set());
  const highlightedRegionVoxelsRef = useRef(null);
  const highlightedRegionBoundsRef = useRef(null);
  const highlightRefreshRef = useRef({ frame: null, bounds: null });

  const [caseDrawer, setCaseDrawer] = useState(true);
  const [crosshairLocked, setCrosshairLocked] = useState(false);
  const [caseSearch, setCaseSearch] = useState("");
  const [caseFilter, setCaseFilter] = useState("all");
  const [showFinish, setShowFinish] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [saveConflict, setSaveConflict] = useState(false);
  const [editTick, setEditTick] = useState(0);
  const [labelVisible, setLabelVisible] = useState(true);
  const [outlineOpacity, setOutlineOpacity] = useState(0.95);
  const [hideHeld, setHideHeld] = useState(false);
  const [aiVisible, setAiVisible] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiDisplayMode, setAiDisplayMode] = useState("components");
  const [aiThreshold, setAiThreshold] = useState(0.5);
  const aiVolumeRef = useRef(null);
  const aiReferenceVolumesRef = useRef({});
  const loadingRef = useRef(false);
  const savingRef = useRef(false);
  const strokeRef = useRef(false);
  const editRef = useRef(0);
  const undoRef = useRef([]);
  const redoRef = useRef([]);
  const regionWorkerRef = useRef(null);
  const regionAnalysisTimerRef = useRef(null);
  const regionAnalysisRequestRef = useRef(0);
  const regionsRef = useRef([]);
  const selectedCaseRef = useRef(null);
  const activeToolRef = useRef("pointer");
  const locationRef = useRef(null);
  const selectedRegionKeyRef = useRef(null);
  const selectedRegionKeysRef = useRef(new Set());
  const shiftSelectionHandledRef = useRef(false);
  const pendingRegionCenterRef = useRef(null);
  const propagatePreviewRef = useRef(null);
  const viewModeRef = useRef("axial");
  const reviewedRegionKeysRef = useRef(new Set());
  const [historyTick, setHistoryTick] = useState(0);
  const [markedSlices, setMarkedSlices] = useState([]);
  const [polygon, setPolygon] = useState([]);
  const [polygonClosed, setPolygonClosed] = useState(false);
  const polygonDragRef = useRef(null);
  const [viewMode, setViewMode] = useState("axial");
  const [referencePickerOpen, setReferencePickerOpen] = useState(false);
  const [referenceDockOpen, setReferenceDockOpen] = useState(true);
  const [referenceWidth, setReferenceWidth] = useState(202);
  const [referenceMenu, setReferenceMenu] = useState(null);
  const [enabledReferenceViews, setEnabledReferenceViews] = useState(() => new Set(["axial", "coronal", "sagittal", "render"]));
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [regions, setRegions] = useState([]);
  const [componentStyles,setComponentStyles]=useState({});
  const [focusedRegionKey,setFocusedRegionKey]=useState(null);
  const componentFocusRef=useRef(null);
  const [regionsBusy, setRegionsBusy] = useState(false);
  const [selectedRegionKey, setSelectedRegionKey] = useState(null);
  const [selectedRegionKeys, setSelectedRegionKeys] = useState(() => new Set());
  const [regionMoveStep, setRegionMoveStep] = useState(1);
  const [reviewedRegionKeys, setReviewedRegionKeys] = useState(() => new Set());
  const [mergeSourceKey, setMergeSourceKey] = useState(null);
  const [propagatePreview, setPropagatePreview] = useState(null);
  const [confirmedPropagatedSlices, setConfirmedPropagatedSlices] = useState(() => new Set());
  const [sam2Menu, setSam2Menu] = useState(null);
  const [sam2Busy, setSam2Busy] = useState(false);
  const [sam2Preview, setSam2Preview] = useState(null);

  // System & Capabilities
  const [capabilities, setCapabilities] = useState(null);
  const [pacsStudies, setPacsStudies] = useState([]);
  const [loadingStudies, setLoadingStudies] = useState(false);

  // Annotation Cases
  const [cases, setCases] = useState([]);
  const [loadingCases, setLoadingCases] = useState(false);
  const [selectedCase, setSelectedCase] = useState(null);
  const [revisions, setRevisions] = useState([]);
  const [loadingRevisions, setLoadingRevisions] = useState(false);
  const [displayedRevisionNum, setDisplayedRevisionNum] = useState(0);

  // Editor State
  const [activeTool, setActiveTool] = useState("pointer"); // 'pointer', 'brush', 'eraser', 'fill'
  const [brushSize, setBrushSize] = useState(5);
  const brushSizeRef = useRef(5);
  const [autoConnectBrush, setAutoConnectBrush] = useState(false);
  const autoConnectBrushRef = useRef(false);
  const [windowKey, setWindowKey] = useState(() => restoreViewRef.current?.windowKey || "brain");
  const [actualWindow, setActualWindow] = useState(WINDOWS.brain);
  const [overlayOpacity, setOverlayOpacity] = useState(0.65);
  const [currentSlice, setCurrentSlice] = useState(0);
  const [totalSlices, setTotalSlices] = useState(0);
  const [location, setLocation] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [editorLoading, setEditorLoading] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");

  // Review & Save form
  const [reviewerIdentity, setReviewerIdentity] = useState(account.username);
  const reviewerAuthRef = useRef(authorization);
  const [approvalSummary, setApprovalSummary] = useState(null);
  const [reviewNotes, setReviewNotes] = useState("");
  const [confirmEntireVolume, setConfirmEntireVolume] = useState(false);
  const [provenanceCleared, setProvenanceCleared] = useState(false);
  const [saving, setSaving] = useState(false);

  // Inference in editor
  const [selectedTier, setSelectedTier] = useState("fast");
  const [inferenceJob, setInferenceJob] = useState(null);
  const [inferenceBusy, setInferenceBusy] = useState(false);
  const pendingSaveRef = useRef(null);
  const [recoverableDraft, setRecoverableDraft] = useState(null);
  const [localDraftNotice, setLocalDraftNotice] = useState("");
  const [inferenceDisconnected, setInferenceDisconnected] = useState(false);

  // Modals & local upload
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createMode, setCreateMode] = useState("pacs"); // 'pacs', 'job', 'file'
  const [uploadFile, setUploadFile] = useState(null);
  const [caseNameInput, setCaseNameInput] = useState("");
  const [selectedPacsForCreate, setSelectedPacsForCreate] = useState(null);
  const [jobsList, setJobsList] = useState([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [selectedJobForCreate, setSelectedJobForCreate] = useState(null);

  useEffect(() => {
    activeCaseIdRef.current = selectedCase?.id || null;
    selectedCaseRef.current = selectedCase;
    onCaseChange?.(selectedCase);
    crosshairLockedRef.current = false;
    setCrosshairLocked(false);
  }, [selectedCase]);

  useEffect(() => {
    activeToolRef.current = activeTool;
    if (!["brush", "eraser"].includes(activeTool) && brushPreviewRef.current) {
      brushPreviewRef.current.style.display = "none";
    }
  }, [activeTool]);

  useEffect(() => {
    brushSizeRef.current = brushSize;
    const nv = niivueRef.current;
    if (!nv || !["brush", "eraser"].includes(activeToolRef.current)) return;
    nv.opts.penSize = brushSize;
    nv.penSize = brushSize;
  }, [brushSize]);

  useEffect(() => {
    autoConnectBrushRef.current = autoConnectBrush;
  }, [autoConnectBrush]);

  useEffect(() => {
    regionsRef.current = regions;
  }, [regions]);

  useEffect(() => {
    selectedRegionKeyRef.current = selectedRegionKey;
  }, [selectedRegionKey]);

  useEffect(() => {
    selectedRegionKeysRef.current = selectedRegionKeys;
  }, [selectedRegionKeys]);

  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);

  useEffect(() => {
    reviewedRegionKeysRef.current = reviewedRegionKeys;
  }, [reviewedRegionKeys]);

  useEffect(() => {
    if (!referenceMenu && !sam2Menu) return undefined;
    const close = () => { setReferenceMenu(null); setSam2Menu(null); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [referenceMenu, sam2Menu]);

  useEffect(() => {
    const worker = new Worker(new URL("../workers/regionAnalysis.worker.js", import.meta.url), { type: "module" });
    regionWorkerRef.current = worker;
    worker.onmessage = ({ data }) => {
      if (data.requestId !== regionAnalysisRequestRef.current) return;
      setRegionsBusy(false);
      if (data.error) {
        setError(data.error);
        return;
      }
      const nextRegions = stabilizeComponentNumbers(data.regions || [], regionsRef.current);
      setMarkedSlices(data.markedSlices || []);
      regionsRef.current = nextRegions;
      setRegions(nextRegions);
      const validKeys = new Set(nextRegions.map(region => region.key));
      // Region review is intentionally memory-only and bound to this loaded
      // mask. Never restore another person's clicks from shared browser storage.
      const nextReviewed = new Set([...reviewedRegionKeysRef.current].filter(key => validKeys.has(key)));
      reviewedRegionKeysRef.current = nextReviewed;
      setReviewedRegionKeys(nextReviewed);
      const currentKey = selectedRegionKeyRef.current;
      const pendingCenter = pendingRegionCenterRef.current;
      const movedRegion = pendingCenter && nextRegions.length
        ? nextRegions.reduce((best, region) => {
            const distance = region.center.reduce((sum, value, axis) => sum + ((value - pendingCenter[axis]) ** 2), 0);
            return !best || distance < best.distance ? { region, distance } : best;
          }, null)?.region
        : null;
      pendingRegionCenterRef.current = null;
      const nextSelection = movedRegion?.key || (validKeys.has(currentKey) && !nextReviewed.has(currentKey)
        ? currentKey
        : nextRegions.find(region => !nextReviewed.has(region.key))?.key || (validKeys.has(currentKey) ? currentKey : nextRegions[0]?.key) || null);
      const retainedSelection = new Set([...selectedRegionKeysRef.current].filter(key => validKeys.has(key)));
      if (movedRegion) {
        retainedSelection.clear();
        retainedSelection.add(movedRegion.key);
      }
      if (nextSelection) retainedSelection.add(nextSelection);
      selectedRegionKeyRef.current = nextSelection;
      selectedRegionKeysRef.current = retainedSelection;
      setSelectedRegionKey(nextSelection);
      setSelectedRegionKeys(retainedSelection);
      setMergeSourceKey(null);
      highlightRegionsInViewer(nextRegions.filter(region => retainedSelection.has(region.key)));
    };
    worker.onerror = () => {
      setRegionsBusy(false);
      setError("Không thể phân tích các vùng xuất huyết trên mặt nạ.");
    };
    return () => {
      if (regionAnalysisTimerRef.current) clearTimeout(regionAnalysisTimerRef.current);
      worker.terminate();
      regionWorkerRef.current = null;
    };
  }, []);

  // Bridge dirty state to parent App component
  useEffect(() => {
    if (typeof onDirtyChange === "function") {
      onDirtyChange(dirty || saving || polygon.length > 0 || Boolean(propagatePreview) || Boolean(sam2Preview));
    }
  }, [dirty, saving, polygon.length, propagatePreview, sam2Preview, onDirtyChange]);

  // Clean up polling interval on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        pollIntervalRef.current();
        pollIntervalRef.current = null;
      }
    };
  }, []);

  // Load capabilities & cases
  useEffect(() => {
    getCapabilities()
      .then((cap) => {
        setCapabilities(cap);
        const tiers = cap?.tiers || {};
        let chosen = cap?.default_tier || "fast";
        if (account.role==="admin" && !tiers[chosen]?.available) {
          if (tiers.standard?.available) chosen = "standard";
          else if (tiers.fast?.available) chosen = "fast";
          else if (tiers.high?.available) chosen = "high";
          else {
            const firstAvail = Object.keys(tiers).find((t) => tiers[t]?.available);
            if (firstAvail) chosen = firstAvail;
          }
        }
        if (account.role==="admin" && !tiers[chosen]?.command_configured && tiers.standard?.command_configured) chosen = "standard";
        setSelectedTier(chosen);
      })
      .catch((err) => setError(`Không thể kết nối máy chủ: ${err.message}`));

    refreshCases();
  }, []);

  useEffect(() => {
    let alive = true;
    let checking = false;
    const timer = setInterval(async () => {
      if (checking) return;
      checking = true;
      try { const cap = await getCapabilities(); if (alive) setCapabilities(cap); }
      catch { if (alive) setCapabilities(null); }
      finally { checking = false; }
    }, 15000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  useEffect(() => {
    reviewerAuthRef.current = authorization;
    setReviewerIdentity(account.username);
  }, [account.username, authorization]);

  function requireEditorIdentity() {
    if (reviewerIdentity && reviewerAuthRef.current) return true;
    setFeedback("Phiên BrainHem đã hết hạn. Hãy đăng nhập lại ở màn hình chính.");
    return false;
  }

  function requestApproval() {
    const nv = niivueRef.current;
    if (!nv || !selectedCase || editorLoading) return;
    const hasLabel = Boolean(nv.drawBitmap?.some(value => value === 1 || value === 2));
    setApprovalSummary({ caseId: selectedCase.id, name: selectedCase.name, revision: displayedRevisionNum, hasLabel });
  }

  function refreshCases() {
    setLoadingCases(true);
    listAnnotationCases(100, 0)
      .then((data) => {
        setCases(data.items || []);
        setLoadingCases(false);
      })
      .catch((err) => {
        setError(`Lỗi tải danh sách ca: ${err.message}`);
        setLoadingCases(false);
      });
  }

  function loadPacsForModal() {
    setLoadingStudies(true);
    listStudies()
      .then((res) => {
        setPacsStudies(res.items || []);
        setLoadingStudies(false);
      })
      .catch(() => setLoadingStudies(false));
  }

  function loadJobsForModal() {
    setLoadingJobs(true);
    listJobs(50, 0)
      .then((res) => {
        setJobsList(res.items || []);
        setLoadingJobs(false);
      })
      .catch(() => setLoadingJobs(false));
  }

  async function ensureReferenceViewers() {
    for (const item of LABEL_VIEWS) {
      const canvas = referenceCanvasRefs.current[item.id];
      if (!canvas) continue;
      if (referenceNiivueRefs.current[item.id]) {
        if (!await attachViewer(referenceNiivueRefs.current[item.id], canvas)) return null;
        continue;
      }
      const reference = new Niivue({
        backColor: [0.015, 0.022, 0.032, 1],
        crosshairColor: [0.15, 0.88, 0.82, 0.82],
        crosshairWidth: 1.1,
        dragMode: item.id === "render" ? DRAG_MODE.crosshair : DRAG_MODE.pan,
        isColorbar: false,
        isCornerOrientationText: true,
        isOrientationTextVisible: true,
        isRadiologicalConvention: true,
        show3Dcrosshair: true,
        textHeight: 0.055,
        mouseEventConfig: {
          leftButton: { primary: item.id === "render" ? DRAG_MODE.crosshair : DRAG_MODE.pan },
          rightButton: DRAG_MODE.none,
          centerButton: DRAG_MODE.pan,
        },
        // Linear texture filtering below already keeps mask edges pleasant. The
        // optional 3D blur is prohibitively expensive with several MPR canvases.
        smoothDrawing: 0,
      });
      installConfidenceColormap(reference);
      // Register before awaiting init so unmount can release this context too.
      referenceNiivueRefs.current[item.id] = reference;
      try {
        if (!await attachViewer(reference, canvas)) return null;
      } catch (error) {
        if (referenceNiivueRefs.current[item.id] === reference) delete referenceNiivueRefs.current[item.id];
        disposeViewer(reference);
        throw error;
      }
      reference.setMouseEventConfig({
        leftButton: { primary: item.id === "render" ? DRAG_MODE.crosshair : DRAG_MODE.pan },
        rightButton: DRAG_MODE.none,
        centerButton: DRAG_MODE.pan,
      });
      reference.setSliceType(item.type);
      reference.onLocationChange = () => {};
      referenceNiivueRefs.current[item.id] = reference;
    }
    return referenceNiivueRefs.current;
  }

  function syncLabelCrosshair(source) {
    const position = source?.scene?.crosshairPos;
    if (!position) return;
    const targets = [niivueRef.current, ...Object.values(referenceNiivueRefs.current)];
    targets.forEach((target) => {
      if (!target || target === source) return;
      target.scene.crosshairPos = [...position];
      target.drawScene();
    });
  }

  function updateLabelCrosshair(viewer, x, y, viewId) {
    if (!viewer?.volumes?.[0]) return;
    if (viewId === 'render') {
      const dpr = viewer.uiData?.dpr || window.devicePixelRatio || 1;
      viewer.mousePos = [x * dpr, y * dpr];
      viewer.uiData.mouseDepthPicker = true;
      viewer.drawScene();
      viewer.drawScene();
    } else {
      viewer.mouseClick(x, y);
      viewer.drawScene();
    }
    viewer.createOnLocationChange?.();
    const activeView = LABEL_VIEWS.find(item => item.id === viewModeRef.current);
    if (Number.isInteger(activeView?.axis)) {
      const total = viewer.volumes[0].dimsRAS?.[activeView.axis + 1] || 1;
      const next = Math.max(0, Math.min(total - 1, Math.floor((viewer.scene.crosshairPos?.[activeView.axis] ?? 0.5) * total)));
      setCurrentSlice(next);
    }
    syncLabelCrosshair(viewer);
  }

  function followLabelCrosshair(event) {
    const viewer = niivueRef.current;
    const canvas = canvasRef.current;
    if (crosshairLockedRef.current || event.buttons !== 0 || !['pointer', 'pan'].includes(activeToolRef.current) || !viewer?.volumes?.[0] || !canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const viewId = viewModeRef.current;
    crosshairUpdateRef.current.pending = { viewer, x: event.clientX - bounds.left, y: event.clientY - bounds.top, viewId };
    if (crosshairUpdateRef.current.timer) return;
    crosshairUpdateRef.current.timer = setTimeout(() => {
      const pending = crosshairUpdateRef.current.pending;
      crosshairUpdateRef.current.timer = null;
      if (pending) updateLabelCrosshair(pending.viewer, pending.x, pending.y, pending.viewId);
    }, viewId === 'render' ? 70 : 28);
  }

  function toggleLabelCrosshairLock(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!['pointer', 'pan'].includes(activeToolRef.current)) return;
    const next = !crosshairLockedRef.current;
    if (next) {
      const canvas = canvasRef.current;
      const viewer = niivueRef.current;
      if (canvas && viewer?.volumes?.[0]) {
        const bounds = canvas.getBoundingClientRect();
        updateLabelCrosshair(viewer, event.clientX - bounds.left, event.clientY - bounds.top, viewModeRef.current);
      }
    }
    crosshairLockedRef.current = next;
    setCrosshairLocked(next);
  }

  function regionAtCanvasPointer(event) {
    const nv=niivueRef.current,canvas=canvasRef.current,dims=nv?.volumes?.[0]?.dimsRAS;
    if(!canvas||!dims||viewModeRef.current==="render"||!Number.isFinite(event?.clientX)||!Number.isFinite(event?.clientY))return null;
    const box=canvas.getBoundingClientRect();
    if(!box.width||!box.height)return null;
    const frac=nv.canvasPos2frac([
      (event.clientX-box.left)*canvas.width/box.width,
      (event.clientY-box.top)*canvas.height/box.height,
    ]);
    if(!frac||!frac.every(value=>Number.isFinite(value)&&value>=0&&value<=1))return null;
    const voxel=nv.frac2vox(frac).map((value,index)=>Math.max(0,Math.min(dims[index+1]-1,Math.round(value))));
    return findRegionNearVoxel(voxel,dims);
  }

  function openMainContextMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedCase || editorLoading || sam2Busy || sam2Preview || propagatePreview || polygon.length) return;
    const hit=regionAtCanvasPointer(event);
    if(hit&&!selectedRegionKeysRef.current.has(hit.key))selectRegion(hit,false,event.shiftKey);
    setSam2Menu({ x: Math.max(8,Math.min(event.clientX,innerWidth-390)), y: Math.max(8,Math.min(event.clientY,innerHeight-520)) });
  }

  function exitComponentFocus() {
    const previous=componentFocusRef.current,nv=niivueRef.current;
    componentFocusRef.current=null;setFocusedRegionKey(null);
    if(!previous||!nv)return;
    changeLabelView(previous.view);
    nv.scene.crosshairPos=previous.crosshair;
    nv.setPan2Dxyzmm(previous.pan);
    crosshairLockedRef.current=previous.locked;setCrosshairLocked(previous.locked);
    clearComponentDisplay(nv);nv.createOnLocationChange();syncLabelCrosshair(nv);
  }

  function spotlightSelectedRegion() {
    const selected=regionsRef.current.filter(region=>selectedRegionKeysRef.current.has(region.key)),nv=niivueRef.current;
    if(!selected.length||!nv)return;
    const bounds=selected.reduce((combined,region)=>({
      minX:Math.min(combined.minX,region.bounds.minX),maxX:Math.max(combined.maxX,region.bounds.maxX),
      minY:Math.min(combined.minY,region.bounds.minY),maxY:Math.max(combined.maxY,region.bounds.maxY),
      minZ:Math.min(combined.minZ,region.bounds.minZ),maxZ:Math.max(combined.maxZ,region.bounds.maxZ),
    }),{...selected[0].bounds});
    const region={bounds,center:[(bounds.minX+bounds.maxX)/2,(bounds.minY+bounds.maxY)/2,(bounds.minZ+bounds.maxZ)/2]};
    if(!componentFocusRef.current)componentFocusRef.current={pan:[...nv.scene.pan2Dxyzmm],crosshair:[...nv.scene.crosshairPos],view:viewModeRef.current,locked:crosshairLockedRef.current};
    if(viewModeRef.current==="render")changeLabelView("axial");
    focusComponentCamera(nv,region);setFocusedRegionKey([...selectedRegionKeysRef.current]);
    crosshairLockedRef.current=true;setCrosshairLocked(true);
    syncLabelCrosshair(nv);setSam2Menu(null);
  }

  function setRegionStyle(field,value) {
    const keys=[...selectedRegionKeysRef.current];if(!keys.length)return;
    setComponentStyles(previous=>{
      const next={...previous};
      keys.forEach(key=>{next[key]={...next[key],[field]:Number(value)};});
      return next;
    });
  }

  function resetSelectedRegionStyles() {
    const keys=selectedRegionKeysRef.current;if(!keys.size)return;
    setComponentStyles(previous=>{
      const next={...previous};
      keys.forEach(key=>delete next[key]);
      return next;
    });
  }

  async function requestSam2Propagation() {
    const nv = niivueRef.current;
    setSam2Menu(null);
    if (!nv?.drawBitmap || !nv.volumes?.[0] || !selectedCase || !requireEditorIdentity()) return;
    const selected = regionsRef.current.filter(item => selectedRegionKeysRef.current.has(item.key));
    const region = selected[0];
    if (selected.length !== 1 || !region || regionsBusy) {
      setError("Hãy chọn đúng một component C1/C2… trước khi Predict with MedSAM2.");
      return;
    }
    // SAM2 must receive only the selected connected component. Sending the
    // complete annotation would merge unrelated hemorrhages into one object.
    const binary = new Uint8Array(nv.drawBitmap.length);
    for (const index of region.voxels) binary[index] = 1;
    const requestCaseId = selectedCase.id;
    const requestSequence = loadSeqRef.current;
    const requestEdit = editRef.current;
    const background = nv.volumes[0];
    const isCurrent = () => activeCaseIdRef.current === requestCaseId &&
      loadSeqRef.current === requestSequence && niivueRef.current === nv &&
      nv.volumes[0] === background;
    setSam2Busy(true);
    setError("");
    setFeedback(`MedSAM2 CT đang lan truyền riêng ${componentId(region)}…`);
    try {
      const bytes = await serializeDrawingMask(background, binary);
      if (!isCurrent()) return;
      const { blob, metadata } = await propagateWithSam2(
        requestCaseId,
        new Blob([bytes], { type: "application/gzip" }),
        reviewerAuthRef.current,
      );
      if (!isCurrent()) return;
      const image = await NVImage.loadFromFile({
        file: new File([blob], "sam2-preview.nii.gz", { type: "application/gzip" }),
        name: "MedSAM2 preview",
      });
      if (!isCurrent()) return;
      if (editRef.current !== requestEdit) throw new Error("Nhãn đã thay đổi trong lúc dự đoán; hãy chạy lại trên nhãn hiện tại");
      const prediction = alignedSam2Mask(image, background);
      if (prediction.length !== nv.drawBitmap.length) throw new Error("SAM2 trả về mask sai kích thước");
      const before = nv.drawBitmap.slice();
      const indices = [];
      for (let index = 0; index < prediction.length; index += 1) {
        if (prediction[index] > 0 && before[index] === 0) indices.push(index);
      }
      if (!indices.length) {
        setFeedback(`MedSAM2 không mở rộng thêm ${componentId(region)}; nhãn hiện tại được giữ nguyên.`);
        return;
      }
      checkpoint();
      for (const index of indices) nv.drawBitmap[index] = 3;
      const dims = nv.volumes[0].dimsRAS;
      const stride = dims[1] * dims[2];
      const slices = [...new Set(indices.map(index => Math.floor(index / stride)))].sort((a, b) => a - b);
      const preview = {
        before,
        indices,
        slices,
        componentKey: region.key,
        componentNumber: region.number,
        componentSliceStart: region.sliceStart,
        componentSliceEnd: region.sliceEnd,
        metadata,
      };
      setSam2Preview(preview);
      refreshPropagationDrawing();
      const firstAfterSeed = slices.find(slice => slice > region.sliceEnd) ?? slices[0];
      if (Number.isInteger(firstAfterSeed)) handleSliceChange(firstAfterSeed);
      setFeedback(`MedSAM2 đã tạo preview riêng cho ${componentId(region)} trên ${slices.length} lát. Rà từng lát rồi duyệt hoặc bỏ.`);
    } catch (err) {
      if (isCurrent()) setError(`Predict with MedSAM2 thất bại: ${err.message}`);
    } finally {
      if (isCurrent()) setSam2Busy(false);
    }
  }

  function acceptSam2Preview() {
    const nv = niivueRef.current;
    if (!nv?.drawBitmap || !sam2Preview) return;
    for (const index of sam2Preview.indices) if (nv.drawBitmap[index] === 3) nv.drawBitmap[index] = 1;
    setSam2Preview(null);
    refreshPropagationDrawing();
    changed();
    setFeedback("Đã duyệt và giữ prediction của SAM2 trong bản nháp. Bạn vẫn có thể hoàn tác.");
  }

  function rejectSam2Preview() {
    const nv = niivueRef.current;
    if (!nv?.drawBitmap || !sam2Preview) return;
    nv.drawBitmap.set(sam2Preview.before);
    // The pre-inference checkpoint is unnecessary after an explicit rejection.
    undoRef.current.pop();
    setHistoryTick(value => value + 1);
    setSam2Preview(null);
    refreshPropagationDrawing();
    setFeedback("Đã bỏ toàn bộ prediction của SAM2; các lát vẽ tay được giữ nguyên.");
  }

  function moveSam2PreviewSlice(direction) {
    if (!sam2Preview?.slices?.length) return;
    const slices = sam2Preview.slices;
    let position = slices.findIndex(slice => slice === currentSlice);
    if (position < 0) {
      position = direction > 0 ? slices.findIndex(slice => slice > currentSlice) : -1;
      if (direction < 0) {
        for (let index = slices.length - 1; index >= 0; index -= 1) {
          if (slices[index] < currentSlice) { position = index; break; }
        }
      }
      if (position < 0) position = direction > 0 ? 0 : slices.length - 1;
    } else {
      position = (position + direction + slices.length) % slices.length;
    }
    handleSliceChange(slices[position]);
  }

  function zoomLabelReference(item, event) {
    const reference = referenceNiivueRefs.current[item.id];
    if (!reference?.volumes?.[0]) return;
    event.preventDefault();
    event.stopPropagation();
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    if (item.id === "render") {
      reference.scene.volScaleMultiplier = Math.max(0.35, Math.min(8, (reference.scene.volScaleMultiplier || 1) * factor));
      reference.drawScene();
      return;
    }
    const transform = [...reference.scene.pan2Dxyzmm];
    transform[3] = Math.max(0.5, Math.min(12, transform[3] * factor));
    reference.setPan2Dxyzmm(transform);
  }

  function beginLabelReferenceResize(event) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    referenceResizeRef.current = { startX: event.clientX, startWidth: referenceWidth };
  }

  function moveLabelReferenceResize(event) {
    const resize = referenceResizeRef.current;
    if (!resize) return;
    event.preventDefault();
    setReferenceWidth(Math.max(150, Math.min(430, resize.startWidth + resize.startX - event.clientX)));
  }

  function endLabelReferenceResize(event) {
    if (!referenceResizeRef.current) return;
    referenceResizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    requestAnimationFrame(() => Object.values(referenceNiivueRefs.current).forEach((reference) => reference?.resizeListener()));
  }

  function resetLabelReference(item) {
    const reference = referenceNiivueRefs.current[item.id];
    if (!reference) return;
    reference.setPan2Dxyzmm([0, 0, 0, 1]);
    if (item.id === "render") {
      reference.scene.volScaleMultiplier = 1;
      reference.setRenderAzimuthElevation(0, 0);
    }
  }

  async function fullscreenLabelReference(item) {
    const card = referenceCardRefs.current[item.id];
    if (!card?.requestFullscreen) return;
    await card.requestFullscreen();
    requestAnimationFrame(() => referenceNiivueRefs.current[item.id]?.resizeListener());
  }

  function hideLabelReference(item) {
    setEnabledReferenceViews((current) => {
      const next = new Set(current);
      next.delete(item.id);
      return next;
    });
    setReferenceMenu(null);
  }

  function refreshReferenceDrawings() {
    const source = niivueRef.current;
    if (!source?.drawBitmap) return;
    const seq = ++referenceRefreshSeqRef.current;
    const references = LABEL_VIEWS
      .filter(item => enabledReferenceViews.has(item.id))
      .map(item => referenceNiivueRefs.current[item.id])
      .filter(reference => reference?.volumes?.length);
    let index = 0;
    const refreshNext = () => {
      referenceRefreshFrameRef.current = null;
      if (seq !== referenceRefreshSeqRef.current || index >= references.length) return;
      const reference = references[index++];
      if (!reference.drawBitmap) reference.createEmptyDrawing();
      smoothMaskDisplay(reference);
      // Reference viewers are read-only, so they can safely share the current
      // bitmap instead of allocating another full-volume copy per viewer.
      reference.drawBitmap = source.drawBitmap;
      reference.drawRimOpacity = outlineOpacity > 0 && !hideHeld ? outlineOpacity : -1;
      reference.setDrawOpacity(!hideHeld && labelVisible ? Math.max(overlayOpacity, outlineOpacity > 0 ? 0.001 : 0) : (!hideHeld && outlineOpacity > 0 ? 0.001 : 0));
      reference.refreshDrawing(true);
      if (index < references.length) referenceRefreshFrameRef.current = requestAnimationFrame(refreshNext);
    };
    refreshNext();
  }

  function scheduleReferenceDrawingRefresh() {
    if (referenceRefreshTimerRef.current) clearTimeout(referenceRefreshTimerRef.current);
    referenceRefreshSeqRef.current += 1;
    if (referenceRefreshFrameRef.current) cancelAnimationFrame(referenceRefreshFrameRef.current);
    referenceRefreshTimerRef.current = setTimeout(refreshReferenceDrawings, 100);
  }

  function syncReferenceDrawingPlane(axis, fixed) {
    const source = niivueRef.current;
    const dims = source?.back?.dims;
    if (!source?.drawBitmap || !dims || !Number.isInteger(axis)) return;
    const width = dims[1], height = dims[2], depth = dims[3];
    let plane = null;
    if (axis === 1) {
      plane = new Uint8Array(width * depth);
      for (let z=0;z<depth;z+=1) plane.set(source.drawBitmap.subarray(z*width*height+fixed*width,z*width*height+(fixed+1)*width),z*width);
    } else if (axis === 0) {
      plane = new Uint8Array(height * depth);
      for (let z=0;z<depth;z+=1) for (let y=0;y<height;y+=1) plane[z*height+y]=source.drawBitmap[z*width*height+y*width+fixed];
    }
    const targets = Object.values(referenceNiivueRefs.current).filter(Boolean);
    let index = 0;
    const uploadNext = () => {
      const target = targets[index++];
      if (!target?.gl || !target.drawTexture) return;
      target.drawBitmap = source.drawBitmap;
      const gl = target.gl;
      gl.activeTexture(gl.TEXTURE0 + 7);
      gl.bindTexture(gl.TEXTURE_3D, target.drawTexture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      if (axis === 2) {
        const offset=fixed*width*height;
        gl.texSubImage3D(gl.TEXTURE_3D,0,0,0,fixed,width,height,1,gl.RED,gl.UNSIGNED_BYTE,source.drawBitmap.subarray(offset,offset+width*height));
      } else if (axis === 1) gl.texSubImage3D(gl.TEXTURE_3D,0,0,fixed,0,width,1,depth,gl.RED,gl.UNSIGNED_BYTE,plane);
      else gl.texSubImage3D(gl.TEXTURE_3D,0,fixed,0,0,1,height,depth,gl.RED,gl.UNSIGNED_BYTE,plane);
      target.drawScene();
      if (index < targets.length) requestAnimationFrame(uploadNext);
    };
    requestAnimationFrame(uploadNext);
  }

  function updateBrushPreview(event) {
    if (!["brush", "eraser"].includes(activeToolRef.current)) return;
    if (strokeRef.current) recordBrushPointer(event);
    // Do not retain React's SyntheticEvent beyond this callback.
    brushCursorEventRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      container: event.currentTarget,
    };
    if (brushCursorFrameRef.current) return;
    brushCursorFrameRef.current = requestAnimationFrame(() => {
      brushCursorFrameRef.current = null;
      const latest = brushCursorEventRef.current;
      const preview = brushPreviewRef.current;
      const container = latest?.container;
      if (!latest || !preview || !container) return;
      const box = container.getBoundingClientRect();
      const nv = niivueRef.current;
      const canvas = canvasRef.current;
      const size = brushSizeRef.current;
      let diameter = size * 2;
      if (nv?.volumes[0] && canvas && box.width > 0 && box.height > 0) {
        const frac = nv.canvasPos2frac([
          (latest.clientX - box.left) * canvas.width / box.width,
          (latest.clientY - box.top) * canvas.height / box.height,
        ]);
        const dims = nv.volumes[0].dimsRAS;
        if (frac && dims) {
          const a = nv.frac2canvasPos(frac);
          const b = nv.frac2canvasPos([frac[0] + 1 / dims[1], frac[1], frac[2]]);
          if (a && b) diameter = Math.max(6, Math.abs(a[0] - b[0]) * box.width / canvas.width * size);
        }
      }
      preview.style.display = "block";
      preview.style.width = `${diameter}px`;
      preview.style.height = `${diameter}px`;
      preview.style.left = `${latest.clientX - box.left}px`;
      preview.style.top = `${latest.clientY - box.top}px`;
    });
  }

  function brushVoxelFromPointer(event) {
    const nv = niivueRef.current;
    const canvas = canvasRef.current;
    if (!nv?.volumes?.[0] || !canvas) return null;
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    const frac = nv.canvasPos2frac([
      (event.clientX - box.left) * canvas.width / box.width,
      (event.clientY - box.top) * canvas.height / box.height,
    ]);
    if (!frac || frac.some(value => !Number.isFinite(value) || value < 0 || value > 1)) return null;
    const voxel = nv.frac2vox(frac);
    return voxel?.length >= 3 ? voxel.slice(0, 3).map(Math.round) : null;
  }

  function flushBrushRaster() {
    strokeRasterFrameRef.current = null;
    const stroke = strokePathRef.current;
    if (!stroke || !strokeRef.current) return;
    const nv = niivueRef.current;
    const dimsRAS = nv?.volumes?.[0]?.dimsRAS;
    if (!dimsRAS || !nv?.drawBitmap || stroke.rasterizedThrough >= stroke.points.length) return;
    const start = Math.max(0, stroke.rasterizedThrough - 1);
    rasterizeBrushStroke(
      nv.drawBitmap,
      [dimsRAS[1], dimsRAS[2], dimsRAS[3]],
      stroke.axis,
      stroke.fixed,
      stroke.points.slice(start),
      stroke.penSize,
      stroke.tool === "eraser" ? 0 : 1,
    );
    stroke.rasterizedThrough = stroke.points.length;
    if (!strokeTextureFrameRef.current) {
      strokeTextureFrameRef.current = requestAnimationFrame(() => {
        strokeTextureFrameRef.current = null;
        if (strokeRef.current) niivueRef.current?.refreshDrawing(true, false);
      });
    }
  }

  function scheduleBrushRaster() {
    if (!strokeRasterFrameRef.current) strokeRasterFrameRef.current = requestAnimationFrame(flushBrushRaster);
  }

  function recordBrushPointer(event) {
    const stroke = strokePathRef.current;
    if (!stroke || !strokeRef.current) return;
    const nativeEvent = event?.nativeEvent || event;
    const samples = typeof nativeEvent?.getCoalescedEvents === "function"
      ? nativeEvent.getCoalescedEvents()
      : [nativeEvent];
    for (const sample of samples.length ? samples : [nativeEvent]) {
      const voxel = brushVoxelFromPointer(sample);
      if (!voxel) continue;
      voxel[stroke.axis] = stroke.fixed;
      const previous = stroke.points[stroke.points.length - 1];
      if (!previous || voxel.some((value, axis) => value !== previous[axis])) {
        stroke.points.push(voxel);
      }
    }
    scheduleBrushRaster();
  }

  function beginBrushStroke(event) {
    if (event?.button !== 0 || event?.shiftKey || blocked || propagatePreview || sam2Preview || !["brush", "eraser"].includes(activeToolRef.current) || strokeRef.current) return;
    if (!requireEditorIdentity(activeToolRef.current)) return;
    const nv = niivueRef.current;
    if (!nv?.drawBitmap || !nv?.drawTexture || !nv?.back?.dims) return;
    strokeRef.current = true;
    checkpoint(true);
    const dimsRAS = nv.volumes[0]?.dimsRAS;
    const axis = LABEL_VIEWS.find(item => item.id === viewModeRef.current)?.axis;
    const initialVoxel = brushVoxelFromPointer(event);
    const crosshairVoxel = initialVoxel || nv.frac2vox(nv.scene.crosshairPos);
    strokePathRef.current = Number.isInteger(axis) && dimsRAS ? {
      axis,
      fixed: Math.max(0, Math.min(dimsRAS[axis + 1] - 1, Math.round(crosshairVoxel[axis]))),
      points: initialVoxel ? [initialVoxel] : [],
      tool: activeToolRef.current,
      penSize: brushSizeRef.current,
      rasterizedThrough: 0,
      // Reuse the undo checkpoint instead of allocating another CT-sized copy.
      // NiiVue may leave sparse voxels between pointer samples; at commit time
      // we replace that provisional output with our dense rasterized gesture.
      before: undoRef.current[undoRef.current.length - 1]?.bitmap || null,
    } : null;

    // BrainHem rasterizes the gesture itself. NiiVue's asynchronous pen path
    // can otherwise append a second sparse line after pointerup, sometimes on
    // a boundary slice, which corrupts connected-component analysis and save.
    nv.opts.drawingEnabled = false;

    // NiiVue's default implementation uploads the complete 3D mask for every
    // mouse sample. A CT mask can be tens of MB, which blocks the browser while
    // drawing. During a stroke, upload only the edited 2D plane.
    if (!originalDrawingRefreshRef.current) originalDrawingRefreshRef.current = nv.refreshDrawing.bind(nv);
    if (!originalDrawSceneRef.current) originalDrawSceneRef.current = nv.drawScene.bind(nv);
    nv.drawScene = () => {
      if (strokeDrawFrameRef.current) return undefined;
      strokeDrawFrameRef.current = requestAnimationFrame(() => {
        strokeDrawFrameRef.current = null;
        originalDrawSceneRef.current?.();
      });
      return undefined;
    };
    nv.refreshDrawing = (forceRedraw = true, useClickToSegmentBitmap = false) => {
      if (useClickToSegmentBitmap || !strokeRef.current || !nv.drawBitmap || !nv.back?.dims) {
        return originalDrawingRefreshRef.current?.(forceRedraw, useClickToSegmentBitmap);
      }
      const dims = nv.back.dims;
      const width = dims[1], height = dims[2], depth = dims[3];
      if (!width || !height || !depth) return originalDrawingRefreshRef.current?.(forceRedraw, useClickToSegmentBitmap);
      const voxel = nv.frac2vox(nv.scene.crosshairPos);
      const gl = nv.gl;
      gl.activeTexture(gl.TEXTURE0 + 7);
      gl.bindTexture(gl.TEXTURE_3D, nv.drawTexture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

      if (viewModeRef.current === "axial") {
        const z = Math.max(0, Math.min(depth - 1, voxel[2]));
        const offset = z * width * height;
        gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, z, width, height, 1, gl.RED, gl.UNSIGNED_BYTE,
          nv.drawBitmap.subarray(offset, offset + width * height));
      } else if (viewModeRef.current === "coronal") {
        const y = Math.max(0, Math.min(height - 1, voxel[1]));
        let plane = drawingSliceScratchRef.current.coronal;
        if (!plane || plane.length !== width * depth) plane = drawingSliceScratchRef.current.coronal = new Uint8Array(width * depth);
        for (let z = 0; z < depth; z += 1) {
          const start = z * width * height + y * width;
          plane.set(nv.drawBitmap.subarray(start, start + width), z * width);
        }
        gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, y, 0, width, 1, depth, gl.RED, gl.UNSIGNED_BYTE, plane);
      } else if (viewModeRef.current === "sagittal") {
        const x = Math.max(0, Math.min(width - 1, voxel[0]));
        let plane = drawingSliceScratchRef.current.sagittal;
        if (!plane || plane.length !== height * depth) plane = drawingSliceScratchRef.current.sagittal = new Uint8Array(height * depth);
        for (let z = 0; z < depth; z += 1) for (let y = 0; y < height; y += 1) {
          plane[z * height + y] = nv.drawBitmap[z * width * height + y * width + x];
        }
        gl.texSubImage3D(gl.TEXTURE_3D, 0, x, 0, 0, 1, height, depth, gl.RED, gl.UNSIGNED_BYTE, plane);
      } else {
        return originalDrawingRefreshRef.current?.(forceRedraw, useClickToSegmentBitmap);
      }
      if (forceRedraw) nv.drawScene();
    };
    if (strokePathRef.current?.points.length) {
      flushBrushRaster();
    }
  }

  function endBrushStroke(event) {
    if (!strokeRef.current) return;
    if (event?.clientX != null) recordBrushPointer(event);
    const nv = niivueRef.current;
    if (nv && originalDrawingRefreshRef.current) {
      if (strokeRasterFrameRef.current) cancelAnimationFrame(strokeRasterFrameRef.current);
      strokeRasterFrameRef.current = null;
      const stroke = strokePathRef.current;
      const dimsRAS = nv.volumes?.[0]?.dimsRAS;
      if (stroke && dimsRAS) {
        if (stroke.before?.length === nv.drawBitmap?.length) nv.drawBitmap.set(stroke.before);
        rasterizeBrushStroke(
          nv.drawBitmap,
          [dimsRAS[1], dimsRAS[2], dimsRAS[3]],
          stroke.axis,
          stroke.fixed,
          stroke.points,
          stroke.penSize,
          stroke.tool === "eraser" ? 0 : 1,
        );
      }
      if (stroke?.tool === "brush" && autoConnectBrushRef.current) {
        fillClosedBrushStroke(
          nv.drawBitmap,
          [dimsRAS[1], dimsRAS[2], dimsRAS[3]],
          stroke.axis,
          stroke.fixed,
          stroke.points,
          stroke.penSize,
        );
      }
      // The final mask differs only on this fixed 2D plane. Commit that plane
      // while the lightweight uploader is active; the shared 3D texture is
      // then correct for every orientation without re-uploading the volume.
      nv.refreshDrawing(true, false);
      strokeRef.current = false;
      nv.refreshDrawing = originalDrawingRefreshRef.current;
      originalDrawingRefreshRef.current = null;
      // Keep NiiVue's native drawing disabled while this tool remains active.
      // The tool effect restores the appropriate mode when the user switches.
      if (originalDrawSceneRef.current) nv.drawScene = originalDrawSceneRef.current;
      originalDrawSceneRef.current = null;
      if (strokeDrawFrameRef.current) cancelAnimationFrame(strokeDrawFrameRef.current);
      strokeDrawFrameRef.current = null;
      if (strokeTextureFrameRef.current) cancelAnimationFrame(strokeTextureFrameRef.current);
      strokeTextureFrameRef.current = null;
    }
    strokeRef.current = false;
    if (strokePathRef.current) syncReferenceDrawingPlane(strokePathRef.current.axis, strokePathRef.current.fixed);
    strokePathRef.current = null;
    setHistoryTick(v => v + 1);
    changed();
  }

  function scheduleEndBrushStroke(event) {
    if (!strokeRef.current) return;
    // Record the release coordinate synchronously because React recycles the
    // event object. Commit after the native mouseup handler so NiiVue cannot
    // append its provisional sparse line after our dense rasterization.
    if (event?.clientX != null) recordBrushPointer(event);
    if (strokeEndTimerRef.current) clearTimeout(strokeEndTimerRef.current);
    strokeEndTimerRef.current = setTimeout(() => {
      strokeEndTimerRef.current = null;
      endBrushStroke();
    }, 0);
  }

  // Initialize Niivue instance
  useEffect(() => {
    if (!canvasRef.current || niivueRef.current) return undefined;

    const nv = new Niivue({
      backColor: [0.03, 0.04, 0.06, 1],
      crosshairColor: [0.15, 0.88, 0.82, 1],
      crosshairWidth: 0.8,
      dragMode: DRAG_MODE.none,
      isColorbar: false,
      isCornerOrientationText: false,
      isOrientationTextVisible: false,
      isRadiologicalConvention: true,
      isRuler: true,
      rulerColor: [0.38, 0.7, 0.98, 0.92],
      rulerWidth: 2,
      loadingText: "Đang tải CT thể tích…",
      multiplanarEqualSize: true,
      multiplanarLayout: MULTIPLANAR_TYPE.GRID,
      show3Dcrosshair: true,
      smoothDrawing: 0,
      fontMinPx: 18,
      fontSizeScaling: 0,
      mouseEventConfig: {
        leftButton: { primary: DRAG_MODE.pan },
        rightButton: DRAG_MODE.none,
        centerButton: DRAG_MODE.pan,
      },
    });
    installConfidenceColormap(nv);

    nv.onIntensityChange = volume => {
      setActualWindow({ label: "Tùy chỉnh", width: Math.round(volume.cal_max - volume.cal_min), level: Math.round((volume.cal_max + volume.cal_min) / 2) });
    };

    nv.onDrawingChanged = () => {
      if (loadingRef.current) return;
      // A single brush stroke can emit hundreds of callbacks. React state and
      // reference-view refreshes are committed once in endBrushStroke().
      if (strokeRef.current) return;
      editRef.current += 1;
      setEditTick(editRef.current);
      setConfirmEntireVolume(false);
      setDirty(true);
      scheduleReferenceDrawingRefresh();
    };

    nv.onLocationChange = (loc) => {
      locationRef.current = loc;
      setLocation(loc);
    };

    attachViewer(nv, canvasRef.current).then((ready) => {
      if (!ready || niivueRef.current !== nv) return;
      nv.setMouseEventConfig({
        leftButton: { primary: DRAG_MODE.pan },
        rightButton: DRAG_MODE.none,
        centerButton: DRAG_MODE.pan,
      });
      nv.setSliceType(SLICE_TYPE.AXIAL);
      setViewerReady(true);
    }).catch((attachErr) => {
      if (niivueRef.current !== nv) return;
      setError(`Không khởi tạo được WebGL canvas: ${attachErr.message}`);
    });

    niivueRef.current = nv;

    return () => {
      loadSeqRef.current += 1;
      if (referenceRefreshTimerRef.current) clearTimeout(referenceRefreshTimerRef.current);
      if (referenceRefreshFrameRef.current) cancelAnimationFrame(referenceRefreshFrameRef.current);
      if (highlightRefreshRef.current.frame) cancelAnimationFrame(highlightRefreshRef.current.frame);
      if (brushCursorFrameRef.current) cancelAnimationFrame(brushCursorFrameRef.current);
      if (niivueRef.current && originalDrawingRefreshRef.current) niivueRef.current.refreshDrawing = originalDrawingRefreshRef.current;
      if (niivueRef.current && originalDrawSceneRef.current) niivueRef.current.drawScene = originalDrawSceneRef.current;
      originalDrawingRefreshRef.current = null;
      originalDrawSceneRef.current = null;
      if (strokeDrawFrameRef.current) cancelAnimationFrame(strokeDrawFrameRef.current);
      if (strokeTextureFrameRef.current) cancelAnimationFrame(strokeTextureFrameRef.current);
      if (strokeEndTimerRef.current) clearTimeout(strokeEndTimerRef.current);
      if (postEditTimerRef.current) clearTimeout(postEditTimerRef.current);
      if (crosshairUpdateRef.current.timer) clearTimeout(crosshairUpdateRef.current.timer);
      disposeViewer(nv);
      Object.values(referenceNiivueRefs.current).forEach(disposeViewer);
      referenceNiivueRefs.current = {};
      niivueRef.current = null;
    };
  }, []);

  // Changing tools must remain a cheap interaction: do not rebuild volumes or
  // repeatedly toggle drawing merely because the brush-size slider moved.
  useEffect(() => {
    const nv = niivueRef.current;
    if (!nv) return;

    const primaryDragMode = activeTool === "pan" || activeTool === "pointer"
      ? (viewModeRef.current === "render" ? DRAG_MODE.crosshair : DRAG_MODE.pan)
      : activeTool === "contrast" ? DRAG_MODE.contrast
      : ["brush", "eraser"].includes(activeTool) ? DRAG_MODE.crosshair
      : DRAG_MODE.none;
    nv.setMouseEventConfig({
      leftButton: { primary: primaryDragMode },
      rightButton: DRAG_MODE.none,
      centerButton: DRAG_MODE.pan,
    });
    nv.opts.dragModePrimary = primaryDragMode;
    if (activeTool === "pointer") {
      if (nv.opts.drawingEnabled) nv.setDrawingEnabled(false);
      nv.opts.dragMode = viewModeRef.current === "render" ? DRAG_MODE.crosshair : DRAG_MODE.pan;
    } else if (activeTool === "brush") {
      // NiiVue dispatches drawing through its crosshair mouse path. `none`
      // only redraws the canvas and never calls mouseClick/drawPt.
      nv.opts.dragMode = DRAG_MODE.crosshair;
      if (!nv.opts.drawingEnabled) nv.setDrawingEnabled(true);
      if (nv.opts.penValue !== 1 || nv.opts.isFilledPen) nv.setPenValue(1, false);
      nv.opts.penSize = brushSizeRef.current;
      nv.penSize = brushSizeRef.current;
    } else if (activeTool === "eraser") {
      nv.opts.dragMode = DRAG_MODE.crosshair;
      if (!nv.opts.drawingEnabled) nv.setDrawingEnabled(true);
      if (nv.opts.penValue !== 0 || nv.opts.isFilledPen) nv.setPenValue(0, false);
      nv.opts.penSize = brushSizeRef.current;
      nv.penSize = brushSizeRef.current;
    } else {
      if (nv.opts.drawingEnabled) nv.setDrawingEnabled(false);
      nv.opts.dragMode = activeTool === "pan" ? DRAG_MODE.pan : activeTool === "contrast" ? DRAG_MODE.contrast : DRAG_MODE.none;
    }
  }, [activeTool]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !selectedCase || editorLoading) return undefined;
    const handleWheel = (event) => {
      const nv = niivueRef.current;
      if (!nv?.volumes?.[0]) return;
      const activeView = LABEL_VIEWS.find((item) => item.id === viewModeRef.current);
      if (event.altKey && propagatePreview) {
        event.preventDefault();
        event.stopImmediatePropagation();
        reshapePropagation(event.deltaY < 0 ? "grow" : "shrink");
        return;
      }
      if (event.ctrlKey && Number.isInteger(activeView?.axis)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const axis = activeView.axis;
        const total = nv.volumes[0].dimsRAS?.[axis + 1] || 1;
        const current = Math.max(0, Math.min(total - 1, Math.floor((nv.scene.crosshairPos?.[axis] ?? 0.5) * total)));
        const next = Math.max(0, Math.min(total - 1, current + (event.deltaY > 0 ? 1 : -1)));
        nv.scene.crosshairPos[axis] = (next + 0.5) / total;
        nv.createOnLocationChange();
        nv.drawScene();
        syncLabelCrosshair(nv);
        return;
      }
      if (!Number.isInteger(activeView?.axis)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const transform = [...nv.scene.pan2Dxyzmm];
      transform[3] = Math.max(0.5, Math.min(12, transform[3] * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
      nv.setPan2Dxyzmm(transform);
    };
    canvas.addEventListener("wheel", handleWheel, { passive: false, capture: true });
    return () => canvas.removeEventListener("wheel", handleWheel, true);
  }, [selectedCase?.id, editorLoading, propagatePreview]);

  // Update Windowing
  useEffect(() => {
    const nv = niivueRef.current;
    if (!nv || !nv.volumes || nv.volumes.length === 0) return;
    const preset = WINDOWS[windowKey];
    setActualWindow(preset);
    if (preset) {
      nv.volumes[0].cal_min = preset.level - preset.width / 2;
      nv.volumes[0].cal_max = preset.level + preset.width / 2;
      nv.updateGLVolume();
      nv.drawScene();
      Object.values(referenceNiivueRefs.current).forEach((reference) => {
        if (!reference.volumes?.[0]) return;
        reference.volumes[0].cal_min = preset.level - preset.width / 2;
        reference.volumes[0].cal_max = preset.level + preset.width / 2;
        reference.updateGLVolume();
      });
    }
  }, [windowKey]);

  // Update Drawing Opacity
  useEffect(()=>{
    const nv=niivueRef.current;
    if(!regions.length){clearComponentDisplay(nv);return;}
    const styles=labelVisible?componentStyles:Object.fromEntries(Object.entries(componentStyles).map(([key,value])=>[key,{...value,fill:0}]));
    updateComponentDisplay(nv,regions,styles,focusedRegionKey,labelVisible?overlayOpacity:0,outlineOpacity);
    Object.values(referenceNiivueRefs.current).forEach(reference=>updateComponentDisplay(reference,regions,styles,focusedRegionKey,labelVisible?overlayOpacity:0,outlineOpacity));
  },[regions,componentStyles,focusedRegionKey,overlayOpacity,outlineOpacity,labelVisible,hideHeld]);

  useEffect(() => {
    const nv = niivueRef.current;
    if (!nv) return;
    const customVisible=Object.values(componentStyles).some(style=>(labelVisible&&(style.fill??0)>0)||(style.rim??0)>0);
    const displayOpacity=!hideHeld?Math.max(labelVisible?overlayOpacity:0,(outlineOpacity>0||customVisible)?0.001:0):0;
    if (typeof nv.setDrawOpacity === "function") {
      nv.drawRimOpacity = outlineOpacity > 0 && !hideHeld ? outlineOpacity : -1;
      nv.setDrawOpacity(displayOpacity);
      nv.drawScene();
    }
    Object.values(referenceNiivueRefs.current).forEach((reference) => {
      if (!reference?.drawBitmap) return;
      reference.drawRimOpacity = outlineOpacity > 0 && !hideHeld ? outlineOpacity : -1;
      reference.setDrawOpacity(displayOpacity);
      reference.drawScene();
    });
  }, [overlayOpacity, labelVisible, outlineOpacity, hideHeld,componentStyles]);

  // Load selected case into Niivue
  const loadCaseIntoViewer = useCallback(async (caseItem, revisionNum = null, restore = null) => {
    const nv = niivueRef.current;
    if (!nv || !caseItem) return;

    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    // Invalidate analysis/display work from the previous case immediately.
    regionAnalysisRequestRef.current += 1;
    if (regionAnalysisTimerRef.current) clearTimeout(regionAnalysisTimerRef.current);
    highlightedRegionVoxelsRef.current = null;
    highlightedRegionBoundsRef.current = null;
    if (highlightRefreshRef.current.frame) cancelAnimationFrame(highlightRefreshRef.current.frame);
    highlightRefreshRef.current = { frame: null, bounds: null };
    referenceRefreshSeqRef.current += 1;
    if (referenceRefreshTimerRef.current) clearTimeout(referenceRefreshTimerRef.current);
    if (referenceRefreshFrameRef.current) cancelAnimationFrame(referenceRefreshFrameRef.current);

    if (pollIntervalRef.current) {
      pollIntervalRef.current();
      pollIntervalRef.current = null;
    }
    pollTokenRef.current += 1;
    setInferenceBusy(false);

    loadingRef.current = true;
    setEditorLoading(true);
    setPolygon([]); setPolygonClosed(false);
    undoRef.current = []; redoRef.current = []; setHistoryTick(v => v + 1);
    aiVolumeRef.current = null; aiReferenceVolumesRef.current = {}; setAiVisible(false); setAiLoading(false); setAiDisplayMode("components"); setAiThreshold(0.5);
    setRegions([]); regionsRef.current = []; setRegionsBusy(true);
    setComponentStyles({});setFocusedRegionKey(null);componentFocusRef.current=null;
    clearComponentDisplay(niivueRef.current);
    setSelectedRegionKey(null); selectedRegionKeyRef.current = null;
    setSelectedRegionKeys(new Set()); selectedRegionKeysRef.current = new Set();
    setMergeSourceKey(null);
    setPropagatePreview(null);
    propagatePreviewRef.current = null;
    setSam2Menu(null);
    setSam2Preview(null);
    setSam2Busy(false);
    setConfirmedPropagatedSlices(new Set());
    setReviewedRegionKeys(new Set()); reviewedRegionKeysRef.current = new Set();
    viewModeRef.current = "axial"; setViewMode("axial"); nv.setSliceType(SLICE_TYPE.AXIAL);
    setMarkedSlices([]); setSaveFailed(false); setSaveConflict(false); setShowFinish(false);
    setError("");
    setFeedback("");
    setDirty(false);
    setInferenceJob(null);
    setInferenceDisconnected(false);
    setRecoverableDraft(null);
    setLocalDraftNotice("");
    setConfirmEntireVolume(false);
    setApprovalSummary(null);
    setReviewNotes("");
    setActiveTool("pointer");
    nv.setDrawingEnabled(false);
    setRevisions([]);
    setProvenanceCleared(false);

    try {
      while (nv.volumes.length) nv.removeVolumeByIndex(nv.volumes.length - 1);
      const referenceViewers = await ensureReferenceViewers();
      if (!referenceViewers || seq !== loadSeqRef.current) return;
      Object.values(referenceViewers).forEach((reference) => {
        while (reference.volumes.length) reference.removeVolumeByIndex(reference.volumes.length - 1);
      });

      const sourceUrl = getAnnotationSourceUrl(caseItem.id);
      const preset = WINDOWS[windowKey];
    setActualWindow(preset);

      // Download source CT
      const response = await fetchWithRetry(sourceUrl, { cache: "no-store" }, 3, 30000);
      if (!response.ok) throw new Error(`Không tải được file CT gốc (${response.status})`);
      const blob = await response.blob();
      const ctFile = new File([blob], `${caseItem.id}_source.nii.gz`, { type: "application/gzip" });

      if (seq !== loadSeqRef.current) return;

      const ct = await NVImage.loadFromFile({
        file: ctFile,
        name: caseItem.name,
        colormap: "gray",
        opacity: 1,
        cal_min: preset.level - preset.width / 2,
        cal_max: preset.level + preset.width / 2,
        trustCalMinMax: true,
      });

      if (seq !== loadSeqRef.current) return;
      nv.addVolume(ct);
      await Promise.all(LABEL_VIEWS.map(async (item) => {
        const reference = referenceViewers[item.id];
        if (!reference) return;
        // Reuse the decoded CT instead of inflating the same gzip for every view.
        const referenceCt = ct.clone();
        if (seq === loadSeqRef.current) reference.addVolume(referenceCt);
      }));

      const totalAxial = (ct.dimsRAS && ct.dimsRAS.length >= 4)
        ? ct.dimsRAS[3]
        : ((ct.hdr?.dims && ct.hdr.dims.length >= 4) ? ct.hdr.dims[3] : (ct.dims?.[3] || 1));
      setTotalSlices(totalAxial);
      const slice = restore ? Math.min(totalAxial-1, restore.slice) : Math.floor(totalAxial / 2);
      nv.scene.crosshairPos[2] = (slice+0.5)/totalAxial;
      setCurrentSlice(slice);
      if (restore?.window && Number.isFinite(restore.window.width) && restore.window.width>0 && Number.isFinite(restore.window.level)) {
        ct.cal_min=restore.window.level-restore.window.width/2;
        ct.cal_max=restore.window.level+restore.window.width/2;
        setActualWindow(restore.window);
      }

      // Load mask if revision exists
      const targetRev = revisionNum !== null ? revisionNum : caseItem.current_revision;
      setDisplayedRevisionNum(targetRev);
      if (targetRev > 0) {
        const maskUrl = getAnnotationMaskUrl(caseItem.id, targetRev);
        const maskResponse = await fetchWithRetry(maskUrl, { cache: "no-store" }, 3, 30000);
        if (!maskResponse.ok) throw new Error(`Không tải được nhãn (${maskResponse.status})`);
        const maskBlob = await maskResponse.blob();
        const maskFile = new File([maskBlob], `${caseItem.id}_label.nii.gz`, { type: maskBlob.type || "application/gzip" });
        const drawingImage = await NVImage.loadFromFile({ file: maskFile, name: "Nhãn xuất huyết" });
        if (seq !== loadSeqRef.current) return;
        nv.loadDrawing(drawingImage);
        smoothMaskDisplay(nv);
        nv.setDrawColormap(LABEL_DRAW_LUT);
        Object.values(referenceViewers).forEach((reference) => {
          if (!reference?.volumes?.length) return;
          reference.loadDrawing(drawingImage.clone());
          smoothMaskDisplay(reference);
          reference.setDrawColormap(LABEL_DRAW_LUT);
          reference.drawRimOpacity = outlineOpacity > 0 ? outlineOpacity : -1;
          reference.setDrawOpacity(labelVisible ? Math.max(overlayOpacity, outlineOpacity > 0 ? 0.001 : 0) : (outlineOpacity > 0 ? 0.001 : 0));
          reference.refreshDrawing(true);
        });
      } else {
        nv.createEmptyDrawing();
        smoothMaskDisplay(nv);
        nv.setDrawColormap(LABEL_DRAW_LUT);
        Object.values(referenceViewers).forEach((reference) => {
          if (!reference?.volumes?.length) return;
          reference.createEmptyDrawing();
          smoothMaskDisplay(reference);
          reference.setDrawColormap(LABEL_DRAW_LUT);
          reference.refreshDrawing(true);
        });
      }

      nv.setDrawingEnabled(false);
      if (typeof nv.setDrawOpacity === "function") {
        nv.drawRimOpacity = outlineOpacity > 0 && !hideHeld ? outlineOpacity : -1;
        nv.setDrawOpacity(!hideHeld && labelVisible ? Math.max(overlayOpacity, outlineOpacity > 0 ? 0.001 : 0) : (!hideHeld && outlineOpacity > 0 ? 0.001 : 0));
      }
      nv.drawScene();
      LABEL_VIEWS.forEach((item) => referenceViewers[item.id]?.setSliceType(item.type));
      syncLabelCrosshair(nv);
      refreshReferenceDrawings();

      if (revisionNum === null) {
        try {
          let draft = await getDraft(draftKey(API_BASE, account.username, caseItem.id));
          if (draft?.pendingSave?.operationId && reviewerAuthRef.current) {
            const receipt = await getSavedOperation(caseItem.id, draft.pendingSave.operationId, reviewerAuthRef.current);
            if (receipt) {
              const savedVersion = JSON.parse(draft.pendingSave.identity)[1];
              if (draft.version===savedVersion) {await removeDraft(draft.key, savedVersion);draft=null;}
              else {
                draft={...draft,expectedRevision:receipt.revision_number,baseRevision:receipt.revision_number,pendingSave:null};
                await putDraft(draft);
              }
            }
          }
          if (seq === loadSeqRef.current && matchingDraft(draft, caseItem, nv.drawBitmap?.length)) setRecoverableDraft(draft);
        } catch { if (seq === loadSeqRef.current) setLocalDraftNotice("Không đọc được nháp cục bộ; nhãn máy chủ vẫn được giữ."); }
      }
      const retainedResult = archivedAiResult(caseItem);
      if (retainedResult) setInferenceJob(retainedResult);
      const pendingJob = caseItem.ai_job_id || (!retainedResult && recalledJob(API_BASE, account.username, caseItem.id));
      if (pendingJob) {
        rememberJob(API_BASE, account.username, caseItem.id, pendingJob);
        pollJob(pendingJob, caseItem.id, "AI");
      }
      // Load revision list
      setLoadingRevisions(true);
      listAnnotationRevisions(caseItem.id)
        .then((revs) => {
          if (seq !== loadSeqRef.current) return;
          setRevisions(revs.items || []);
          setLoadingRevisions(false);
        })
        .catch(() => setLoadingRevisions(false));

      if (seq !== loadSeqRef.current) return;
      loadingRef.current = false;
      setEditorLoading(false);
      setDirty(false);
      scheduleRegionAnalysis(0);
    } catch (loadErr) {
      if (seq !== loadSeqRef.current) return;
      loadingRef.current = false;
      setEditorLoading(false);
      setLoadingRevisions(false);
      setError(`Lỗi khi mở ca: ${loadErr.message}`);
    }
  }, [windowKey, activeTool, brushSize, overlayOpacity, labelVisible, outlineOpacity, hideHeld]);

  useEffect(() => {
    if (!selectedCase || selectedCase.current_revision !== 0 || displayedRevisionNum !== 0 ||
        inferenceJob?.status !== "succeeded" || inferenceJob.archived || editorLoading ||
        loadingRef.current || savingRef.current || dirty || recoverableDraft || saveFailed ||
        strokeRef.current || polygon.length || sam2Preview || propagatePreview ||
        !account.permissions?.includes("label.edit")) return;
    const caseId = selectedCase.id;
    const attempt = `${caseId}:${inferenceJob.id}`;
    if (initialAiSeedAttemptsRef.current.has(attempt)) return;
    initialAiSeedAttemptsRef.current.add(attempt);
    const sequence = loadSeqRef.current;
    const isCurrent = () => activeCaseIdRef.current === caseId && loadSeqRef.current === sequence;
    const view = { slice:currentSlice, window:actualWindow, windowKey };
    loadingRef.current = true;
    setEditorLoading(true);
    (async () => {
      try {
        const ready = await prepareLabelingCase(caseId, {
          getCase: getAnnotationCase,
          getJob,
          seed: (id, jobId, revision) => seedAnnotationFromJob(id, jobId, revision, reviewerAuthRef.current),
          readDraft: current => getDraft(draftKey(API_BASE, account.username, current.id)),
        });
        if (!isCurrent() || ready.current_revision === 0) return;
        setSelectedCase(ready);
        setCases(items => items.map(item => item.id === ready.id ? ready : item));
        await loadCaseIntoViewer(ready, ready.current_revision, view);
      } catch (reason) {
        if (isCurrent()) setError(`Không nạp được gợi ý AI vào nháp ban đầu: ${reason.message}`);
      } finally {
        if (isCurrent()) {
          loadingRef.current = false;
          setEditorLoading(false);
        }
      }
    })();
  }, [selectedCase?.id, selectedCase?.current_revision, displayedRevisionNum, inferenceJob?.id,
      inferenceJob?.status, editorLoading, dirty, recoverableDraft, saveFailed, polygon.length,
      sam2Preview, propagatePreview, account.username, account.permissions, loadCaseIntoViewer]);

  useEffect(() => {
    if (!viewerReady || loadingCases || !cases.length || restoreAttemptedRef.current) return;
    restoreAttemptedRef.current=true;
    const view=restoreViewRef.current;
    const targetCaseId=initialCaseId || view?.caseId;
    if (!targetCaseId) return;
    const item=cases.find(c=>c.id===targetCaseId);
    if (item) {
      activeCaseIdRef.current=item.id;
      setSelectedCase(item);
      if (window.innerWidth < 1000) setCaseDrawer(false);
      loadCaseIntoViewer(item, null, view?.caseId===item.id ? view : null);
    }
  }, [viewerReady, loadingCases, cases, initialCaseId]);

  useEffect(() => {
    if (!selectedCase || editorLoading || loadingRef.current) return;
    try { sessionStorage.setItem(VIEW_KEY, JSON.stringify({caseId:selectedCase.id,slice:currentSlice,windowKey,window:actualWindow})); } catch { /* Storage may be disabled. */ }
  }, [selectedCase?.id, currentSlice, windowKey, actualWindow, editorLoading]);

  async function persistWorkingDraft() {
    const nv = niivueRef.current;
    if (!selectedCase || !nv?.drawBitmap || loadingRef.current) return false;
    const id = selectedCase.id;
    // An unaccepted AI preview must not become part of the saved draft.
    const mask = (sam2Preview?.before || nv.drawBitmap).slice();
    normalizeMaskForSave(mask);
    const draft = {key:draftKey(API_BASE, account.username, id), caseId:id,
      sourceDigest:selectedCase.source_digest, geometry:JSON.stringify(selectedCase.geometry),
      expectedRevision:selectedCase.current_revision, baseRevision:displayedRevisionNum,
      mask, version:editRef.current, pendingSave:pendingSaveRef.current};
    try {
      await putDraft(draft);
      if (activeCaseIdRef.current===id) setLocalDraftNotice("Đã giữ bản nháp trên thiết bị; chưa thay thế nhãn lưu trên máy chủ.");
      return true;
    } catch {
      if (activeCaseIdRef.current===id) setLocalDraftNotice("Không lưu được nháp trên thiết bị. Hãy tải mặt nạ để giữ thao tác.");
      return false;
    }
  }

  useEffect(() => {
    if (!onRegisterBeforeLeave) return;
    onRegisterBeforeLeave(async () => !dirty || await persistWorkingDraft());
    return () => onRegisterBeforeLeave(null);
  }, [onRegisterBeforeLeave, dirty, selectedCase, displayedRevisionNum, sam2Preview]);

  useEffect(() => {
    if (!dirty || editorLoading) return;
    const timer = setTimeout(persistWorkingDraft, 350);
    const onHidden = () => {if(document.visibilityState==="hidden")persistWorkingDraft();};
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", persistWorkingDraft);
    return () => {clearTimeout(timer);document.removeEventListener("visibilitychange",onHidden);window.removeEventListener("pagehide",persistWorkingDraft);};
  }, [dirty, editTick, editorLoading, selectedCase?.id, sam2Preview]);

  function restoreWorkingDraft() {
    const nv=niivueRef.current, draft=recoverableDraft;
    if (!matchingDraft(draft, selectedCase, nv?.drawBitmap?.length)) return;
    if (draft.expectedRevision !== selectedCase.current_revision) {
      setError("Máy chủ đã có phiên bản mới hơn bản nháp. Hãy tải nháp để đối chiếu; không tự ghi đè phiên bản mới.");
      return;
    }
    nv.drawBitmap.set(draft.mask);
    editRef.current=draft.version;
    setDisplayedRevisionNum(draft.baseRevision);
    pendingSaveRef.current=draft.pendingSave || null;
    nv.refreshDrawing(true);
    setDirty(true);setEditTick(editRef.current);setRecoverableDraft(null);
    scheduleRegionAnalysis(0);
    setFeedback("Đã khôi phục bản nháp trên thiết bị. Hãy kiểm tra trước khi lưu.");
  }

  async function downloadRecoveredDraft() {
    const nv=niivueRef.current;
    if (!matchingDraft(recoverableDraft, selectedCase, nv?.drawBitmap?.length)) return;
    try {
      const bytes=await serializeDrawingMask(nv.volumes[0],recoverableDraft.mask);
      const url=URL.createObjectURL(new Blob([bytes],{type:"application/gzip"}));
      const link=document.createElement("a");link.href=url;link.download=`${selectedCase.id}-recovered-draft.nii.gz`;link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch {setError("Không xuất được bản nháp. Bản nháp vẫn được giữ trên thiết bị.");}
  }

  async function handleSelectCase(caseItem, alreadySaved = false) {
    if (savingRef.current || editorLoading) return;
    if (dirty && !alreadySaved) {
      if (!await persistWorkingDraft()) {setError("Chưa giữ được bản nháp. Hãy lưu hoặc tải mặt nạ trước khi chuyển ca.");return;}
    }
    activeCaseIdRef.current = caseItem.id;
    setSelectedCase(caseItem);
    if (window.innerWidth < 1000) setCaseDrawer(false);
    loadCaseIntoViewer(caseItem);
  }

  async function handleLoadRevision(revNum) {
    if (!selectedCase || savingRef.current || editorLoading) return;
    if (dirty && !await persistWorkingDraft()) return;
    setDisplayedRevisionNum(revNum);
    loadCaseIntoViewer(selectedCase, revNum);
  }

  async function handleOpenCreateModal() {
    if (dirty && !await persistWorkingDraft()) return;
    setShowCreateModal(true);
    loadPacsForModal();
    loadJobsForModal();
  }

  // Slice navigation slider
  function handleSliceChange(newSlice) {
    const nv = niivueRef.current;
    if (!nv || !nv.volumes.length) return;
    if (polygon.length || propagatePreview) return;
    newSlice = Math.max(0, Math.min(totalSlices - 1, newSlice));
    const axis = LABEL_VIEWS.find((item) => item.id === viewMode)?.axis;
    if (!Number.isInteger(axis)) return;
    nv.scene.crosshairPos[axis] = (newSlice + 0.5) / (totalSlices || 1);
    nv.createOnLocationChange();
    nv.drawScene();
    syncLabelCrosshair(nv);
    setCurrentSlice(newSlice);
  }

  // Tool actions
  function scheduleRegionAnalysis(delay = 260) {
    if (regionAnalysisTimerRef.current) clearTimeout(regionAnalysisTimerRef.current);
    setRegionsBusy(true);
    regionAnalysisTimerRef.current = setTimeout(() => {
      const nv = niivueRef.current;
      const worker = regionWorkerRef.current;
      const dimsRAS = nv?.volumes?.[0]?.dimsRAS;
      if (!worker || !nv?.drawBitmap || !dimsRAS) {
        setRegionsBusy(false);
        return;
      }
      const dims = [dimsRAS[1], dimsRAS[2], dimsRAS[3]];
      const zooms = selectedCaseRef.current?.geometry?.zooms || [];
      const voxelVolumeMl = zooms.length >= 3
        ? Math.abs(Number(zooms[0]) * Number(zooms[1]) * Number(zooms[2])) / 1000
        : 0;
      const bitmap = nv.drawBitmap.slice();
      for (let index = 0; index < bitmap.length; index += 1) {
        bitmap[index] = bitmap[index] === 3 ? 0 : (bitmap[index] > 0 ? 1 : 0);
      }
      const requestId = regionAnalysisRequestRef.current + 1;
      regionAnalysisRequestRef.current = requestId;
      worker.postMessage({ requestId, bitmap, dims, voxelVolumeMl, minVoxelCount:1 }, [bitmap.buffer]);
    }, delay);
  }

  function checkpoint() {
    const nv = niivueRef.current;
    if (!nv?.drawBitmap) return;
    undoRef.current.push({ bitmap: nv.drawBitmap.slice(), cleared: provenanceCleared });
    const max = Math.max(1, Math.min(12, Math.floor(64 * 1024 * 1024 / nv.drawBitmap.length)));
    while (undoRef.current.length > max) undoRef.current.shift();
    redoRef.current = []; setHistoryTick(v => v + 1);
  }

  function changed() {
    editRef.current += 1; setEditTick(editRef.current);
    setDirty(true); setConfirmEntireVolume(false); setSaveFailed(false); setSaveConflict(false);
    // Any pixel/voxel edit invalidates all region-level review decisions,
    // even when a connected-component key happens to stay the same.
    reviewedRegionKeysRef.current = new Set();
    setReviewedRegionKeys(new Set());
    if (postEditTimerRef.current) clearTimeout(postEditTimerRef.current);
    postEditTimerRef.current = setTimeout(() => {
      postEditTimerRef.current = null;
      scheduleRegionAnalysis(0);
    }, 180);
  }

  function handleUndo(redo = false) {
    if (editorLoading || polygon.length || propagatePreview || sam2Preview) return;
    if (!requireEditorIdentity()) return;
    const nv = niivueRef.current;
    const from = redo ? redoRef.current : undoRef.current;
    const to = redo ? undoRef.current : redoRef.current;
    if (!nv?.drawBitmap || !from.length) return;
    to.push({ bitmap: nv.drawBitmap.slice(), cleared: provenanceCleared });
    const previous = from.pop(); nv.drawBitmap = previous.bitmap; setProvenanceCleared(previous.cleared);
    nv.refreshDrawing(true); setHistoryTick(v => v + 1); changed();
  }

  function updateMarkedSlices() {
    const nv = niivueRef.current;
    const dims = nv?.volumes[0]?.dimsRAS;
    if (!dims || !nv.drawBitmap) return;
    const stride = dims[1] * dims[2], marked = [];
    for (let z = 0; z < dims[3]; z++) {
      if (nv.drawBitmap.subarray(z * stride, (z + 1) * stride).some(v => v === 1 || v === 2)) marked.push(z);
    }
    setMarkedSlices(marked);
  }

  function handleClearDrawing() {
    if (!requireEditorIdentity()) return;
    const ok = window.confirm("Bạn có chắc chắn muốn xóa toàn bộ nét vẽ và trở về mặt nạ rỗng?");
    if (!ok) return;
    const nv = niivueRef.current;
    if (!nv) return;
    checkpoint();
    nv.createEmptyDrawing();
    smoothMaskDisplay(nv);
    nv.refreshDrawing(true);
    setProvenanceCleared(true);
    changed();
  }

  async function downloadCurrentMask() {
    const nv = niivueRef.current;
    if (!selectedCase || !nv?.volumes?.length || !nv.drawBitmap) return;
    try {
      const binaryMask = nv.drawBitmap.slice();
      normalizeMaskForSave(binaryMask);
      const bytes = await serializeDrawingMask(nv.volumes[0], binaryMask);
      if (!bytes || !(bytes instanceof Uint8Array)) throw new Error("Không thể trích xuất mask hiện tại");
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/gzip" }));
      const link = document.createElement("a");
      const safeCase = String(selectedCase.patient_id || selectedCase.name || selectedCase.id).replace(/[^a-zA-Z0-9_.-]+/g, "_");
      link.href = url;
      link.download = `${safeCase}_local-conflict-v${displayedRevisionNum}.nii.gz`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setFeedback("Đã tải mask chưa đồng bộ về máy. File này không thay đổi bản trên máy chủ.");
    } catch (exportError) {
      setError(`Không thể tải mask đang sửa: ${exportError.message}`);
    }
  }

  async function reloadLatestAfterConflict() {
    if (!selectedCase || !window.confirm("Tải revision mới nhất từ máy chủ? Mask đang sửa trên màn hình sẽ bị thay thế. Hãy tải mask local trước nếu cần giữ lại.")) return;
    try {
      const latest = await getAnnotationCase(selectedCase.id);
      setCases(items => items.map(item => item.id === latest.id ? latest : item));
      setSelectedCase(latest);
      setSaveFailed(false);
      setSaveConflict(false);
      await loadCaseIntoViewer(latest, latest.current_revision);
      setFeedback(`Đã tải revision mới nhất v${latest.current_revision}.`);
    } catch (reloadError) {
      setError(`Không thể tải revision mới nhất: ${reloadError.message}`);
    }
  }

  // Save Revision (draft or approved)
  async function handleSaveRevision(statusToSave, automatic = false) {
    if (!selectedCase || savingRef.current || loadingRef.current || polygon.length || strokeRef.current) return false;
    if (sam2Preview) {
      if (!automatic) setError("Prediction MedSAM2 đang chờ duyệt. Hãy duyệt hoặc bỏ trước khi lưu.");
      return false;
    }
    if (propagatePreview && !automatic) {
      setError("Contour đang là preview. Hãy chấp nhận lát này hoặc bỏ preview trước khi lưu.");
      return false;
    }
    const nv = niivueRef.current;
    if (!nv || !nv.volumes.length) return;

    if (!reviewerIdentity || !reviewerAuthRef.current) {
      setError("Phiên BrainHem đã hết hạn; đăng nhập lại trước khi lưu nhãn.");
      requireEditorIdentity();
      return false;
    }

    if (statusToSave === "approved" && !canApprove) { setFeedback("Tài khoản không có quyền duyệt nhãn."); return false; }
    if (statusToSave === "approved") {
      if (!reviewerIdentity || !reviewerAuthRef.current) {
        setError("Vui lòng đăng nhập tài khoản người duyệt trước khi phê duyệt.");
        return;
      }
      if (!confirmEntireVolume) {
        setError("Vui lòng tích xác nhận 'Đã duyệt toàn bộ thể tích lát cắt' trước khi phê duyệt.");
        return;
      }
      const unreviewed = regionsRef.current.filter(region => !reviewedRegionKeys.has(region.key));
      if (regionsBusy || unreviewed.length) {
        setError(`Còn ${unreviewed.length || "một số"} vùng xuất huyết chưa được kiểm tra.`);
        return;
      }
    }

    savingRef.current = true;
    const savedEdit = editRef.current;
    const savedCaseId = selectedCase.id;
    setSaving(true);
    setSaveFailed(false);
    setSaveConflict(false);
    setError("");
    setFeedback("");

    try {
      // Export current drawing using NVImage orientation-aware saveToUint8Array
      const binaryMask = nv.drawBitmap.slice();
      normalizeMaskForSave(binaryMask);
      const maskBytes = await serializeDrawingMask(nv.volumes[0], binaryMask);
      if (!maskBytes || !(maskBytes instanceof Uint8Array)) {
        throw new Error("Không thể trích xuất thể tích bản vẽ từ WebGL");
      }

      // Safe Blob creation with Uint8Array
      const maskBlob = new Blob([maskBytes], { type: "application/gzip" });

      const saveIdentity = JSON.stringify([savedCaseId, savedEdit, selectedCase.current_revision,
        displayedRevisionNum, statusToSave, reviewNotes.trim(), confirmEntireVolume, provenanceCleared, reviewerIdentity]);
      if (pendingSaveRef.current?.identity !== saveIdentity) {
        pendingSaveRef.current = {identity: saveIdentity, operationId: crypto.randomUUID()};
      }
      const savedRev = await saveAnnotationRevision(selectedCase.id, {
        operationId: pendingSaveRef.current.operationId,
        maskBlob,
        filename: "mask.nii.gz",
        expectedRevision: selectedCase.current_revision,
        baseRevision: displayedRevisionNum,
        status: statusToSave,
        reviewer: reviewerIdentity,
        reviewerAuthorization: reviewerAuthRef.current,
        notes: reviewNotes.trim(),
        reviewedEntireVolume: confirmEntireVolume,
        clearProvenance: provenanceCleared,
      });

      if (activeCaseIdRef.current !== savedCaseId) return false;
      pendingSaveRef.current = null;
      removeDraft(draftKey(API_BASE, account.username, savedCaseId), savedEdit).catch(()=>{});
      setLocalDraftNotice("");
      setDirty(editRef.current !== savedEdit);
      setApprovalSummary(null);
      if (statusToSave === "approved") setShowFinish(false);
      setConfirmEntireVolume(false);
      if (editRef.current === savedEdit) setProvenanceCleared(false);
      if (savedRev?.revision_number) {
        setDisplayedRevisionNum(savedRev.revision_number);
      }
      if (!automatic) setFeedback(statusToSave === "approved" ? "Đã phê duyệt và chốt ca thành công!" : "Đã lưu bản nháp mới thành công!");

      // The successful write already supplies the new concurrency token. A failed
      // follow-up read must not turn a saved mask into a false save failure.
      const updatedCase = { ...selectedCase, current_revision: savedRev.revision_number,
        status: savedRev.status, updated_at: savedRev.created_at,
        latest_approved_revision: statusToSave === "approved" ? savedRev.revision_number : selectedCase.latest_approved_revision };
      setSelectedCase(updatedCase);
      setCases(items => items.map(item => item.id === savedCaseId ? updatedCase : item));
      setRevisions(items => [savedRev, ...items.filter(item => item.revision_number !== savedRev.revision_number)]);
      return true;
    } catch (saveErr) {
      persistWorkingDraft();
      setSaveFailed(true);
      const conflict = /revision conflict|expected revision|xung đột/i.test(saveErr.message);
      setSaveConflict(conflict);
      setError(conflict
        ? `Có revision mới trên máy chủ (${saveErr.message}). Mask local vẫn còn; hãy tải bản local hoặc nạp revision mới nhất.`
        : `Chưa lưu được nhãn: ${saveErr.message}. Bản vẽ vẫn còn trên màn hình.`);
      return false;
    } finally {
      savingRef.current = false; setSaving(false);
    }
  }

  useEffect(() => {
    if (!dirty || saving || editorLoading || saveFailed || showFinish || polygon.length || propagatePreview || sam2Preview) return;
    let idleId = null;
    const timer = setTimeout(() => {
      const saveWhenIdle = () => { if (!strokeRef.current) handleSaveRevision("draft", true); };
      if (typeof window.requestIdleCallback === "function") idleId = window.requestIdleCallback(saveWhenIdle, {timeout:5000});
      else saveWhenIdle();
    }, 3200);
    return () => {
      clearTimeout(timer);
      if (idleId != null && typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idleId);
    };
  }, [dirty, editTick, saving, editorLoading, saveFailed, showFinish, polygon.length, propagatePreview, sam2Preview, reviewerIdentity]);

  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(""), 4500);
    return () => clearTimeout(timer);
  }, [feedback]);

  useEffect(() => {
    function keyDown(event) {
      if(event.key==="Escape"&&componentFocusRef.current){event.preventDefault();exitComponentFocus();setSam2Menu(null);return;}
      if(event.key==="Escape")setSam2Menu(null);
      if (event.target.closest?.("input,textarea,select,[contenteditable=true]") || showFinish || showCreateModal) return;
      if (event.code === "Space") { event.preventDefault(); setHideHeld(true); return; }
      if (editorLoading) return;
      if (sam2Preview && event.key === "Escape") { event.preventDefault(); rejectSam2Preview(); return; }
      if (sam2Preview && !event.ctrlKey && !event.metaKey && (event.key === "ArrowRight" || event.key === "ArrowDown")) { event.preventDefault(); handleSliceChange(currentSlice + 1); return; }
      if (sam2Preview && !event.ctrlKey && !event.metaKey && (event.key === "ArrowLeft" || event.key === "ArrowUp")) { event.preventDefault(); handleSliceChange(currentSlice - 1); return; }
      if (sam2Preview) { event.preventDefault(); return; }
      if (propagatePreview && event.key === "Enter") { event.preventDefault(); finishPropagation({continueNext:true}); return; }
      if (propagatePreview && (event.key === "Backspace" || event.key === "Delete" || event.key === "Escape")) { event.preventDefault(); endPropagation(); return; }
      if ((event.ctrlKey || event.metaKey) && (event.key === "ArrowLeft" || event.key === "ArrowRight")) { event.preventDefault(); nextCase(event.key === "ArrowRight" ? 1 : -1); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); handleUndo(event.shiftKey); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); handleSaveRevision("draft"); return; }
      const mapping = {v:"pointer",b:"brush",e:"eraser",p:"fill",h:"pan"};
      const requestedTool = mapping[event.key.toLowerCase()];
      if (requestedTool && !polygon.length) {
        if (!["brush", "eraser", "fill"].includes(requestedTool) || requireEditorIdentity(requestedTool)) setActiveTool(requestedTool);
      }
      if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); handleSliceChange(currentSlice + 1); }
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); handleSliceChange(currentSlice - 1); }
      if (event.key === "Escape") { setPolygon([]); setPolygonClosed(false); }
      if (event.key === "Enter" && polygon.length >= 3) setPolygonClosed(true);
      if (event.key === "[") setBrushSize(v => Math.max(1,v-1));
      if (event.key === "]") setBrushSize(v => Math.min(20,v+1));
    }
    const release = () => { setHideHeld(false); };
    const strokeEnd = event => scheduleEndBrushStroke(event);
    window.addEventListener("keydown", keyDown); window.addEventListener("keyup", release); window.addEventListener("blur",release); window.addEventListener("pointerup",strokeEnd);
    return () => { window.removeEventListener("keydown",keyDown); window.removeEventListener("keyup",release); window.removeEventListener("blur",release); window.removeEventListener("pointerup",strokeEnd); };
  });

  useEffect(() => {
    const nv = niivueRef.current;
    const index = nv?.volumes.indexOf(aiVolumeRef.current);
    if (index > 0) nv.setOpacity(index, aiVisible && !hideHeld ? 0.45 : 0);
    Object.entries(aiReferenceVolumesRef.current).forEach(([key, volume]) => {
      const reference = referenceNiivueRefs.current[key];
      const referenceIndex = reference?.volumes.indexOf(volume);
      if (referenceIndex > 0) reference.setOpacity(referenceIndex, aiVisible && !hideHeld ? 0.45 : 0);
    });
  }, [aiVisible, hideHeld]);

  useEffect(() => {
    if (!polygon.length || !canvasRef.current) return;
    let timer;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const canvas = canvasRef.current, nv = niivueRef.current;
        const dims = nv?.volumes[0]?.dimsRAS;
        if (!canvas || !dims) return;
        const box = canvas.getBoundingClientRect();
        setPolygon(points => points.map(point => {
          const pos = nv.frac2canvasPos([(point.vx+.5)/dims[1], (point.vy+.5)/dims[2], (point.z+.5)/dims[3]]);
          return pos ? {...point, x:pos[0]*box.width/canvas.width, y:pos[1]*box.height/canvas.height} : point;
        }));
      }, 100);
    });
    observer.observe(canvasRef.current.parentElement);
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [polygon.length]);

  async function loadAiVisualization(mode = aiDisplayMode) {
    const probabilityUrl = inferenceJob?.artifacts?.probability;
    const sourceUrl = mode === "confidence" && probabilityUrl ? probabilityUrl : inferenceJob?.artifacts?.mask;
    if (!sourceUrl || aiLoading || editorLoading) return;
    const current = niivueRef.current;
    const currentIndex = current?.volumes.indexOf(aiVolumeRef.current);
    if (currentIndex > 0) current.removeVolumeByIndex(currentIndex);
    Object.entries(aiReferenceVolumesRef.current).forEach(([key, volume]) => {
      const reference = referenceNiivueRefs.current[key];
      const index = reference?.volumes.indexOf(volume);
      if (index > 0) reference.removeVolumeByIndex(index);
    });
    aiReferenceVolumesRef.current = {};
    aiVolumeRef.current = null;
    const seq = loadSeqRef.current;
    setAiLoading(true);
    try {
      const response = await fetchWithRetry(sourceUrl);
      if (!response.ok) throw Error("Không tải được gợi ý AI");
      const blob = await response.blob();
      const isConfidence = mode === "confidence" && Boolean(probabilityUrl);
      const volume = await NVImage.loadFromFile({ file:new File([blob], isConfidence?"probability.nii.gz":"ai.nii.gz"), name:isConfidence?"Xác suất voxel":"Gợi ý AI", colormap:isConfidence?CONFIDENCE_COLORMAP:"blue", opacity:0.45, cal_min:isConfidence?aiThreshold:0, cal_max:1, trustCalMinMax:true, colormapType:isConfidence?1:0 });
      if (seq !== loadSeqRef.current) return;
      if (!isConfidence) volume.setColormapLabel({ R:[0,56], G:[0,150], B:[0,255], A:[0,220], I:[0,1], labels:["Nền", "Gợi ý AI"] });
      current.addVolume(volume); aiVolumeRef.current = volume;
      for (const [key, reference] of Object.entries(referenceNiivueRefs.current)) {
        const clone = volume.clone();
        reference.addVolume(clone);
        aiReferenceVolumesRef.current[key] = clone;
      }
      setAiVisible(true);
    } catch (err) { if (seq === loadSeqRef.current) setError(err.message); }
    finally { if (seq === loadSeqRef.current) setAiLoading(false); }
  }

  async function toggleAi() {
    if (aiVolumeRef.current) { setAiVisible(v => !v); return; }
    await loadAiVisualization(aiDisplayMode);
  }

  function changeAiDisplayMode(mode) {
    if (mode === "confidence" && !inferenceJob?.artifacts?.probability) return;
    setAiDisplayMode(mode);
    loadAiVisualization(mode);
  }

  useEffect(() => {
    if (aiDisplayMode !== "confidence" || !aiVolumeRef.current) return;
    const timer = setTimeout(() => {
      [aiVolumeRef.current, ...Object.values(aiReferenceVolumesRef.current)].forEach((volume) => {
        if (!volume) return;
        volume.cal_min = aiThreshold;
        volume.cal_max = 1;
      });
      niivueRef.current?.updateGLVolume();
      Object.values(referenceNiivueRefs.current).forEach(reference => reference?.updateGLVolume());
    }, 100);
    return () => clearTimeout(timer);
  }, [aiThreshold, aiDisplayMode]);

  function nextCase(direction = 1, unfinished = false, alreadySaved = false) {
    const readableCases = (unfinished ? cases : filteredCases).filter(c => !/^AUDIT_/i.test(c.name || ""));
    const index = readableCases.findIndex(c => c.id === selectedCase?.id);
    const remaining = direction > 0 ? [...readableCases.slice(index + 1), ...readableCases.slice(0,index)] : readableCases.slice(0,index).reverse();
    const next = remaining.find(c => !unfinished || c.status !== "approved");
    if (next) handleSelectCase(next, alreadySaved); else setFeedback("Không còn ca phù hợp trong danh sách.");
  }

  function zoomView(factor) {
    if (polygon.length || blocked) return;
    const nv = niivueRef.current;
    const transform = [...nv.scene.pan2Dxyzmm];
    transform[3] = Math.max(0.5, Math.min(8, transform[3] * factor));
    nv.setPan2Dxyzmm(transform);
  }

  function focusRegionInViewer(region) {
    const nv = niivueRef.current;
    const dims = nv?.volumes?.[0]?.dimsRAS;
    if (!region || !dims) return;
    const [x, y, z] = region.center;
    nv.scene.crosshairPos = [
      (x + 0.5) / dims[1],
      (y + 0.5) / dims[2],
      (z + 0.5) / dims[3],
    ];
    nv.createOnLocationChange();
    nv.drawScene();
    syncLabelCrosshair(nv);
    const axis = LABEL_VIEWS.find((item) => item.id === viewMode)?.axis;
    if (Number.isInteger(axis)) setCurrentSlice([x, y, z][axis]);
  }

  function highlightRegionsInViewer(selectedRegions) {
    const main = niivueRef.current;
    if (!main?.drawBitmap) return;
    const wasLoading = loadingRef.current;
    loadingRef.current = true;
    try {
      const previous = highlightedRegionVoxelsRef.current;
      if (previous) for (const index of previous) {
        if (main.drawBitmap[index] === 2) main.drawBitmap[index] = 1;
      }
      const highlighted = [];
      let selectedBounds = null;
      for (const region of selectedRegions || []) {
        selectedBounds = unionDrawingBounds(selectedBounds, region.bounds);
        for (const index of region.voxels) {
          // Selection changes colour only; it must never create label voxels.
          if (main.drawBitmap[index] !== 1 && main.drawBitmap[index] !== 2) continue;
          main.drawBitmap[index] = 2;
          highlighted.push(index);
        }
      }
      const changedBounds = unionDrawingBounds(highlightedRegionBoundsRef.current, selectedBounds);
      highlightedRegionVoxelsRef.current = highlighted.length ? highlighted : null;
      highlightedRegionBoundsRef.current = selectedBounds;
      if (!changedBounds) return;
      if (updateDrawingTextureBox(main, main.drawBitmap, changedBounds)) main.drawScene();
      else main.refreshDrawing(true, false);

      // Coalesce rapid clicks. Each reference gets the latest bitmap and the
      // union of all changed regions, including clicks superseded mid-refresh.
      const pending = highlightRefreshRef.current;
      pending.bounds = unionDrawingBounds(pending.bounds, changedBounds);
      if (pending.frame) cancelAnimationFrame(pending.frame);
      const caseSeq = loadSeqRef.current;
      const references = Object.values(referenceNiivueRefs.current).filter(v => v?.volumes?.length);
      let index = 0;
      const refreshNext = () => {
        pending.frame = null;
        if (caseSeq !== loadSeqRef.current || main !== niivueRef.current) return;
        const reference = references[index++];
        if (reference) {
          reference.drawBitmap = main.drawBitmap;
          if (updateDrawingTextureBox(reference, main.drawBitmap, pending.bounds)) reference.drawScene();
          else reference.refreshDrawing(true);
        }
        if (index < references.length) pending.frame = requestAnimationFrame(refreshNext);
        else pending.bounds = null;
      };
      pending.frame = requestAnimationFrame(refreshNext);
    } finally {
      loadingRef.current = wasLoading;
    }
  }

  function highlightRegionInViewer(region) {
    highlightRegionsInViewer(region ? [region] : []);
  }

  function regionIntersectsCurrentPlane(region) {
    const nv = niivueRef.current;
    const dims = nv?.volumes?.[0]?.dimsRAS;
    const axis = LABEL_VIEWS.find(item => item.id === viewModeRef.current)?.axis;
    if (!region || !dims || !Number.isInteger(axis) || viewModeRef.current === "render") return true;
    const voxel = nv.frac2vox(nv.scene.crosshairPos);
    const plane = Math.max(0, Math.min(dims[axis + 1] - 1, Math.round(voxel[axis])));
    const bounds = region.bounds;
    const boundPairs = [[bounds?.minX,bounds?.maxX],[bounds?.minY,bounds?.maxY],[bounds?.minZ,bounds?.maxZ]];
    const [minimum, maximum] = boundPairs[axis];
    if (Number.isFinite(minimum) && (plane < minimum || plane > maximum)) return false;
    const dimX = dims[1], dimY = dims[2], stride = dimX * dimY;
    for (const index of region.voxels) {
      const z = Math.floor(index / stride);
      const within = index - z * stride;
      const y = Math.floor(within / dimX);
      const x = within - y * dimX;
      if ([x,y,z][axis] === plane) return true;
    }
    return false;
  }

  function selectRegion(region, navigate = null, additive = false) {
    if (!region) return;
    if (mergeSourceKey && mergeSourceKey !== region.key) {
      mergeSelectedRegions(regionsRef.current.find(item => item.key === mergeSourceKey), region);
      return;
    }
    let nextKeys;
    if (additive) {
      nextKeys = new Set(selectedRegionKeysRef.current);
      if (nextKeys.has(region.key)) nextKeys.delete(region.key);
      else nextKeys.add(region.key);
    } else {
      nextKeys = new Set([region.key]);
    }
    const nextPrimary = nextKeys.has(region.key)
      ? region.key
      : [...nextKeys].at(-1) || null;
    selectedRegionKeyRef.current = nextPrimary;
    selectedRegionKeysRef.current = nextKeys;
    setSelectedRegionKey(nextPrimary);
    setSelectedRegionKeys(nextKeys);
    highlightRegionsInViewer(regionsRef.current.filter(item => nextKeys.has(item.key)));
    const shouldNavigate = navigate === true || (navigate == null && !regionIntersectsCurrentPlane(region));
    if (shouldNavigate && !additive) focusRegionInViewer(region);
  }

  function findRegionAtVoxel(index) {
    for (const region of regionsRef.current) {
      const values = region.voxels;
      let low = 0;
      let high = values.length - 1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        const value = values[middle];
        if (value === index) return region;
        if (value < index) low = middle + 1;
        else high = middle - 1;
      }
    }
    return null;
  }

  function findRegionNearVoxel(voxel,dims) {
    const [x,y,z]=voxel;
    const exact=findRegionAtVoxel(x+y*dims[1]+z*dims[1]*dims[2]);
    if(exact)return exact;
    const axis=LABEL_VIEWS.find(item=>item.id===viewModeRef.current)?.axis;
    if(!Number.isInteger(axis))return null;
    const freeAxes=[0,1,2].filter(value=>value!==axis);
    for(let radius=1;radius<=3;radius+=1){
      let best=null;
      for(let first=-radius;first<=radius;first+=1){
        for(let second=-radius;second<=radius;second+=1){
          if(Math.max(Math.abs(first),Math.abs(second))!==radius)continue;
          const candidate=[x,y,z];candidate[freeAxes[0]]+=first;candidate[freeAxes[1]]+=second;
          if(candidate.some((value,index)=>value<0||value>=dims[index+1]))continue;
          const region=findRegionAtVoxel(candidate[0]+candidate[1]*dims[1]+candidate[2]*dims[1]*dims[2]);
          if(region){
            const distance=first*first+second*second;
            if(!best||distance<best.distance)best={region,distance};
          }
        }
      }
      if(best)return best.region;
    }
    return null;
  }

  function selectRegionAtCrosshair(event) {
    if (event?.shiftKey && shiftSelectionHandledRef.current) {
      shiftSelectionHandledRef.current = false;
      return;
    }
    shiftSelectionHandledRef.current = false;
    if ((activeToolRef.current !== "pointer" && !event?.shiftKey) || regionsBusy) return;
    const pointerRegion = regionAtCanvasPointer(event);
    if (pointerRegion) {
      selectRegion(pointerRegion, null, Boolean(event?.shiftKey));
      return;
    }
    const loc = locationRef.current;
    const dims = niivueRef.current?.volumes?.[0]?.dimsRAS;
    if (!loc?.vox || !dims) return;
    const x = Math.max(0, Math.min(dims[1] - 1, Math.round(loc.vox[0])));
    const y = Math.max(0, Math.min(dims[2] - 1, Math.round(loc.vox[1])));
    const z = Math.max(0, Math.min(dims[3] - 1, Math.round(loc.vox[2])));
    const region = findRegionNearVoxel([x,y,z],dims);
    if (region) selectRegion(region, null, Boolean(event?.shiftKey));
  }

  function selectRegionOnShiftPointerUp(event) {
    if (!event.shiftKey || regionsBusy) return;
    const region = regionAtCanvasPointer(event);
    if (!region) return;
    event.preventDefault();
    event.stopPropagation();
    shiftSelectionHandledRef.current = true;
    selectRegion(region, false, true);
  }

  function reviewSelectedRegion() {
    if (!requireEditorIdentity()) return;
    const region = regionsRef.current.find(item => item.key === selectedRegionKeyRef.current);
    if (!region) return;
    const nextReviewed = new Set(reviewedRegionKeys);
    nextReviewed.add(region.key);
    reviewedRegionKeysRef.current = nextReviewed;
    setReviewedRegionKeys(nextReviewed);
    const next = regionsRef.current.find(item => !nextReviewed.has(item.key));
    if (next) selectRegion(next);
    else setFeedback("Đã kiểm tra tất cả vùng. Hãy rà nhanh toàn bộ thể tích trước khi hoàn tất ca.");
  }

  function removeSelectedRegion() {
    if (!requireEditorIdentity()) return;
    const nv = niivueRef.current;
    const region = regionsRef.current.find(item => item.key === selectedRegionKeyRef.current);
    if (!nv?.drawBitmap || !region || editorLoading) return;
    exitComponentFocus();setSam2Menu(null);checkpoint();
    for (const index of region.voxels) nv.drawBitmap[index] = 0;
    nv.refreshDrawing(true);
    selectedRegionKeyRef.current = null;
    selectedRegionKeysRef.current = new Set();
    setSelectedRegionKey(null);
    setSelectedRegionKeys(new Set());
    setReviewedRegionKeys(previous => {
      const next = new Set(previous);
      next.delete(region.key);
      reviewedRegionKeysRef.current = next;
      return next;
    });
    setFeedback(`Đã loại bỏ vùng ${region.number}. Có thể hoàn tác bằng Ctrl/⌘ Z.`);
    changed();
  }

  function removeSelectedRegions() {
    if (!requireEditorIdentity()) return;
    const nv = niivueRef.current;
    const selected = regionsRef.current.filter(item => selectedRegionKeysRef.current.has(item.key));
    if (!nv?.drawBitmap || !selected.length || editorLoading) return;
    exitComponentFocus();setSam2Menu(null);checkpoint();
    for (const region of selected) for (const index of region.voxels) nv.drawBitmap[index] = 0;
    nv.refreshDrawing(true);
    const removedKeys = new Set(selected.map(region => region.key));
    selectedRegionKeyRef.current = null;
    selectedRegionKeysRef.current = new Set();
    setSelectedRegionKey(null);
    setSelectedRegionKeys(new Set());
    setReviewedRegionKeys(previous => {
      const next = new Set([...previous].filter(key => !removedKeys.has(key)));
      reviewedRegionKeysRef.current = next;
      return next;
    });
    setFeedback(`Đã loại bỏ ${selected.length} component. Có thể hoàn tác bằng Ctrl/⌘ Z.`);
    changed();
  }

  function beginAddRegion() {
    if (!requireEditorIdentity("brush")) return;
    setMergeSourceKey(null);
    setAutoConnectBrush(false);
    setActiveTool("brush");
    setFeedback("Thêm ổ mới: tô vùng tổn thương trên một hoặc nhiều lát. Hệ thống sẽ tự gom thành component 3D.");
  }

  function beginSplitRegion() {
    if (!requireEditorIdentity("eraser")) return;
    const region = regionsRef.current.find(item => item.key === selectedRegionKeyRef.current);
    if (!region) return;
    setMergeSourceKey(null);
    highlightRegionInViewer(region);
    focusRegionInViewer(region);
    setActiveTool("eraser");
    setFeedback(`Tách ${componentId(region)}: xóa phần cầu nối sai. Khi hai phần rời nhau trong 3D, danh sách sẽ tự cập nhật thành hai component.`);
  }

  function beginMergeRegion() {
    if (!requireEditorIdentity()) return;
    const region = regionsRef.current.find(item => item.key === selectedRegionKeyRef.current);
    if (!region || regionsRef.current.length < 2) return;
    setActiveTool("pointer");
    setMergeSourceKey(region.key);
    setFeedback(`Đang chọn ${componentId(region)} để gộp. Click một component khác trên ảnh hoặc trong danh sách.`);
  }

  function mergeSelectedRegions(source, target) {
    const nv = niivueRef.current;
    const dimsRAS = nv?.volumes?.[0]?.dimsRAS;
    if (!source || !target || !nv?.drawBitmap || !dimsRAS || source.key === target.key) return;
    const sample = voxels => {
      const step = Math.max(1, Math.ceil(voxels.length / 384));
      const result = [];
      for (let index = 0; index < voxels.length; index += step) result.push(voxels[index]);
      result.push(voxels[voxels.length - 1]);
      return result;
    };
    const dimX = dimsRAS[1], dimY = dimsRAS[2];
    const stride = dimX * dimY;
    const coordinates = index => {
      const z = Math.floor(index / stride);
      const within = index - z * stride;
      const y = Math.floor(within / dimX);
      return [within - y * dimX, y, z];
    };
    let nearest = null;
    const sourceSamples = sample(source.voxels);
    const targetSamples = sample(target.voxels);
    for (const sourceIndex of sourceSamples) {
      const a = coordinates(sourceIndex);
      for (const targetIndex of targetSamples) {
        const b = coordinates(targetIndex);
        const distance = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
        if (!nearest || distance < nearest.distance) nearest = { a, b, distance };
      }
    }
    if (!nearest || nearest.distance > 18) {
      setMergeSourceKey(null);
      setError(`Không gộp ${componentId(source)} với ${componentId(target)}: khoảng hở quá lớn (${nearest?.distance || "—"} voxel). Hãy chỉnh biên thủ công để tránh tô qua mô lành.`);
      return;
    }
    if (!window.confirm(`Gộp ${componentId(source)} và ${componentId(target)} bằng cách lấp khoảng hở ${nearest.distance} voxel? Thao tác này thay đổi mask thật và có thể hoàn tác.`)) return;
    checkpoint();
    normalizeBinaryMask(nv.drawBitmap);
    const cursor = [...nearest.a];
    const paint = () => { nv.drawBitmap[cursor[0] + cursor[1] * dimX + cursor[2] * stride] = 1; };
    paint();
    for (const axis of [0, 1, 2]) {
      while (cursor[axis] !== nearest.b[axis]) {
        cursor[axis] += cursor[axis] < nearest.b[axis] ? 1 : -1;
        paint();
      }
    }
    pendingRegionCenterRef.current = source.voxelCount >= target.voxelCount ? source.center : target.center;
    setMergeSourceKey(null);
    nv.refreshDrawing(true);
    scheduleReferenceDrawingRefresh();
    setFeedback(`Đã gộp ${componentId(source)} với ${componentId(target)}. Danh sách component đang được tính lại.`);
    changed();
  }

  function refreshPropagationDrawing() {
    const main = niivueRef.current;
    if (!main?.drawBitmap) return;
    loadingRef.current = true;
    [main, ...Object.values(referenceNiivueRefs.current)].forEach(target => {
      if (!target?.drawBitmap) return;
      if (target !== main) target.drawBitmap = main.drawBitmap;
      target.setDrawColormap(LABEL_DRAW_LUT);
      target.refreshDrawing(true, false);
    });
    loadingRef.current = false;
  }

  function startPropagationFrom(sourceSlice, sourceIndices, regionNumber) {
    const nv = niivueRef.current;
    const dims = nv?.volumes?.[0]?.dimsRAS;
    if (!nv?.drawBitmap || !dims) return;
    const dimX = dims[1], dimY = dims[2], dimZ = dims[3];
    const stride = dimX * dimY;
    const targetSlice = sourceSlice + 1;
    if (targetSlice >= dimZ) {
      setFeedback("Đã tới lát Axial cuối cùng của thể tích.");
      return;
    }
    const targetOffset = targetSlice * stride;
    const targetIndices = sourceIndices.map(index => targetOffset + (index % stride));
    const overlapsExistingLabel = targetIndices.some(index => nv.drawBitmap[index] === 1 || nv.drawBitmap[index] === 2);
    if (overlapsExistingLabel) {
      nv.setSliceType(SLICE_TYPE.AXIAL);
      nv.scene.crosshairPos[2] = (targetSlice + 0.5) / dimZ;
      nv.createOnLocationChange();
      nv.drawScene();
      syncLabelCrosshair(nv);
      setViewMode("axial"); viewModeRef.current = "axial"; setTotalSlices(dimZ); setCurrentSlice(targetSlice);
      setError(`Contour sao chép chồng lên nhãn đã có ở lát ${targetSlice + 1}. Hệ thống không ghi đè; hãy dùng Chỉnh biên trên lát đó.`);
      return;
    }
    for (let index = 0; index < nv.drawBitmap.length; index += 1) if (nv.drawBitmap[index] === 3) nv.drawBitmap[index] = 0;
    for (const index of targetIndices) nv.drawBitmap[index] = 3;
    const preview = { sourceSlice, targetSlice, indices: targetIndices, regionNumber };
    propagatePreviewRef.current = preview;
    setPropagatePreview(preview);
    setActiveTool("pointer");
    setViewMode("axial");
    viewModeRef.current = "axial";
    nv.setSliceType(SLICE_TYPE.AXIAL);
    setTotalSlices(dimZ);
    nv.scene.crosshairPos[2] = (targetSlice + 0.5) / dimZ;
    nv.createOnLocationChange();
    nv.drawScene();
    syncLabelCrosshair(nv);
    setCurrentSlice(targetSlice);
    refreshPropagationDrawing();
    setFeedback(`Đã sao chép ${componentId({ number: regionNumber })} từ lát ${sourceSlice + 1}. Màu xanh là preview, chưa được tính là nhãn.`);
  }

  function beginPropagation() {
    if (!requireEditorIdentity()) return;
    const nv = niivueRef.current;
    const dims = nv?.volumes?.[0]?.dimsRAS;
    const region = regionsRef.current.find(item => item.key === selectedRegionKeyRef.current);
    if (!nv?.drawBitmap || !dims || !region) return;
    const stride = dims[1] * dims[2];
    // A selected 3D component is focused at its center. Propagating from that
    // center usually collides with the component's already-labelled next
    // slice, so sequential review starts at its superior axial boundary.
    let sourceSlice = region.sliceEnd;
    let sourceIndices = Array.from(region.voxels).filter(index => Math.floor(index / stride) === sourceSlice);
    if (!sourceIndices.length) {
      sourceSlice = region.center[2];
      sourceIndices = Array.from(region.voxels).filter(index => Math.floor(index / stride) === sourceSlice);
    }
    if (!sourceIndices.length) {
      setError(`Không tìm thấy contour của ${componentId(region)} trên lát nguồn.`);
      return;
    }
    startPropagationFrom(sourceSlice, sourceIndices, region.number);
  }

  function replacePropagationIndices(nextIndices) {
    const nv = niivueRef.current;
    if (!nv?.drawBitmap || !propagatePreview) return;
    if (nextIndices.some(index => nv.drawBitmap[index] === 1 || nv.drawBitmap[index] === 2)) {
      setError("Không thể biến đổi preview vì sẽ chồng lên nhãn đã xác nhận khác.");
      return;
    }
    for (const index of propagatePreview.indices) if (nv.drawBitmap[index] === 3) nv.drawBitmap[index] = 0;
    for (const index of nextIndices) nv.drawBitmap[index] = 3;
    const preview = { ...propagatePreview, indices: nextIndices };
    propagatePreviewRef.current = preview;
    setPropagatePreview(preview);
    refreshPropagationDrawing();
  }

  function reshapePropagation(mode) {
    const nv = niivueRef.current;
    const dims = nv?.volumes?.[0]?.dimsRAS;
    if (!nv?.drawBitmap || !dims || !propagatePreview) return;
    const dimX = dims[1], dimY = dims[2], stride = dimX * dimY;
    const offset = propagatePreview.targetSlice * stride;
    const local = new Set(propagatePreview.indices.map(index => index - offset));
    const next = new Set();
    if (mode === "grow") {
      for (const value of local) {
        const x = value % dimX, y = Math.floor(value / dimX);
        for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < dimX && ny >= 0 && ny < dimY) next.add(nx + ny * dimX);
        }
      }
    } else {
      for (const value of local) {
        const x = value % dimX, y = Math.floor(value / dimX);
        if (x > 0 && x + 1 < dimX && y > 0 && y + 1 < dimY &&
          local.has(value - 1) && local.has(value + 1) && local.has(value - dimX) && local.has(value + dimX)) next.add(value);
      }
      if (!next.size) {
        setError("Không thể thu nhỏ thêm: preview sẽ biến mất hoàn toàn.");
        return;
      }
    }
    replacePropagationIndices([...next].map(value => offset + value));
  }

  function movePropagation(dx, dy) {
    const nv = niivueRef.current;
    const dims = nv?.volumes?.[0]?.dimsRAS;
    if (!nv?.drawBitmap || !dims || !propagatePreview) return;
    const dimX = dims[1], dimY = dims[2], stride = dimX * dimY;
    const offset = propagatePreview.targetSlice * stride;
    const next = [];
    for (const index of propagatePreview.indices) {
      const local = index - offset;
      const x = local % dimX, y = Math.floor(local / dimX);
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= dimX || ny < 0 || ny >= dimY) {
        setError("Không thể dịch preview ra ngoài ảnh.");
        return;
      }
      next.push(offset + nx + ny * dimX);
    }
    replacePropagationIndices(next);
  }

  function finishPropagation({ continueNext = false, edit = false } = {}) {
    const nv = niivueRef.current;
    if (!nv?.drawBitmap || !propagatePreview) return;
    const accepted = [...propagatePreview.indices];
    for (const index of accepted) if (nv.drawBitmap[index] === 3) nv.drawBitmap[index] = 0;
    checkpoint();
    for (const index of accepted) nv.drawBitmap[index] = 1;
    const acceptedSlice = propagatePreview.targetSlice;
    const regionNumber = propagatePreview.regionNumber;
    const activeRegion = regionsRef.current.find(item => item.key === selectedRegionKeyRef.current);
    if (activeRegion) pendingRegionCenterRef.current = [activeRegion.center[0], activeRegion.center[1], acceptedSlice];
    propagatePreviewRef.current = null;
    setPropagatePreview(null);
    setConfirmedPropagatedSlices(previous => new Set(previous).add(acceptedSlice));
    refreshPropagationDrawing();
    changed();
    if (edit) {
      setActiveTool("brush");
      setFeedback(`Đã chấp nhận preview ở lát ${acceptedSlice + 1}. Dùng bút/tẩy để chỉnh biên.`);
    } else if (continueNext) {
      setTimeout(() => startPropagationFrom(acceptedSlice, accepted, regionNumber), 0);
    } else {
      setFeedback(`Đã chấp nhận contour ở lát ${acceptedSlice + 1}.`);
    }
  }

  function endPropagation() {
    const nv = niivueRef.current;
    if (!nv?.drawBitmap || !propagatePreview) return;
    const targetSlice = propagatePreview.targetSlice;
    for (const index of propagatePreview.indices) if (nv.drawBitmap[index] === 3) nv.drawBitmap[index] = 0;
    propagatePreviewRef.current = null;
    setPropagatePreview(null);
    refreshPropagationDrawing();
    setFeedback(`Đã dừng lan truyền sau lát ${targetSlice}; preview lát ${targetSlice + 1} đã bị bỏ.`);
  }

  function moveSelectedRegion(dx, dy, dz) {
    if (!requireEditorIdentity()) return;
    const nv = niivueRef.current;
    const region = regionsRef.current.find(item => item.key === selectedRegionKeyRef.current);
    const dims = nv?.volumes?.[0]?.dimsRAS;
    if (!nv?.drawBitmap || !region || !dims || editorLoading) return;
    const dimX = dims[1], dimY = dims[2], dimZ = dims[3];
    const sliceStride = dimX * dimY;
    const offsetX = dx * regionMoveStep;
    const offsetY = dy * regionMoveStep;
    const offsetZ = dz * regionMoveStep;
    const destinations = new Uint32Array(region.voxels.length);
    for (let position = 0; position < region.voxels.length; position += 1) {
      const index = region.voxels[position];
      const z = Math.floor(index / sliceStride);
      const inSlice = index - z * sliceStride;
      const y = Math.floor(inSlice / dimX);
      const x = inSlice - y * dimX;
      const nextX = x + offsetX, nextY = y + offsetY, nextZ = z + offsetZ;
      if (nextX < 0 || nextX >= dimX || nextY < 0 || nextY >= dimY || nextZ < 0 || nextZ >= dimZ) {
        setError("Không thể dịch ổ ra ngoài thể tích CT.");
        return;
      }
      destinations[position] = nextX + nextY * dimX + nextZ * sliceStride;
    }
    checkpoint();
    for (const index of region.voxels) nv.drawBitmap[index] = 0;
    for (const index of destinations) nv.drawBitmap[index] = 1;
    pendingRegionCenterRef.current = [
      region.center[0] + offsetX,
      region.center[1] + offsetY,
      region.center[2] + offsetZ,
    ];
    setReviewedRegionKeys(previous => {
      const next = new Set(previous);
      next.delete(region.key);
      reviewedRegionKeysRef.current = next;
      return next;
    });
    nv.refreshDrawing(true);
    scheduleReferenceDrawingRefresh();
    setFeedback(`Đã dịch toàn bộ ổ ${region.number} ${regionMoveStep} voxel. Thay đổi áp dụng đồng thời trên Axial, Coronal, Sagittal và 3D.`);
    changed();
  }

  function editSelectedRegion() {
    if (!requireEditorIdentity("brush")) return;
    const region = regionsRef.current.find(item => item.key === selectedRegionKeyRef.current);
    if (!region) return;
    setReviewedRegionKeys(previous => {
      const next = new Set(previous);
      next.delete(region.key);
      reviewedRegionKeysRef.current = next;
      return next;
    });
    focusRegionInViewer(region);
    setActiveTool("brush");
  }

  function changeLabelView(nextId) {
    const nv = niivueRef.current;
    if (!nv?.volumes?.length || polygon.length || propagatePreview) return;
    const next = LABEL_VIEWS.find((item) => item.id === nextId) || LABEL_VIEWS[0];
    viewModeRef.current = next.id;
    setViewMode(next.id);
    nv.setSliceType(next.type);
    if (activeToolRef.current === "pointer" || activeToolRef.current === "pan") {
      nv.setDragMode(next.id === "render" ? DRAG_MODE.crosshair : DRAG_MODE.pan);
      nv.setMouseEventConfig({
        leftButton: { primary: next.id === "render" ? DRAG_MODE.crosshair : DRAG_MODE.pan },
        rightButton: DRAG_MODE.none,
        centerButton: DRAG_MODE.pan,
      });
    }
    const dims = nv.volumes[0].dimsRAS;
    if (Number.isInteger(next.axis)) {
      const nextTotal = dims?.[next.axis + 1] || 1;
      const nextSlice = Math.floor((nv.scene.crosshairPos?.[next.axis] ?? 0.5) * nextTotal);
      setTotalSlices(nextTotal);
      setCurrentSlice(Math.max(0, Math.min(nextTotal - 1, nextSlice)));
    }
    if ((next.id !== "axial" && activeToolRef.current === "fill") || (next.id === "render" && ["brush", "eraser"].includes(activeToolRef.current))) setActiveTool("pointer");
    nv.drawScene();
    syncLabelCrosshair(nv);
    requestAnimationFrame(() => {
      if (niivueRef.current !== nv) return;
      if (activeToolRef.current === "pointer" || activeToolRef.current === "pan") {
        nv.setDragMode(next.id === "render" ? DRAG_MODE.crosshair : DRAG_MODE.pan);
        nv.setMouseEventConfig({
          leftButton: { primary: next.id === "render" ? DRAG_MODE.crosshair : DRAG_MODE.pan },
          rightButton: DRAG_MODE.none,
          centerButton: DRAG_MODE.pan,
        });
      }
      nv.resizeListener();
      nv.drawScene();
    });
  }

  function toggleMultiplanar() {
    changeLabelView(viewMode === "axial" ? "coronal" : "axial");
  }

  function pointFromEvent(event) {
    const canvas = canvasRef.current, nv = niivueRef.current;
    const box = canvas.getBoundingClientRect();
    const x = event.clientX - box.left, y = event.clientY - box.top;
    const frac = nv.canvasPos2frac([x * canvas.width / box.width, y * canvas.height / box.height]);
    if (!frac || frac.some(v => v < 0 || v > 1)) return null;
    const dims = nv.volumes[0].dimsRAS;
    return {x,y,vx:frac[0]*dims[1]-0.5,vy:frac[1]*dims[2]-0.5,z:Math.round(frac[2]*dims[3]-0.5)};
  }

  function applyPolygon() {
    if (!requireEditorIdentity("fill")) return;
    const nv = niivueRef.current;
    if (!polygonClosed || polygon.length < 3 || editorLoading) return;
    const dims = nv.volumes[0].dimsRAS, z = polygon[0].z;
    checkpoint();
    const minY=Math.max(0,Math.floor(Math.min(...polygon.map(point=>point.vy))));
    const maxY=Math.min(dims[2]-1,Math.ceil(Math.max(...polygon.map(point=>point.vy))));
    const sliceOffset=z*dims[1]*dims[2];
    // Scanline fill scales with contour edges and rows instead of testing every
    // pixel against every polygon edge.
    for(let y=minY;y<=maxY;y++) {
      const crossings=[];
      for(let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
        const a=polygon[i],b=polygon[j];
        if ((a.vy>y)!==(b.vy>y)) crossings.push((b.vx-a.vx)*(y-a.vy)/(b.vy-a.vy)+a.vx);
      }
      crossings.sort((a,b)=>a-b);
      for(let i=0;i+1<crossings.length;i+=2) {
        const start=Math.max(0,Math.ceil(crossings[i]));
        const end=Math.min(dims[1]-1,Math.floor(crossings[i+1]));
        if(end>=start)nv.drawBitmap.fill(1,sliceOffset+y*dims[1]+start,sliceOffset+y*dims[1]+end+1);
      }
    }
    loadingRef.current=true;
    nv.refreshDrawing(true);
    loadingRef.current=false;
    setPolygon([]);setPolygonClosed(false);changed();
  }

  function stopPolling() {
    if (pollIntervalRef.current) {
      pollIntervalRef.current();
      pollIntervalRef.current = null;
    }
    setInferenceBusy(false);
  }

  // Inference actions
  async function handleRequestInference() {
    if (!selectedCase || editorLoading || inferenceBusy) return;
    stopPolling();
    setInferenceBusy(true);
    setError("");
    setFeedback("");
    const caseIdForInf = selectedCase.id;
    const tierToRun = selectedTier;
    const tierLabel = TIER_META[tierToRun]?.label || tierToRun;
    try {
      const job = await runCaseInference(caseIdForInf, tierToRun, false);
      if (activeCaseIdRef.current !== caseIdForInf) return;
      rememberJob(API_BASE, account.username, caseIdForInf, job.id);
      setInferenceJob(job);
      setFeedback(jobMessage(job));

      // Poll until finished
      pollJob(job.id, caseIdForInf, tierLabel);
    } catch (infErr) {
      setInferenceBusy(false);
      setError(`Lỗi phân tích: ${infErr.message}`);
    }
  }

  function pollJob(jobId, caseId, tierLabel) {
    const token = ++pollTokenRef.current;
    if (pollIntervalRef.current) pollIntervalRef.current();
    setInferenceBusy(true);
    const isCurrent = () => pollTokenRef.current === token && activeCaseIdRef.current === caseId;
    pollIntervalRef.current = trackJob({
      read: signal => getJob(jobId, signal),
      onConnection: connected => { if (isCurrent()) setInferenceDisconnected(!connected); },
      onUnavailable: reason => {
        if (!isCurrent()) return;
        setInferenceJob(null);setInferenceBusy(false);setInferenceDisconnected(false);
        setError(reason.message);rememberJob(API_BASE,account.username,caseId,null);
      },
      onJob: job => {
        if (!isCurrent()) return;
        setInferenceJob(job);
        setInferenceBusy(ACTIVE_JOB_STATUSES.has(job.status));
        setFeedback(jobMessage(job));
        if (job.status === "failed") setError(jobMessage(job));
      },
    });
  }

  async function handleImportAiMask() {
    if (!selectedCase || !inferenceJob || savingRef.current || polygon.length) return;
    if (!requireEditorIdentity()) return;
    if (selectedCase.current_revision > 0 && !window.confirm("Dùng gợi ý AI thay cho bản nhãn hiện tại? Phiên bản đã lưu vẫn được giữ trong lịch sử.")) return;
    if (dirty) {
      const ok = window.confirm("Bản vẽ hiện tại có thay đổi chưa lưu. Nhập mặt nạ AI sẽ ghi đè bản vẽ trên màn hình. Bạn có chắc muốn tiếp tục?");
      if (!ok) return;
    }
    loadingRef.current = true;
    setEditorLoading(true);
    setError("");
    try {
      if (inferenceJob.artifacts?.probability) {
        const response = await fetchWithRetry(inferenceJob.artifacts.probability);
        if (!response.ok) throw Error("Không tải được probability map để tạo mask theo ngưỡng");
        const blob = await response.blob();
        const probability = await NVImage.loadFromFile({ file:new File([blob], "probability.nii.gz"), name:"Probability", colormap:"hot", opacity:0, cal_min:0, cal_max:1, trustCalMinMax:true });
        const thresholded = probability.clone();
        const mask = new Uint8Array(probability.img.length);
        for (let index=0; index<probability.img.length; index+=1) mask[index] = Number(probability.img[index]) >= aiThreshold ? 1 : 0;
        thresholded.img = mask;
        const nv = niivueRef.current;
        checkpoint();
        nv.loadDrawing(thresholded);
        nv.setDrawColormap({ R:[0,255], G:[0,45], B:[0,82], A:[0,255], I:[0,1] });
        nv.drawRimOpacity = outlineOpacity > 0 ? outlineOpacity : -1;
        nv.setDrawOpacity(Math.max(labelVisible ? overlayOpacity : 0, outlineOpacity > 0 ? .001 : 0));
        nv.refreshDrawing(true);
        scheduleReferenceDrawingRefresh();
        changed();
        scheduleRegionAnalysis(0);
        setFeedback(`Đã tạo bản nháp từ probability map với ngưỡng ${aiThreshold.toFixed(2)} và tách thành các ổ 3D.`);
        return;
      }
      if (inferenceJob.archived) {
        const response = await fetchWithRetry(inferenceJob.artifacts.mask);
        if (!response.ok) throw Error("Không tải được mặt nạ AI gốc");
        const blob = await response.blob();
        const originalMask = await NVImage.loadFromFile({file:new File([blob], "ai-original.nii.gz"), name:"AI gốc"});
        const nv = niivueRef.current;
        checkpoint();
        nv.loadDrawing(originalMask);
        nv.setDrawColormap({ R:[0,255], G:[0,45], B:[0,82], A:[0,255], I:[0,1] });
        nv.drawRimOpacity = outlineOpacity > 0 ? outlineOpacity : -1;
        nv.setDrawOpacity(Math.max(labelVisible ? overlayOpacity : 0, outlineOpacity > 0 ? .001 : 0));
        nv.refreshDrawing(true);
        scheduleReferenceDrawingRefresh();
        changed();
        scheduleRegionAnalysis(0);
        setFeedback("Đã đưa mặt nạ AI gốc vào bản nháp. Nhãn đã duyệt trước đó vẫn được giữ.");
        return;
      }
      const rev = await seedAnnotationFromJob(selectedCase.id, inferenceJob.id, selectedCase.current_revision, reviewerAuthRef.current);
      const updatedCase = await getAnnotationCase(selectedCase.id);
      setSelectedCase(updatedCase);
      await loadCaseIntoViewer(updatedCase, rev.revision_number);
      setFeedback("Đã nhập kết quả suy luận AI vào bản vẽ thành công!");
    } catch (seedErr) {
      loadingRef.current = false;
      setEditorLoading(false);
      setError(`Không thể nhập kết quả AI: ${seedErr.message}`);
    } finally {
      loadingRef.current = false;
      setEditorLoading(false);
    }
  }

  // Create Case Handler
  async function handleCreateCaseSubmit(e) {
    e.preventDefault();
    setError("");
    try {
      let payload;
      if (createMode === "file") {
        if (!uploadFile) {
          setError("Vui lòng chọn file NIfTI (.nii / .nii.gz)");
          return;
        }
        payload = await createAnnotationCase({ file: uploadFile, name: caseNameInput });
      } else if (createMode === "job") {
        if (!selectedJobForCreate) {
          setError("Vui lòng chọn một tác vụ từ danh sách");
          return;
        }
        payload = await createAnnotationCase({ jobId: selectedJobForCreate.id, name: caseNameInput });
      } else {
        if (!selectedPacsForCreate) {
          setError("Vui lòng chọn một ca từ PACS");
          return;
        }
        payload = await createAnnotationCase({ studyId: selectedPacsForCreate.orthanc_id, name: caseNameInput });
      }

      if (payload.reused && !window.confirm(`Dữ liệu này đã có trong thư viện. Mở ca “${payload.name}” (${payload.id}), phiên bản ${payload.current_revision}? Nhãn đã lưu sẽ được giữ nguyên.`)) return;
      setShowCreateModal(false);
      setUploadFile(null);
      setCaseNameInput("");
      setSelectedPacsForCreate(null);
      setSelectedJobForCreate(null);
      refreshCases();
      handleSelectCase(payload);
    } catch (createErr) {
      setError(`Tạo ca thất bại: ${createErr.message}`);
    }
  }

  const blocked = !selectedCase || editorLoading;
  const visibleLabelCases = cases.filter(c => !/^AUDIT_/i.test(c.name || ""));
  const filteredCases = visibleLabelCases.filter(c => c.name.toLowerCase().includes(caseSearch.toLowerCase()) && (caseFilter === "all" || (caseFilter === "pending" ? c.status !== "approved" : caseFilter === "approved" ? hasApprovedLabel(c) : caseFilter === "new" ? c.current_revision === 0 : c.current_revision > 0 && c.status === caseFilter)));
  const caseCounts = {
    all: visibleLabelCases.length,
    pending: visibleLabelCases.filter(c => c.status !== "approved").length,
    new: visibleLabelCases.filter(c => c.current_revision === 0).length,
    draft: visibleLabelCases.filter(c => c.current_revision > 0 && c.status === "draft").length,
    approved: visibleLabelCases.filter(hasApprovedLabel).length,
  };
  const displayedRevision = revisions.find(r => r.revision_number === displayedRevisionNum);
  const toolList = [["pan","pan","Di chuyển","H"],["brush","brush","Bút","B"],["fill","polygon","Đường bao","P"],["eraser","eraser","Tẩy","E"]];
  const selectedRegion = regions.find(region => region.key === selectedRegionKey);
  const selectedRegions = regions.filter(region => selectedRegionKeys.has(region.key));
  const selectedRegionCount = selectedRegions.length;
  const selectedRegionIndex = Math.max(0, regions.findIndex(region => region.key === selectedRegionKey));
  const regionWindowStart = Math.max(0, Math.min(regions.length - 4, selectedRegionIndex - 1));
  const visibleRegions = regions.slice(regionWindowStart, regionWindowStart + 4);
  const reviewedRegionCount = regions.filter(region => reviewedRegionKeys.has(region.key)).length;
  const unreviewedRegionCount = regions.length - reviewedRegionCount;
  const regionReviewComplete = !regionsBusy && unreviewedRegionCount === 0;
  const editIdentityReady = Boolean(reviewerIdentity && reviewerAuthRef.current);
  return (
    <div className={`annotation-layout label-editor ${sam2Preview?"sam2-reviewing":""}`}>
      {recoverableDraft && <section className="draft-recovery-banner" role="status" data-testid="draft-recovery">
        <strong>Có bản nháp chưa đồng bộ trên thiết bị này.</strong>
        <span>Dựa trên phiên bản {recoverableDraft.baseRevision}; máy chủ hiện ở phiên bản {selectedCase?.current_revision}.</span>
        <button disabled={editorLoading || recoverableDraft.expectedRevision!==selectedCase?.current_revision} onClick={restoreWorkingDraft}>Khôi phục nháp</button>
        <button disabled={editorLoading} onClick={downloadRecoveredDraft}>Tải nháp để đối chiếu</button>
        <button onClick={()=>{removeDraft(recoverableDraft.key).then(()=>setRecoverableDraft(null)).catch(()=>setError("Không xóa được nháp trên thiết bị."));}}>Bỏ nháp cục bộ</button>
      </section>}

      {caseDrawer && <><button className="drawer-shade" aria-label="Đóng danh sách ca" onClick={()=>setCaseDrawer(false)} /><aside className="annotation-sidebar case-drawer">
        <div className="sidebar-header"><span className="dataset-eyebrow">GÁN NHÃN CHUYÊN GIA</span><h2>Danh sách ca <button onClick={()=>setCaseDrawer(false)} aria-label="Đóng danh sách">×</button></h2>
          <div className="editor-search"><input aria-label="Tìm ca" placeholder="Tìm theo tên ca…" value={caseSearch} onChange={e=>setCaseSearch(e.target.value)} /><select aria-label="Lọc ca" value={caseFilter} onChange={e=>setCaseFilter(e.target.value)}><option value="pending">Cần rà soát ({caseCounts.pending})</option><option value="all">Tất cả ({caseCounts.all})</option><option value="new">Chưa đánh giá ({caseCounts.new})</option><option value="draft">Bản nháp ({caseCounts.draft})</option><option value="approved">Đã duyệt ({caseCounts.approved})</option></select></div>
          <button className="create-case-btn" disabled={saving} onClick={handleOpenCreateModal}>+ Thêm ca</button>
        </div>
        <div className="dataset-counts"><span><b>{caseCounts.all}</b> ca</span><span><b>{caseCounts.draft}</b> bản nháp</span><span><b>{caseCounts.approved}</b> đã duyệt</span></div>
        <div className="case-scroll-list" aria-label="Danh sách ca CT">{filteredCases.map(c=><button key={c.id} disabled={saving || editorLoading} className={`case-card ${selectedCase?.id===c.id?"active":""}`} onClick={()=>handleSelectCase(c)}>
          <span className="case-card-copy"><strong>{displayName(c.name)}</strong><span className="case-card-identity">{c.patient_id || "Không mã BN"} · {c.geometry?.shape?.[2] ? `${c.geometry.shape[2]} lát` : formatStudyDate(c.study_date)}</span><small className={`case-state ${c.current_revision===0?"new":c.status}`}>{c.current_revision===0?"Chưa đánh giá":c.status==="approved"?"Đã duyệt":`Bản nháp v${c.current_revision}`}</small></span>
        </button>)}{!filteredCases.length&&<p>{loadingCases?"Đang tải danh sách ca…":"Không có ca phù hợp."}</p>}</div>
        <div className="sidebar-export-bar">{account.permissions?.includes("dataset.manage") && cases.some(c=>c.latest_approved_revision!=null)?<a className="export-dataset-btn" href={exportDatasetUrl()}>Xuất nhãn đã duyệt</a>:<small>{cases.some(hasApprovedLabel) ? "Xuất bộ nhãn đã duyệt cần quyền quản lý dữ liệu." : "Chưa có nhãn được duyệt để xuất."}</small>}</div>
      </aside></>}
      <main className="annotation-main">
        <header className="editor-topbar">
          <button type="button" onClick={onSwitchToWorkstation} title="Quay về bảng dữ liệu"><Icon name="database" size={17}/> Dữ liệu</button>
          <button onClick={()=>setCaseDrawer(true)} title="Mở bộ dữ liệu" aria-expanded={caseDrawer}><Icon name="menu" size={17}/> Bộ dữ liệu</button>
          <button disabled={blocked} onClick={()=>nextCase(-1)} aria-label="Ca trước">‹</button>
          <div className="editor-case-title"><strong>{selectedCase?.name || "Chọn ca để bắt đầu"}</strong><small>{selectedCase ? `BN: ${selectedCase.patient_id || "Không có mã BN"} · ${formatStudyDate(selectedCase.study_date)} · ${caseSourceLabel(selectedCase)} · Ca ${cases.findIndex(c=>c.id===selectedCase.id)+1}/${cases.length}` : "Gán nhãn nghiên cứu"}</small></div>
          <button disabled={blocked} onClick={()=>nextCase(1)} aria-label="Ca tiếp">›</button>
          <span className="editor-save-status" role="status" title={localDraftNotice}>{saving?"Đang lưu…":saveFailed?"Lưu thất bại":dirty?"Chờ tự lưu…":displayedRevisionNum===0?"Chưa đánh giá":`Đã lưu v${displayedRevisionNum}`}</span>
          {saveFailed&&(saveConflict?<div className="conflict-rescue" role="group" aria-label="Xử lý xung đột revision"><button disabled={blocked} onClick={downloadCurrentMask}>Tải mask local</button><button disabled={blocked} onClick={reloadLatestAfterConflict}>Nạp revision mới</button></div>:<button disabled={blocked} onClick={()=>handleSaveRevision("draft")}>Thử lưu lại</button>)}
          <button className={`editor-inspector-toggle ${inspectorOpen?"active":""}`} onClick={()=>setInspectorOpen(open=>!open)} title={inspectorOpen?"Ẩn bảng duyệt":"Mở bảng duyệt"} aria-expanded={inspectorOpen}><Icon name="panel" size={16}/><span>Duyệt vùng</span></button>
          <span className="editor-session-identity" title="Mọi thay đổi được gắn với phiên BrainHem hiện tại"><Icon name="user" size={16}/>{reviewerIdentity}</span>
          <button className="editor-primary" title={propagatePreview?"Cần xác nhận hoặc bỏ contour preview trước":!regionReviewComplete?`Còn ${unreviewedRegionCount || "một số"} vùng chưa kiểm tra`:"Hoàn tất ca"} disabled={!canApprove || blocked || saving || polygon.length>0 || !!propagatePreview || !regionReviewComplete} onClick={()=>{setConfirmEntireVolume(false);setShowFinish(true);}}>Hoàn tất…</button>
        </header>
        <div className="editor-toolbar">          <nav className="editor-tools" aria-label="Công cụ gán nhãn">{toolList.map(([id,icon,label,key])=>{const needsIdentity=["brush","eraser","fill"].includes(id);return <button key={id} disabled={blocked || !!propagatePreview || (polygon.length>0 && id!=="fill") || (id==="fill"&&viewMode!=="axial") || (viewMode==="render"&&["brush","eraser"].includes(id))} className={`${activeTool===id?"active":""} ${needsIdentity&&!editIdentityReady?"requires-login":""}`} title={propagatePreview?"Xử lý contour preview trong bảng Duyệt vùng":!editIdentityReady&&needsIdentity?`Đăng nhập để dùng ${label}`:viewMode==="render"&&["brush","eraser","fill"].includes(id)?"Chọn mặt cắt 2D để chỉnh nhãn":id==="fill"&&viewMode!=="axial"?"Đường bao dùng trên mặt cắt Axial":`${label} (${key})`} aria-label={!editIdentityReady&&needsIdentity?`${label} · cần đăng nhập`:label} onClick={()=>{if(!needsIdentity||requireEditorIdentity(id))setActiveTool(id==="pan"&&activeTool==="pan"?"pointer":id);}}><Icon name={icon} size={19}/><span>{label}</span></button>})}<label className={`auto-connect-toggle toolbar-auto-connect ${autoConnectBrush?"active":""}`} title="Khi nét bút khép kín, tự nối điểm đầu-cuối và tô đầy phần bên trong"><input type="checkbox" disabled={blocked} checked={autoConnectBrush} onChange={event=>setAutoConnectBrush(event.target.checked)}/><span>Tô vòng kín</span></label>
            <hr /><button disabled={blocked||polygon.length>0} onClick={()=>zoomView(1.2)} aria-label="Phóng to" title="Phóng to"><Icon name="zoom" size={19}/></button><button disabled={blocked||polygon.length>0} onClick={()=>zoomView(1/1.2)} aria-label="Thu nhỏ" title="Thu nhỏ"><Icon name="zoomOut" size={19}/></button><div className="label-main-views" aria-label="Mặt cắt chính">{LABEL_VIEWS.map(item=><button key={item.id} disabled={blocked||polygon.length>0} className={viewMode===item.id?"active":""} onClick={()=>changeLabelView(item.id)} title={`Dùng ${item.label} làm mặt cắt chính`}>{item.label}</button>)}</div><button disabled={!selectedCase} className={referenceDockOpen?"active":""} onClick={()=>setReferenceDockOpen(open=>!open)} title={referenceDockOpen?"Ẩn dải ảnh phụ":"Hiện dải ảnh phụ"}><Icon name="layout" size={18}/><span>Ảnh phụ</span></button><hr /><button disabled={blocked || !undoRef.current.length || polygon.length>0} onClick={()=>handleUndo()} title="Hoàn tác (Ctrl/⌘ Z)" aria-label="Hoàn tác"><Icon name="undo" size={19}/></button><button disabled={blocked || !redoRef.current.length || polygon.length>0} onClick={()=>handleUndo(true)} title="Làm lại (Ctrl/⌘ Shift Z)" aria-label="Làm lại"><Icon name="redo" size={19}/></button>
          </nav></div>
        <div className="editor-context"><strong>{toolList.find(t=>t[0]===activeTool)?.[2]}</strong>              {["brush","eraser"].includes(activeTool)&&<label className="tool-size">Cỡ bút: {brushSize} px<input aria-label="Cỡ bút" type="range" min="1" max="20" value={brushSize} onChange={e=>setBrushSize(Number(e.target.value))}/></label>}
              {activeTool==="fill"&&<div className="polygon-actions"><span>Đặt điểm · Enter khép kín · Kéo đỉnh để chỉnh</span>{polygonClosed?<button onClick={applyPolygon}>Áp dụng đường bao</button>:<button disabled={polygon.length<3} onClick={()=>setPolygonClosed(true)}>Khép kín</button>}<button disabled={!polygon.length} onClick={()=>{setPolygon([]);setPolygonClosed(false);}}>Bỏ đường bao</button></div>}
{!["brush","eraser","fill"].includes(activeTool)&&<span>{activeTool==="pan"?"Kéo chuột để di chuyển ảnh":"←/→ đổi lát · Ctrl + ←/→ đổi ca · Ctrl + cuộn đổi lát · Giữ Space xem ảnh gốc"}</span>}</div>
        {(inferenceJob || inferenceDisconnected) && <div className="ai-status-strip" role="status" aria-live="polite" data-testid="ai-status-strip">
          {inferenceDisconnected ? "Đang kết nối lại máy chủ. Yêu cầu AI vẫn được giữ; chưa có trạng thái mới nhất." : jobMessage(inferenceJob)}
        </div>}
        <div className="editor-body">

          <div className="editor-canvas">
            {(error||feedback)&&<div className={`editor-floating-message ${error?"error":""}`} role="status">{error||feedback}{error&&<button onClick={()=>setError("")}>×</button>}</div>}
            <div className={`label-viewer-layout ${selectedCase?"has-case":""} ${referenceDockOpen?"":"references-collapsed"}`} style={{"--label-reference-width":`${referenceWidth}px`}}>
            <aside className="label-reference-views" aria-label="Các mặt cắt phụ">
              <button className="label-reference-resize-handle" type="button" aria-label="Kéo để đổi chiều rộng dải ảnh phụ" onPointerDown={beginLabelReferenceResize} onPointerMove={moveLabelReferenceResize} onPointerUp={endLabelReferenceResize} onPointerCancel={endLabelReferenceResize}/>
              <div className="label-reference-picker">
                <button className={referencePickerOpen?"active":""} onClick={()=>setReferencePickerOpen(open=>!open)} aria-expanded={referencePickerOpen} title="Chọn mặt cắt phụ"><Icon name="layout" size={14}/><span>Mặt phụ</span></button>
                {referencePickerOpen&&<div className="label-reference-menu">{LABEL_VIEWS.map(item=><label key={item.id}><input type="checkbox" checked={enabledReferenceViews.has(item.id)} disabled={item.id===viewMode} onChange={event=>setEnabledReferenceViews(current=>{const next=new Set(current);if(event.target.checked)next.add(item.id);else next.delete(item.id);return next;})}/>{item.label}{item.id===viewMode&&<small>ảnh chính</small>}</label>)}</div>}
              </div>
              {LABEL_VIEWS.map(item=><div key={item.id} ref={node=>{referenceCardRefs.current[item.id]=node;}} className={`label-reference-view ${item.id===viewMode?"current":""} ${!enabledReferenceViews.has(item.id)?"disabled":""}`} role="button" tabIndex={0} onDoubleClick={()=>changeLabelView(item.id)} onKeyDown={event=>{if(event.key==="Enter")changeLabelView(item.id);}} onContextMenu={event=>{event.preventDefault();setReferenceMenu({item,x:event.clientX,y:event.clientY});}} title={`Nhấp đúp để đưa ${item.label} thành ảnh chính`}><canvas ref={node=>{referenceCanvasRefs.current[item.id]=node;}} onWheelCapture={event=>zoomLabelReference(item,event)} onContextMenu={event=>event.preventDefault()}/><span>{item.label}<small>Nhấp đúp để phóng lớn</small></span><button className="label-reference-fullscreen" type="button" aria-label={`Toàn màn hình ${item.label}`} title="Toàn màn hình" onClick={event=>{event.stopPropagation();fullscreenLabelReference(item);}}>⛶</button></div>)}
              <small className="label-reference-help">Cuộn zoom · Chuột phải tùy chọn</small>
            </aside>
            {referenceMenu&&<div className="label-reference-context-menu" role="menu" style={{left:referenceMenu.x,top:referenceMenu.y}} onPointerDown={event=>event.stopPropagation()}><strong>{referenceMenu.item.label}</strong><button type="button" onClick={()=>{changeLabelView(referenceMenu.item.id);setReferenceMenu(null);}}>Đưa lên ảnh chính</button><button type="button" onClick={()=>{fullscreenLabelReference(referenceMenu.item);setReferenceMenu(null);}}>Mở toàn màn hình</button><button type="button" onClick={()=>{resetLabelReference(referenceMenu.item);setReferenceMenu(null);}}>Đặt lại zoom/góc nhìn</button><button className="danger" type="button" onClick={()=>hideLabelReference(referenceMenu.item)}>Ẩn view này</button></div>}
            <section className="annotation-viewport">
              {!selectedCase&&<div className="editor-empty"><span className="empty-scan-icon"><Icon name="scan" size={40}/></span><h2>Không gian gán nhãn chuyên gia</h2><p>Chọn ca CT, vẽ vùng xuất huyết hoặc chỉnh gợi ý AI.<br/>Bản nháp được lưu tự động; phê duyệt sau khi kiểm tra toàn bộ ca.</p><button onClick={()=>setCaseDrawer(true)}>Chọn ca từ bộ dữ liệu <Icon name="chevron" size={16}/></button><div className="label-workflow"><span>01 · Chọn ca</span><span>02 · Gán nhãn</span><span>03 · Kiểm tra & duyệt</span></div></div>}
              <div className={`canvas-container tool-${activeTool} ${!selectedCase?"hidden":""}`} onClick={selectRegionAtCrosshair} onDoubleClick={event=>{if(event.target===canvasRef.current)toggleLabelCrosshairLock(event);}} onContextMenu={openMainContextMenu} title={['pointer','pan'].includes(activeTool)?"Nhấp đúp để ghim · Chuột phải: component":undefined}
                onPointerMoveCapture={followLabelCrosshair}
                onPointerDownCapture={beginBrushStroke}
                onPointerUp={scheduleEndBrushStroke}
                onPointerCancel={scheduleEndBrushStroke}
                onPointerMove={updateBrushPreview}
                onPointerLeave={()=>{if(brushPreviewRef.current)brushPreviewRef.current.style.display="none";}}>
                <canvas ref={canvasRef} onPointerUpCapture={selectRegionOnShiftPointerUp}/>
                {selectedCase&&<>
                  <div className="label-diagnostic-meta label-diagnostic-patient"><strong>Bệnh nhân: {displayName(selectedCase.patient_name||selectedCase.name)}</strong><span>Mã BN: {selectedCase.patient_id||"Không có mã BN"}</span><span>Ngày chụp: {formatStudyDate(selectedCase.study_date)}{selectedCase.accession_number?` · Acc: ${selectedCase.accession_number}`:""}</span><span>{caseSourceLabel(selectedCase)} · {selectedCase.study_description||"Non-contrast CT"}</span><span>Case ID: {selectedCase.id}</span><span>Image: {currentSlice+1} / {totalSlices}</span></div>
                  <div className="label-diagnostic-meta label-diagnostic-mode"><strong>Nhãn chuyên gia</strong><span>Revision {selectedCase.current_revision||0}</span>{Number.isFinite(Number(selectedCase.geometry?.zooms?.[2]))&&<span>Slice: {Number(selectedCase.geometry.zooms[2]).toFixed(1)} mm</span>}<span>{selectedCase.geometry?.shape?.[0]||512} × {selectedCase.geometry?.shape?.[1]||512}</span></div>
                  {!['mpr','render'].includes(viewMode)&&<><span className="label-orientation label-orientation-left">{viewMode==='sagittal'?'A':'R'}</span><span className="label-orientation label-orientation-right">{viewMode==='sagittal'?'P':'L'}</span></>}
                  <div className="label-diagnostic-view"><strong>{LABEL_VIEWS.find(item=>item.id===viewMode)?.label||'Axial'}</strong>{selectedCase.geometry?.shape?.[0]&&selectedCase.geometry?.zooms?.[0]&&<span>FOV: {Math.round(selectedCase.geometry.shape[0]*selectedCase.geometry.zooms[0])} mm</span>}</div>
                </>}
                {!!regions.length&&!regionsBusy&&!sam2Preview&&<div className="label-component-navigator" aria-label="Các component nhãn 3D" onClick={event=>event.stopPropagation()}>
                  <button type="button" disabled={regions.length<2} onClick={()=>selectRegion(regions[(selectedRegionIndex-1+regions.length)%regions.length])} aria-label="Ổ trước">‹</button>
                  <strong>{selectedRegion?`${componentId(selectedRegion)} · ${selectedRegionIndex+1}/${regions.length}`:`${regions.length} ổ`}</strong>
                  {selectedRegion?<button className="component-go" type="button" onClick={()=>selectRegion(selectedRegion,true)}>Đến ổ</button>:<span className="component-go-spacer"/>}
                  <button type="button" disabled={regions.length<2} onClick={()=>selectRegion(regions[(selectedRegionIndex+1)%regions.length])} aria-label="Ổ sau">›</button>
                  <div>{visibleRegions.map(region=><button type="button" key={region.key} className={`${region.key===selectedRegionKey?"active":""} ${selectedRegionKeys.has(region.key)?"multi-selected":""}`} onClick={event=>selectRegion(region,null,event.shiftKey)} onDoubleClick={()=>selectRegion(region,true)} title={`${componentId(region)} · ${region.volumeMl?.toLocaleString("vi-VN",{maximumFractionDigits:2})||"—"} mL · ${componentSliceText(region)} · Shift+click để thêm/bỏ khỏi nhóm chọn`}><b>{componentId(region)}</b><span>{region.volumeMl?.toLocaleString("vi-VN",{maximumFractionDigits:2})||"—"} mL</span><small>{componentSliceText(region)}</small></button>)}</div>
                </div>}
                {crosshairLocked&&<div className="label-crosshair-lock">● Điểm đã ghim · Nhấp đúp để bỏ ghim</div>}
                {!blocked&&["brush","eraser"].includes(activeTool)&&<span ref={brushPreviewRef} className="brush-preview" style={{display:"none",left:0,top:0}}/>}
                {activeTool==="fill"&&!blocked&&<svg className="polygon-editor" onPointerDown={e=>{if(e.target.tagName==="circle")return;const point=pointFromEvent(e);if(point&&!polygonClosed)setPolygon(v=>[...v,point]);}} onPointerMove={e=>{if(polygonDragRef.current===null)return;const p=pointFromEvent(e);if(p&&p.z===polygon[0]?.z)setPolygon(v=>v.map((old,i)=>i===polygonDragRef.current?p:old));}} onPointerUp={()=>{polygonDragRef.current=null;}} onPointerCancel={()=>{polygonDragRef.current=null;}} onDoubleClick={()=>{if(polygon.length>=3)setPolygonClosed(true);}}>
                  {polygon.length>0&&<polyline points={polygon.map(p=>`${p.x},${p.y}`).join(" ")+(polygonClosed?` ${polygon[0].x},${polygon[0].y}`:"")} fill={polygonClosed?"#fbbf2430":"none"} stroke="#fbbf24" strokeWidth="2" pointerEvents="none"/>}
                  {polygon.map((p,i)=><circle key={i} cx={p.x} cy={p.y} r="5" fill="#fbbf24" onPointerDown={e=>{e.stopPropagation();if(i===0&&polygon.length>=3&&!polygonClosed){setPolygonClosed(true);return;}polygonDragRef.current=i;e.currentTarget.setPointerCapture(e.pointerId);}}/>)}
                </svg>}
                {editorLoading&&<div className="viewport-overlay-loading"><span>Đang mở CT…</span></div>}
              </div>
              {sam2Menu&&<div className="label-reference-context-menu sam2-context-menu" role="menu" aria-label="Thao tác component" style={{left:sam2Menu.x,top:sam2Menu.y}} onPointerDown={event=>event.stopPropagation()}>
                <header className="component-menu-head">
                  <span className="component-menu-mark"><Icon name="cube" size={18}/></span>
                  <div><small>Vùng đang chọn</small><strong>{selectedRegionCount>1?`${selectedRegionCount} component`:selectedRegion?`Component ${componentId(selectedRegion)}`:"Chưa chọn component"}</strong><p>{selectedRegionCount>1?selectedRegions.map(componentId).join(" · "):selectedRegion?`${selectedRegion.volumeMl?.toLocaleString("vi-VN",{maximumFractionDigits:2})||"—"} mL · ${componentSliceText(selectedRegion)}`:"Nhấp vào vùng nhãn để chọn"}</p></div>
                  <button className="component-menu-close" type="button" aria-label="Đóng menu" onClick={()=>setSam2Menu(null)}>×</button>
                </header>
                <div className="component-menu-selection-hint"><kbd>Shift</kbd><span>Nhấp để thêm hoặc bỏ component khỏi nhóm chọn</span></div>
                <div className="component-menu-actions">
                  <button type="button" disabled={regionsBusy||!selectedRegionCount} onClick={spotlightSelectedRegion}><span className="component-action-icon"><Icon name="zoom" size={16}/></span><span><b>Focus</b><small>Phóng gần vùng chọn</small></span><kbd>Esc</kbd></button>
                  <button className="danger" type="button" disabled={blocked||regionsBusy||!selectedRegionCount} onClick={removeSelectedRegions}><span className="component-action-icon"><Icon name="close" size={16}/></span><span><b>{selectedRegionCount>1?`Xóa ${selectedRegionCount} vùng`:"Xóa vùng"}</b><small>Hoàn tác được</small></span></button>
                </div>
                {selectedRegion&&<section className="component-menu-display"><div className="component-menu-section-title"><span>Hiển thị vùng chọn</span><button type="button" onClick={resetSelectedRegionStyles}>Dùng mặc định</button></div><div className="component-style-grid"><label className="component-style-control"><span><i className="component-fill-dot"/>Alpha</span><output>{Math.round((componentStyles[selectedRegion.key]?.fill??overlayOpacity)*100)}%</output><input aria-label="Alpha component" type="range" min="0" max="1" step="0.01" value={componentStyles[selectedRegion.key]?.fill??overlayOpacity} onChange={e=>setRegionStyle("fill",e.target.value)}/></label><label className="component-style-control"><span><i className="component-rim-dot"/>Biên</span><output>{Math.round((componentStyles[selectedRegion.key]?.rim??outlineOpacity)*100)}%</output><input aria-label="Đường biên component" type="range" min="0" max="1" step="0.01" value={componentStyles[selectedRegion.key]?.rim??outlineOpacity} onChange={e=>setRegionStyle("rim",e.target.value)}/></label></div><small className="component-style-note">Chỉ áp dụng cho {selectedRegionCount>1?`${selectedRegionCount} vùng đang chọn`:componentId(selectedRegion)}.</small></section>}
                <section className="component-menu-ai"><div className="component-menu-ai-status"><span className={capabilities?.medsam2_available?"ready":"offline"}/><div><b>MedSAM 2</b><small>{capabilities?.medsam2_available?"CUDA sẵn sàng":"Chưa sẵn sàng trên máy chủ"}</small></div></div><button type="button" disabled={sam2Busy||regionsBusy||selectedRegionCount!==1||viewMode!=="axial"||capabilities?.medsam2_available===false} onClick={requestSam2Propagation}><Icon name="spark" size={15}/>{sam2Busy?"Đang xử lý…":"Predict with MedSAM 2"}</button>{selectedRegionCount>1&&<small>Chỉ chạy với một component mỗi lần.</small>}{viewMode!=="axial"&&<small>Chuyển sang Axial để chạy.</small>}</section>
                {!selectedRegionCount&&<small className="component-menu-empty">Chọn một vùng C1/C2… trước.</small>}
              </div>}
              {focusedRegionKey&&<button type="button" className="component-focus-exit" onClick={exitComponentFocus}>Thoát focus · Esc</button>}
              {sam2Preview&&<aside className="sam2-review-popover" role="dialog" aria-labelledby="sam2-review-title" onPointerDown={event=>event.stopPropagation()}>
                <header><span className="sam2-preview-swatch"/><div><strong id="sam2-review-title">Preview SAM2 · {componentId({number:sam2Preview.componentNumber})}</strong><small>Chưa nhập vào nhãn</small></div></header>
                <p><b>{sam2Preview.indices.length.toLocaleString("vi-VN")} voxel mới</b> · {sam2Preview.slices.length} lát prediction</p>
                <p>Seed gốc: lát {sam2Preview.componentSliceStart+1}–{sam2Preview.componentSliceEnd+1}. Màu cyan là kết quả tạm.</p>
                <div className="sam2-slice-review"><button type="button" onClick={()=>moveSam2PreviewSlice(-1)}>‹ Preview trước</button><span>Lát {currentSlice+1}/{totalSlices}</span><button type="button" onClick={()=>moveSam2PreviewSlice(1)}>Preview sau ›</button></div>
                <small>←/→ đi từng lát · hai nút trên nhảy giữa các lát có prediction.</small>
                <div className="sam2-review-actions"><button className="reject" type="button" onClick={rejectSam2Preview}>Bỏ prediction</button><button className="accept" type="button" onClick={acceptSam2Preview}>Duyệt và giữ</button></div>
              </aside>}
            </section>
            </div>
          </div>
          <aside className={`editor-inspector ${inspectorOpen?"open":"closed"}`}>
            <div className="editor-inspector-head"><div><strong>Kiểm tra nhãn</strong><small>Vùng 3D · nhãn · gợi ý AI</small></div><button type="button" onClick={()=>setInspectorOpen(false)} aria-label="Đóng bảng kiểm tra nhãn" title="Đóng bảng kiểm tra nhãn"><Icon name="close" size={15}/></button></div>
            <section className="inspector-section region-review-section">
              <h3>Duyệt ổ xuất huyết 3D <span className={`region-review-count ${regionReviewComplete?"complete":""}`}>{reviewedRegionCount}/{regions.length}</span></h3>
              <div className="region-progress" aria-label={`Đã kiểm tra ${reviewedRegionCount} trên ${regions.length} vùng`}><span style={{width:regions.length?`${reviewedRegionCount/regions.length*100}%`:"100%"}} /></div>
              {!!regions.length&&<label className="region-selector"><span>Chọn nhanh ổ</span><select disabled={!!propagatePreview} value={selectedRegionKey||""} onChange={event=>selectRegion(regions.find(region=>region.key===event.target.value))}>{regions.map(region=><option key={region.key} value={region.key}>{componentId(region)} · {region.volumeMl?`${region.volumeMl.toLocaleString("vi-VN",{maximumFractionDigits:2})} mL`:`${region.voxelCount.toLocaleString("vi-VN")} voxel`} · lát {region.sliceStart+1}–{region.sliceEnd+1}</option>)}</select></label>}
              {regionsBusy ? <p className="region-state">Đang cập nhật các vùng 3D…</p> : !regions.length ? <div className="region-empty"><strong>Mask chưa có vùng xuất huyết</strong><small>Rà toàn bộ CT. Nếu là ca dương tính, bắt đầu từ gợi ý AI hoặc dùng bút để tạo vùng mới.</small>{inferenceJob?.status==="succeeded"?<button className="region-ai-start" disabled={blocked||polygon.length>0} onClick={handleImportAiMask}><Icon name="spark" size={14}/> Bắt đầu từ gợi ý AI</button>:capabilities?.tiers?.[selectedTier]?.command_configured?<button className="region-ai-start" disabled={blocked||inferenceBusy} onClick={handleRequestInference}><Icon name="spark" size={14}/>{inferenceBusy?"AI đang phân tích…":"Tạo gợi ý AI"}</button>:null}</div> : selectedRegion ? <>
                <div className="active-region-card">
                  <div><strong><span className="component-id">{componentId(selectedRegion)}</span> Ổ 3D đang chọn</strong>{reviewedRegionKeys.has(selectedRegion.key)&&<span className="region-reviewed"><Icon name="check" size={12}/> Đã kiểm tra</span>}</div>
                  <dl><div><dt>Thể tích</dt><dd>{selectedRegion.volumeMl ? `${selectedRegion.volumeMl.toLocaleString("vi-VN",{maximumFractionDigits:2})} mL` : `${selectedRegion.voxelCount.toLocaleString("vi-VN")} voxel`}</dd></div><div><dt>Phạm vi Axial</dt><dd>{componentSliceText(selectedRegion)}</dd></div><div><dt>Tâm voxel</dt><dd>{componentCenterText(selectedRegion)}</dd></div><div><dt>Kích thước</dt><dd>{selectedRegion.voxelCount.toLocaleString("vi-VN")} voxel</dd></div></dl>
                </div>
                <div className="region-stepper"><button disabled={regions.length<2} onClick={()=>{const index=regions.findIndex(item=>item.key===selectedRegion.key);selectRegion(regions[(index-1+regions.length)%regions.length]);}}>‹ Trước</button><strong>{componentId(selectedRegion)} · {regions.findIndex(item=>item.key===selectedRegion.key)+1}/{regions.length}</strong><button disabled={regions.length<2} onClick={()=>{const index=regions.findIndex(item=>item.key===selectedRegion.key);selectRegion(regions[(index+1)%regions.length]);}}>Sau ›</button></div>
                <button className="region-focus" disabled={!!propagatePreview} onClick={()=>focusRegionInViewer(selectedRegion)}>Đến tâm ổ trên ảnh</button>
                {propagatePreview ? <div className="propagate-panel">
                  <div className="propagate-heading"><span className="propagate-swatch"/><div><strong>Contour sao chép · chưa xác nhận</strong><small>{componentId({number:propagatePreview.regionNumber})} · lát {propagatePreview.sourceSlice+1} → {propagatePreview.targetSlice+1}</small></div></div>
                  <div className="propagate-shape"><button onClick={()=>reshapePropagation("shrink")}>− Thu nhỏ 1 voxel</button><button onClick={()=>reshapePropagation("grow")}>+ Mở rộng 1 voxel</button></div>
                  <div className="propagate-move"><span>Dịch · 1 voxel/lần</span><button onClick={()=>movePropagation(-1,0)}>←</button><button onClick={()=>movePropagation(0,-1)}>↑</button><button onClick={()=>movePropagation(0,1)}>↓</button><button onClick={()=>movePropagation(1,0)}>→</button></div>
                  <div className="propagate-edit"><button onClick={()=>finishPropagation({edit:true})}>Chấp nhận lát này & chỉnh biên</button><button onClick={endPropagation}>Dừng · bỏ preview</button></div>
                  <button className="propagate-accept" onClick={()=>finishPropagation({continueNext:true})}>✓ Chấp nhận lát này & tạo preview lát sau</button>
                  <small>Màu xanh chỉ là preview. Preview bị loại khỏi mask nếu chưa chấp nhận.</small>
                </div> : <button className="propagate-start" disabled={viewMode==="render"||selectedRegion.sliceEnd>=((niivueRef.current?.volumes?.[0]?.dimsRAS?.[3]||1)-1)} onClick={beginPropagation}>Sao chép contour sang lát kế →</button>}
                <div className="region-move-control">
                  <div className="region-move-heading"><strong>Dịch toàn bộ ổ 3D</strong><label>Bước <select value={regionMoveStep} onChange={event=>setRegionMoveStep(Number(event.target.value))}><option value="1">1 voxel</option><option value="3">3 voxel</option><option value="5">5 voxel</option></select></label></div>
                  <div className="region-move-grid" aria-label="Dịch chuyển ổ đã chọn">
                    <i />
                    <button disabled={!!propagatePreview} title="Dịch lên trên ảnh" onClick={()=>moveSelectedRegion(0,-1,0)}>↑</button>
                    <i />
                    <button disabled={!!propagatePreview} title="Dịch sang trái ảnh" onClick={()=>moveSelectedRegion(-1,0,0)}>←</button>
                    <span>XY</span>
                    <button disabled={!!propagatePreview} title="Dịch sang phải ảnh" onClick={()=>moveSelectedRegion(1,0,0)}>→</button>
                    <i />
                    <button disabled={!!propagatePreview} title="Dịch xuống dưới ảnh" onClick={()=>moveSelectedRegion(0,1,0)}>↓</button>
                    <i />
                    <button disabled={!!propagatePreview} title="Dịch về lát trước" onClick={()=>moveSelectedRegion(0,0,-1)}>− lát</button>
                    <span>Z</span>
                    <button disabled={!!propagatePreview} title="Dịch về lát sau" onClick={()=>moveSelectedRegion(0,0,1)}>+ lát</button>
                  </div>
                  <small>Dịch mask thật theo voxel; mọi mặt cắt và dựng hình 3D cập nhật cùng nhau.</small>
                </div>
                <button className="region-keep" disabled={!!propagatePreview} onClick={reviewSelectedRegion}><Icon name="check" size={15}/> Giữ và đến vùng tiếp</button>
                <div className="region-secondary-actions"><button disabled={!!propagatePreview} onClick={removeSelectedRegion}>Loại bỏ vùng</button><button disabled={!!propagatePreview} onClick={editSelectedRegion}>Chỉnh biên</button></div>
                <div className="component-structure-actions"><button disabled={!!propagatePreview} onClick={beginAddRegion}>+ Thêm ổ</button><button disabled={!!propagatePreview} onClick={beginSplitRegion}>Tách ổ</button><button disabled={!!propagatePreview||regions.length<2} className={mergeSourceKey?"active":""} onClick={mergeSourceKey?()=>setMergeSourceKey(null):beginMergeRegion}>{mergeSourceKey?"Hủy gộp":"Gộp…"}</button></div>
                <small className="region-hint">Click vùng màu trên ảnh để chọn trực tiếp. Màu vàng là ổ 3D đang chọn; đỏ là các ổ còn lại. C1/C2 là mã ổ ổn định trong phiên chỉnh sửa này.</small>
              </> : <p className="region-state">Chọn một vùng để bắt đầu duyệt.</p>}
              {!!regions.length&&<div className={`region-list ${mergeSourceKey?"merge-mode":""}`} aria-label="Danh sách ổ xuất huyết 3D">{regions.map(region=><button disabled={!!propagatePreview} key={region.key} className={`${region.key===selectedRegionKey?"active":""} ${selectedRegionKeys.has(region.key)?"multi-selected":""} ${reviewedRegionKeys.has(region.key)?"reviewed":""} ${region.key===mergeSourceKey?"merge-source":""}`} onClick={event=>selectRegion(region,null,event.shiftKey)} aria-label={`${componentId(region)}${selectedRegionKeys.has(region.key)?", đang chọn":""}${reviewedRegionKeys.has(region.key)?", đã kiểm tra":""}`} title="Shift+click để thêm hoặc bỏ component khỏi nhóm chọn"><span className="region-list-id">{reviewedRegionKeys.has(region.key)?<Icon name="check" size={12}/>:componentId(region)}</span><span className="region-list-copy"><strong>{region.volumeMl?`${region.volumeMl.toLocaleString("vi-VN",{maximumFractionDigits:2})} mL`:`${region.voxelCount.toLocaleString("vi-VN")} voxel`}</strong><small>{componentSliceText(region)}</small></span>{mergeSourceKey&&region.key!==mergeSourceKey&&<em>Gộp với</em>}</button>)}</div>}
              <button className="region-mpr" disabled={blocked||polygon.length>0} onClick={()=>setReferencePickerOpen(open=>!open)}><Icon name="layout" size={14}/>Chọn các mặt cắt phụ</button>
            </section>
            <section className="inspector-section"><h3>Nhãn chuyên gia <span className="ai-readonly">Chỉnh sửa</span></h3><div className="mask-alpha-controls"><label><span><i className="segment-swatch"/>Vùng tô</span><b>{Math.round(overlayOpacity*100)}%</b><input aria-label="Alpha vùng tô nhãn" type="range" min="0" max="1" step="0.05" value={labelVisible?overlayOpacity:0} onChange={e=>{const value=Number(e.target.value);setOverlayOpacity(value);setLabelVisible(value>0);}}/></label><label><span>Đường biên</span><b>{Math.round(outlineOpacity*100)}%</b><input aria-label="Alpha đường biên nhãn" type="range" min="0" max="1" step="0.05" value={outlineOpacity} onChange={e=>setOutlineOpacity(Number(e.target.value))}/></label></div><small>{selectedCase ? `${markedSlices.length} lát có nhãn · ${totalSlices} lát tổng` : "Chưa chọn ca"}</small>
              <details><summary>Thao tác nhãn</summary><button disabled={blocked||polygon.length>0} onClick={handleClearDrawing}>Xóa toàn bộ nhãn…</button><button disabled={blocked||polygon.length>0} onClick={()=>handleSaveRevision("draft")}>Lưu nháp ngay</button></details>
            </section>
            <section className="inspector-section"><h3>Gợi ý AI <span className="ai-readonly">Tham chiếu</span></h3>
              {inferenceJob?.status==="succeeded"?<><label className="editor-layer editor-layer-ai"><input type="checkbox" checked={aiVisible} disabled={aiLoading||blocked} onChange={toggleAi}/>{aiLoading?"Đang tải…":"Hiện gợi ý AI trên mọi mặt cắt và 3D"}</label>
                <div className="label-ai-display"><button className={aiDisplayMode==="components"?"active":""} onClick={()=>changeAiDisplayMode("components")}>Ổ 3D</button><button className={aiDisplayMode==="confidence"?"active":""} disabled={!inferenceJob.artifacts?.probability} title={inferenceJob.artifacts?.probability?"Vàng là sát ngưỡng, đỏ đậm là xác suất voxel cao":"Ca cũ chưa lưu probability map"} onClick={()=>changeAiDisplayMode("confidence")}>Xác suất voxel</button></div>
                <label className="label-ai-threshold"><span>Ngưỡng tạo mask <b>{aiThreshold.toFixed(2)}</b></span><input disabled={!inferenceJob.artifacts?.probability} type="range" min="0.05" max="0.95" step="0.05" value={aiThreshold} onChange={event=>setAiThreshold(Number(event.target.value))}/></label>
                <small><b>Xác suất voxel:</b> vàng là sát ngưỡng, đỏ đậm là xác suất cao. Ngưỡng {aiThreshold.toFixed(2)} quyết định voxel nào vào mask rồi được tách thành ổ 3D; đây không phải độ tin cậy chẩn đoán của cả ca.</small>
                <small>Kết quả đã lưu · {inferenceJob.model_version || "AI"} · {new Date(inferenceJob.completed_at||inferenceJob.updated_at).toLocaleDateString("vi-VN")}{Number.isFinite(inferenceJob.result?.inference?.confidence)?` · trung bình vùng dương ${(inferenceJob.result.inference.confidence*100).toFixed(1)}% (chưa hiệu chuẩn)`:""}</small><button disabled={blocked||polygon.length>0} onClick={handleImportAiMask}>Dùng mask thành bản nháp…</button></>:<small>Chưa có gợi ý cho ca này.</small>}
              <section className="ai-job-status" role="status" aria-live="polite" data-testid="ai-job-status">
                {localDraftNotice && <p>{localDraftNotice}</p>}
                {inferenceDisconnected ? <p>Đang kết nối lại máy chủ. Yêu cầu AI vẫn được giữ; chưa xác định trạng thái mới nhất.</p> : inferenceJob ? <p>{jobMessage(inferenceJob)}</p> : null}
                {inferenceJob?.id && <small>Yêu cầu {inferenceJob.id.slice(0,8)} · Lần xử lý {inferenceJob.attempt_count || 0}/{inferenceJob.max_attempts || 3}</small>}
              </section>
              <details><summary>Chạy phân tích</summary><select aria-label="Cấu hình AI" disabled={account.role!=="admin"} value={selectedTier} onChange={e=>setSelectedTier(e.target.value)}>{Object.entries(TIER_META).map(([key,val])=><option key={key} value={key} disabled={!capabilities?.tiers?.[key]?.command_configured}>{val.label}</option>)}</select><button disabled={blocked||inferenceBusy||!capabilities?.tiers?.[selectedTier]?.command_configured} onClick={handleRequestInference}>{inferenceBusy?"Yêu cầu đang được xử lý":inferenceJob?.status==="failed"?"Thử lại AI":"Chạy AI"}</button></details>
              <small className="model-connection">{capabilities?.tiers?.[selectedTier]?.service_status==="offline"?"AI mất kết nối":capabilities?.tiers?.[selectedTier]?.service_status==="connected"?"AI đã kết nối":"Chưa xác minh dịch vụ AI"}</small>
            </section>
            <section className="inspector-section annotation-metrics"><h3>Thống kê nhãn đã lưu</h3><div className="mask-volume"><strong>{displayedRevisionNum>0 && displayedRevision?.volume_ml!=null ? Number(displayedRevision.volume_ml).toLocaleString("vi-VN", {maximumFractionDigits:2}) : "—"}</strong><span>mL</span></div><small>{displayedRevisionNum>0 ? `Phiên bản ${displayedRevisionNum}${dirty || saving ? " · Có chỉnh sửa chưa lưu" : " · Thể tích mặt nạ"}` : "Có thống kê sau khi lưu bản nhãn đầu tiên."}</small></section>
            <section className="inspector-section"><details open={showHistory} onToggle={e=>setShowHistory(e.currentTarget.open)}><summary>Lịch sử nhãn</summary><div className="history-list">{revisions.map(r=><button key={r.revision_number} disabled={blocked||polygon.length>0} className={`history-item ${displayedRevisionNum===r.revision_number?"active":""}`} onClick={()=>handleLoadRevision(r.revision_number)}><strong>v{r.revision_number} · {r.revision_number===0?"Chưa đánh giá":r.status==="approved"?"Đã duyệt":"Nháp"}</strong><small>{r.revision_number>0?r.reviewer:"Bản khởi tạo"} · {new Date(r.created_at).toLocaleString("vi-VN")}</small></button>)}</div></details></section>
            <section className="inspector-section"><details open={showInfo} onToggle={e=>setShowInfo(e.currentTarget.open)}><summary>Thông tin ca</summary><p>{displayName(selectedCase?.name)}</p><small>Mã: {selectedCase?.id}<br/>Voxel: {selectedCase?.geometry?.zooms?.map(v=>v.toFixed(2)).join(" × ")} mm<br/>Nguồn: {selectedCase?.series_instance_uid?"PACS":"NIfTI nghiên cứu"}<br/>Quy ước X quang</small></details></section>
            <p className="editor-tool-help">Cuộn: zoom · Ctrl + cuộn: đổi lát<br/>←/→ đổi lát · Ctrl + ←/→ đổi ca<br/>V xem · B bút · P đường bao<br/>H di chuyển · Giữ Space: ẩn nhãn<br/>[ ] đổi cỡ bút</p>
          </aside>
        </div>
        <footer className="editor-bottom"><button disabled={blocked||polygon.length>0||!!propagatePreview||viewMode==="render"} onClick={()=>handleSliceChange(currentSlice-1)}>‹</button><span>{viewMode==="render"?"3D · kiểm tra hình học":`${LABEL_VIEWS.find(item=>item.id===viewMode)?.label} · lát ${selectedCase?currentSlice+1:0}/${totalSlices}${sam2Preview?" · SAM2 PREVIEW":propagatePreview?" · PREVIEW":confirmedPropagatedSlices.has(currentSlice)?" · ✓ Đã xác nhận":""}`}</span><div className="slice-track"><input aria-label="Lát cắt" disabled={blocked||polygon.length>0||!!propagatePreview||viewMode==="render"} type="range" min="0" max={Math.max(0,totalSlices-1)} value={currentSlice} onChange={e=>handleSliceChange(Number(e.target.value))}/>{viewMode==="axial"&&<div className="slice-marks" title="Đỏ: có nhãn · Xanh lá: đã xác nhận · Cyan: SAM2 preview">{Array.from({length:totalSlices},(_,i)=><button aria-label={`Lát ${i+1}${markedSlices.includes(i)?", có nhãn":""}${confirmedPropagatedSlices.has(i)?", đã xác nhận từ propagate":""}${sam2Preview?.slices?.includes(i)?", SAM2 preview":""}`} key={i} disabled={blocked||polygon.length>0||!!propagatePreview} className={`${markedSlices.includes(i)?"marked":""} ${confirmedPropagatedSlices.has(i)?"propagated-confirmed":""} ${propagatePreview?.targetSlice===i?"propagated-preview":""} ${sam2Preview?.slices?.includes(i)?"sam2-preview":""}`} onClick={()=>handleSliceChange(i)}/>)}</div>}</div><button disabled={blocked||polygon.length>0||!!propagatePreview||viewMode==="render"} onClick={()=>handleSliceChange(currentSlice+1)}>›</button><select aria-label="Cửa sổ ảnh" disabled={blocked||polygon.length>0||!!propagatePreview} value={windowKey} onChange={e=>setWindowKey(e.target.value)}>{Object.entries(WINDOWS).map(([key,preset])=><option key={key} value={key}>{preset.label}</option>)}</select><small>WW {actualWindow.width} / WL {actualWindow.level}</small></footer>
      </main>
      {showFinish && <div className="modal-backdrop editor-modal"><div className="modal-dialog reviewer-dialog" role="dialog" aria-modal="true" aria-labelledby="finish-title">
        <h3 id="finish-title">Hoàn tất ca gán nhãn</h3>
        <p><strong>{displayName(selectedCase?.name)}</strong> · Bản v{displayedRevisionNum}<br /><small>{selectedCase?.id}</small></p>
        <p>{markedSlices.length ? `Nhãn có trên ${markedSlices.length}/${totalSlices} lát cắt.` : "Nhãn đang rỗng. Chỉ phê duyệt sau khi xác nhận không có vùng cần gán nhãn trong toàn bộ thể tích."}</p>
        <p>{regions.length ? `Đã kiểm tra ${reviewedRegionCount}/${regions.length} vùng xuất huyết 3D.` : "Không có vùng trên mask; cần xác nhận đây là ca âm tính sau khi rà toàn bộ CT."}</p>
        <p>Nguồn nhãn: {provenanceCleared ? "Thủ công sau khi xóa nhãn" : (TIER_META[revisions.find(r=>r.revision_number===displayedRevisionNum)?.seed_tier]?.badge ? `AI ${TIER_META[revisions.find(r=>r.revision_number===displayedRevisionNum)?.seed_tier].badge}` : "Thủ công")}</p>
        <label>Ghi chú<textarea value={reviewNotes} onChange={e=>setReviewNotes(e.target.value)} /></label>
        <label className="checkbox-label"><input type="checkbox" checked={confirmEntireVolume} onChange={e=>setConfirmEntireVolume(e.target.checked)} />Tôi đã kiểm tra toàn bộ thể tích, không chỉ các lát có nhãn.</label>
        <p>Người duyệt: {reviewerIdentity}</p>
        <p><small>Phê duyệt đưa nhãn vào bộ dữ liệu nghiên cứu; không phải ký báo cáo chẩn đoán.</small></p>
        <div className="save-btn-group"><button disabled={saving} onClick={()=>setShowFinish(false)}>Quay lại</button><button disabled={!canApprove || saving || !reviewerIdentity || !confirmEntireVolume} onClick={async()=>{ if(await handleSaveRevision("approved")) nextCase(1,true,true); }}>{saving ? "Đang lưu…" : "Phê duyệt và ca tiếp"}</button></div>
      </div></div>}
      {/* Modal: Create Annotation Case */}
      {showCreateModal && (
        <div className="modal-backdrop">
          <div className="modal-dialog">
            <div className="modal-header">
              <h3>Thêm ca gán nhãn mới</h3>
              <button
                type="button"
                className="close-modal-btn"
                onClick={() => setShowCreateModal(false)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleCreateCaseSubmit} className="modal-body">
              <div className="mode-toggle">
                <button
                  type="button"
                  className={createMode === "pacs" ? "active" : ""}
                  onClick={() => setCreateMode("pacs")}
                >
                  Từ PACS Worklist
                </button>
                <button
                  type="button"
                  className={createMode === "job" ? "active" : ""}
                  onClick={() => {
                    setCreateMode("job");
                    loadJobsForModal();
                  }}
                >
                  Từ Tác vụ AI đã chạy
                </button>
                {capabilities?.direct_upload_enabled && (
                  <button
                    type="button"
                    className={createMode === "file" ? "active" : ""}
                    onClick={() => setCreateMode("file")}
                  >
                    Tải file NIfTI cục bộ
                  </button>
                )}
              </div>

              <div className="form-field">
                <label>Tên định danh ca:</label>
                <input
                  type="text"
                  placeholder="Để trống để lấy theo mã ca"
                  value={caseNameInput}
                  onChange={(e) => setCaseNameInput(e.target.value)}
                />
              </div>

              {createMode === "pacs" ? (
                <div className="pacs-select-field">
                  <label>Chọn Study từ PACS:</label>
                  {loadingStudies ? (
                    <div>Đang tải danh sách study PACS…</div>
                  ) : pacsStudies.length === 0 ? (
                    <div>Không có study nào trong PACS. Hãy gửi ca từ Simulator.</div>
                  ) : (
                    <div className="pacs-list-box">
                      {pacsStudies.map((s) => (
                        <div
                          key={s.orthanc_id}
                          className={`pacs-option ${selectedPacsForCreate?.orthanc_id === s.orthanc_id ? "selected" : ""}`}
                          onClick={() => setSelectedPacsForCreate(s)}
                        >
                          <strong>{s.patient_name || "ANONYMOUS"}</strong>
                          <small>{s.patient_id || "Không mã"} · {s.study_description || "CT"}</small>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : createMode === "job" ? (
                <div className="pacs-select-field">
                  <label>Chọn Tác vụ AI đã chạy:</label>
                  {loadingJobs ? (
                    <div>Đang tải danh sách tác vụ…</div>
                  ) : jobsList.length === 0 ? (
                    <div>Chưa có tác vụ nào trong danh sách.</div>
                  ) : (
                    <div className="pacs-list-box">
                      {jobsList.map((j) => (
                        <div
                          key={j.id}
                          className={`pacs-option ${selectedJobForCreate?.id === j.id ? "selected" : ""}`}
                          onClick={() => setSelectedJobForCreate(j)}
                        >
                          <strong>{j.original_filename || `Tác vụ ${j.id.slice(0, 8)}`}</strong>
                          <small>
                            Trạng thái: {j.status} · Tầng: {j.inference_tier || "fast"} · {new Date(j.created_at).toLocaleTimeString("vi-VN")}
                          </small>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="file-upload-field">
                  <label>Chọn file NIfTI (.nii, .nii.gz):</label>
                  <input
                    type="file"
                    accept=".nii,.nii.gz"
                    onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                  />
                </div>
              )}

              <div className="modal-footer">
                <button type="button" onClick={() => setShowCreateModal(false)}>Hủy</button>
                <button type="submit" className="primary-btn">Tạo ca</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
