import { useEffect, useRef, useState } from "react";
import {
  DRAG_MODE,
  MULTIPLANAR_TYPE,
  NVImage,
  Niivue,
  SHOW_RENDER,
  SLICE_TYPE,
} from "@niivue/niivue";
import { fetchWithRetry } from "../api";
import { Icon } from "../icons";
import { attachViewer, disposeViewer } from "../viewerLifecycle";
import { CONFIDENCE_COLORMAP, installConfidenceColormap } from "../viewerConfidence";
import {updateComponentDisplay,clearComponentDisplay,focusComponentCamera} from "../componentDisplay";
import "./ClinicalViewer.css";

const VIEWS = [
  { id: "axial", label: "Axial", type: SLICE_TYPE.AXIAL },
  { id: "coronal", label: "Coronal", type: SLICE_TYPE.CORONAL },
  { id: "sagittal", label: "Sagittal", type: SLICE_TYPE.SAGITTAL },
  { id: "mpr", label: "MPR", type: SLICE_TYPE.MULTIPLANAR },
  { id: "render", label: "3D", type: SLICE_TYPE.RENDER },
];

const WINDOWS = {
  brain: { label: "Brain", level: 40, width: 80 },
  subdural: { label: "Subdural", level: 75, width: 215 },
  stroke: { label: "Stroke", level: 40, width: 40 },
  bone: { label: "Bone", level: 600, width: 2800 },
};

const REFERENCE_VIEWS = VIEWS.filter((item) => ["axial", "coronal", "sagittal", "render"].includes(item.id));
const VIEW_AXIS = { axial: 2, coronal: 1, sagittal: 0 };
const AI_DRAW_LUT = {
  R: [0, 255, 255], G: [0, 45, 210], B: [0, 82, 55], A: [0, 255, 255], I: [0, 1, 2],
};

function componentId(component) {
  return component ? `C${component.number}` : "—";
}

function componentSliceText(component) {
  if (!component) return "—";
  return `Lát ${component.sliceStart + 1}–${component.sliceEnd + 1}`;
}

function smoothMaskDisplay(viewer) {
  const gl = viewer?.gl;
  if (!gl || !viewer.drawTexture) return;
  gl.bindTexture(gl.TEXTURE_3D, viewer.drawTexture);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
}

function locationSummary(location) {
  const point = location && typeof location === "object" ? location : {};
  const mm = Array.isArray(point.mm) ? point.mm.slice(0, 3) : [];
  const vox = Array.isArray(point.vox) ? point.vox.slice(0, 3) : [];
  const values = Array.isArray(point.values) ? point.values : [];
  return { mm, vox, hu: Number.isFinite(Number(values[0])) ? Number(values[0]) : null };
}

function formatStudyDate(value) {
  if (!value) return "Dữ liệu nghiên cứu";
  const raw = String(value);
  if (/^\d{8}$/.test(raw)) return `${raw.slice(6, 8)}/${raw.slice(4, 6)}/${raw.slice(0, 4)}`;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat("vi-VN", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" }).format(date);
}

function ViewerEmptyState() {
  return (
    <div className="viewer-empty">
      <div className="viewer-empty-mark" aria-hidden="true">
        <span />
        <span />
      </div>
      <p className="viewer-empty-kicker">RADIOLOGY WORKLIST</p>
      <h2>Chọn ca CT để bắt đầu đọc</h2>
      <p>
        Study xuất hiện sau khi modality hoàn tất gửi DICOM. Workstation này
        không tiếp nhận file trực tiếp từ bác sĩ.
      </p>
      <div className="viewer-shortcuts">
        <span><b>1</b> Nhận DICOM</span>
        <span><b>2</b> Chọn study</span>
        <span><b>3</b> Review AI</span>
      </div>
    </div>
  );
}

export default function ClinicalViewer({
  file,
  sourceLabel = "CT · Nguồn hệ thống · Radiological",
  studyMeta = null,
  modelLabel = "BrainHem ICH",
  maskUrl = "",
  probabilityUrl = "",
  operatingThreshold = 0.5,
  volumeMl = null,
  processing = false,
  processingLabel = "",
  processingProgress = 0,
  onLocationChange,
  onCaseStep,
  onEdit,
  labelingBusy = false,
}) {
  const canvasRef = useRef(null);
  const niivueRef = useRef(null);
  const referenceCanvasRefs = useRef({});
  const referenceCardRefs = useRef({});
  const referenceNiivueRefs = useRef({});
  const loadingStudyRef = useRef(false);
  const loadSequenceRef = useRef(0);
  const windowUpdateRef = useRef({ timer: null, frame: null, sequence: 0 });
  const overlayUpdateRef = useRef({
    fill: { timer: null, frame: null, sequence: 0 },
    outline: { timer: null, frame: null, sequence: 0 },
  });
  const crosshairUpdateRef = useRef({ timer: null, pending: null });
  const locationUpdateRef = useRef({ timer: null, pending: null, signature: "" });
  const onLocationChangeRef = useRef(onLocationChange);
  const crosshairLockedRef = useRef(false);
  const referenceResizeRef = useRef(null);
  const componentWorkerRef = useRef(null);
  const componentRequestRef = useRef(0);
  const highlightedComponentByViewerRef = useRef(new WeakMap());
  const componentHighlightFrameRef = useRef(null);
  const probabilityVolumeRef = useRef(null);
  const binaryDrawingRef = useRef(null);
  const thresholdTimerRef = useRef(null);
  const thresholdPreviewFrameRef = useRef(null);
  const loadedFileRef = useRef(null);
  const [view, setView] = useState("axial");
  const [referencePickerOpen, setReferencePickerOpen] = useState(false);
  const [referenceDockOpen, setReferenceDockOpen] = useState(true);
  const [referenceWidth, setReferenceWidth] = useState(180);
  const [referenceMenu, setReferenceMenu] = useState(null);
  const [enabledReferenceViews, setEnabledReferenceViews] = useState(() => new Set(["axial", "coronal", "sagittal", "render"]));
  const [windowKey, setWindowKey] = useState("brain");
  const [windowPanelOpen, setWindowPanelOpen] = useState(false);
  const [windowValues, setWindowValues] = useState({ level: WINDOWS.brain.level, width: WINDOWS.brain.width });
  const [overlayOpacity, setOverlayOpacity] = useState(0.55);
  // The study-load effect below enables this when the selected case has a mask.
  // Keeping the initial value false prevents an old study's state leaking into a case without AI.
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [outlineOpacity, setOutlineOpacity] = useState(0.95);
  const [viewerReady, setViewerReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [location, setLocation] = useState({ mm: [], vox: [], hu: null });
  const [lesionCenterVox, setLesionCenterVox] = useState(null);
  const [lesionSlices, setLesionSlices] = useState([]);
  const [axialSlices, setAxialSlices] = useState(0);
  const [currentAxialSlice, setCurrentAxialSlice] = useState(0);
  const [crosshairLocked, setCrosshairLocked] = useState(false);
  const [displayMode, setDisplayMode] = useState("components");
  const [threshold, setThreshold] = useState(Number(operatingThreshold) || 0.5);
  const [thresholdPreview, setThresholdPreview] = useState(Number(operatingThreshold) || 0.5);
  const [components, setComponents] = useState([]);
  const [selectedComponent, setSelectedComponent] = useState(0);
  const [componentMenu,setComponentMenu]=useState(null);
  const [componentStyles,setComponentStyles]=useState({});
  const [focusedComponent,setFocusedComponent]=useState(null);
  const componentFocusRef=useRef(null);
  useEffect(()=>{setComponentMenu(null);setComponentStyles({});setFocusedComponent(null);componentFocusRef.current=null;clearComponentDisplay(niivueRef.current);},[file]);
  useEffect(()=>{const viewer=niivueRef.current;if(!components.length){clearComponentDisplay(viewer);return;}const targets=[viewer,...Object.values(referenceNiivueRefs.current)];const customVisible=Object.values(componentStyles).some(style=>(style.fill??0)>0||(style.rim??0)>0);targets.forEach(target=>{if(target&&displayMode==="components"&&overlayVisible)target.setDrawOpacity(Math.max(overlayOpacity,(outlineOpacity>0||customVisible)?0.001:0));updateComponentDisplay(target,components,componentStyles,focusedComponent,overlayOpacity,outlineOpacity);});},[components,componentStyles,focusedComponent,overlayOpacity,outlineOpacity,overlayVisible,displayMode]);
  useEffect(()=>{const down=event=>{if(event.key==="Escape"){setComponentMenu(null);if(componentFocusRef.current){event.preventDefault();exitComponentFocus();}}};const outside=()=>setComponentMenu(null);window.addEventListener("keydown",down);window.addEventListener("pointerdown",outside);return()=>{window.removeEventListener("keydown",down);window.removeEventListener("pointerdown",outside);};},[]);
  const [componentBusy, setComponentBusy] = useState(false);
  const [componentSelecting, setComponentSelecting] = useState(false);
  const [thresholdQueued, setThresholdQueued] = useState(false);
  const [measurementMode, setMeasurementMode] = useState(false);
  const measurementDragRef=useRef(null);
  const [measurements, setMeasurements] = useState([]),[selectedMeasurement,setSelectedMeasurement]=useState(null),[measurementDraft,setMeasurementDraft]=useState(null);

  useEffect(() => {
    onLocationChangeRef.current = onLocationChange;
  }, [onLocationChange]);

  useEffect(() => {
    setOverlayVisible(false);
    setDisplayMode("components");
    setMeasurementMode(false);
    setMeasurements([]); setSelectedMeasurement(null); setMeasurementDraft(null);
    niivueRef.current?.clearAllMeasurements?.();
  }, [file]);

  useEffect(() => {
    const next = Number(operatingThreshold) || 0.5;
    setThreshold(next);
    setThresholdPreview(next);
  }, [operatingThreshold, file]);

  useEffect(() => {
    const worker = new Worker(new URL("../workers/regionAnalysis.worker.js", import.meta.url), { type:"module" });
    componentWorkerRef.current = worker;
    worker.onmessage = (event) => {
      if (event.data?.requestId !== componentRequestRef.current) return;
      setComponentBusy(false);
      if (event.data.error) { setComponents([]); return; }
      const next = event.data.regions || [];
      setComponents(next);
      setSelectedComponent((current) => {
        // Recomputing a threshold must never move the reader to another slice.
        // Keep an explicit selection only while that component still exists.
        return next.some((item) => item.number === current) ? current : 0;
      });
    };
    return () => {
      if (componentHighlightFrameRef.current) cancelAnimationFrame(componentHighlightFrameRef.current);
      if (thresholdPreviewFrameRef.current) cancelAnimationFrame(thresholdPreviewFrameRef.current);
      worker.terminate();
      componentWorkerRef.current = null;
    };
  }, []);

  // Keep the range thumb and probability shader responsive while dragging.
  // Rebuilding the binary volume and connected components is committed only
  // after the gesture settles (or immediately when the pointer is released).
  useEffect(() => {
    if (thresholdPreviewFrameRef.current) cancelAnimationFrame(thresholdPreviewFrameRef.current);
    thresholdPreviewFrameRef.current = requestAnimationFrame(() => {
      if (displayMode !== "confidence") return;
      [niivueRef.current].forEach((target) => {
        const confidenceVolume = target?.volumes?.[1];
        if (!confidenceVolume) return;
        confidenceVolume.cal_min = thresholdPreview;
        confidenceVolume.cal_max = 1;
        confidenceVolume.colormapType = 1;
        target.updateGLVolume();
      });
    });
    const timer = window.setTimeout(() => {
      setThreshold(thresholdPreview);
      if (thresholdPreview === threshold) setThresholdQueued(false);
    }, 420);
    return () => {
      clearTimeout(timer);
      if (thresholdPreviewFrameRef.current) cancelAnimationFrame(thresholdPreviewFrameRef.current);
    };
  }, [thresholdPreview, displayMode, threshold]);

  useEffect(() => {
    const probability = probabilityVolumeRef.current;
    if (!probability || !file) return undefined;
    if (thresholdTimerRef.current) clearTimeout(thresholdTimerRef.current);
    thresholdTimerRef.current = setTimeout(() => {
      const values = probability.img;
      if (!values?.length) return;
      const confidenceTargets = [niivueRef.current, ...Object.values(referenceNiivueRefs.current)];
      confidenceTargets.forEach((target) => {
        const confidenceVolume = target?.volumes?.[1];
        if (!confidenceVolume) return;
        confidenceVolume.cal_min = threshold;
        confidenceVolume.cal_max = 1;
        confidenceVolume.colormapType = 1;
        target.updateGLVolume();
      });
      const thresholded = probability.clone();
      const mask = new Uint8Array(values.length);
      for (let index = 0; index < values.length; index += 1) mask[index] = Number(values[index]) >= threshold ? 1 : 0;
      thresholded.img = mask;
      const main = niivueRef.current;
      if (!main) return;
      const mainCrosshair = main.scene?.crosshairPos ? [...main.scene.crosshairPos] : null;
      const referenceCrosshairs = new Map(Object.values(referenceNiivueRefs.current).map((reference) => [reference, reference.scene?.crosshairPos ? [...reference.scene.crosshairPos] : null]));
      main.loadDrawing(thresholded.clone());
      smoothMaskDisplay(main);
      main.setDrawColormap(AI_DRAW_LUT);
      main.drawRimOpacity = overlayVisible && outlineOpacity > 0 ? outlineOpacity : -1;
      main.setDrawOpacity(displayMode === "components" && overlayVisible ? Math.max(overlayOpacity, outlineOpacity > 0 ? .001 : 0) : 0);
      main.refreshDrawing(true);
      if (mainCrosshair) main.scene.crosshairPos = mainCrosshair;
      analyzeComponents(main, mask);
      Object.values(referenceNiivueRefs.current).forEach((reference) => {
        reference.loadDrawing(thresholded.clone());
        smoothMaskDisplay(reference);
        reference.setDrawColormap(AI_DRAW_LUT);
        reference.drawRimOpacity = overlayVisible && outlineOpacity > 0 ? outlineOpacity : -1;
        reference.setDrawOpacity(displayMode === "components" && overlayVisible ? Math.max(overlayOpacity, outlineOpacity > 0 ? .001 : 0) : 0);
        reference.refreshDrawing(true);
        const preserved = referenceCrosshairs.get(reference);
        if (preserved) reference.scene.crosshairPos = preserved;
      });
      main.drawScene();
      Object.values(referenceNiivueRefs.current).forEach((reference) => reference.drawScene());
      setThresholdQueued(false);
    }, 120);
    return () => clearTimeout(thresholdTimerRef.current);
  }, [threshold, probabilityUrl]);

  useEffect(() => {
    const targets = [niivueRef.current, ...Object.values(referenceNiivueRefs.current)];
    targets.forEach((target) => {
      if (!target) return;
      if (target.volumes?.[1]) target.setOpacity(1, displayMode === "confidence" && overlayVisible ? .72 : 0);
      if (target.drawBitmap) {
        target.drawRimOpacity = overlayVisible && outlineOpacity > 0 ? outlineOpacity : -1;
        target.setDrawOpacity(displayMode === "components" && overlayVisible ? Math.max(overlayOpacity, outlineOpacity > 0 ? .001 : 0) : 0);
        target.drawScene();
      }
    });
  // Opacity sliders update their WebGL uniforms through scheduleOverlayUpdate.
  // Keeping them out of this effect avoids rendering all four canvases twice
  // for every pointer event.
  }, [displayMode, overlayVisible]);

  function analyzeComponents(viewer, preparedBitmap = null) {
    const bitmap = viewer?.drawBitmap;
    const dims = viewer?.volumes?.[0]?.dimsRAS;
    const worker = componentWorkerRef.current;
    if (!bitmap || !dims || !worker) return;
    // Threshold masks are already binary. Typed-array copies run in native
    // code and avoid another multi-million-iteration loop on the UI thread.
    const binary = preparedBitmap instanceof Uint8Array
      ? preparedBitmap.slice()
      : Uint8Array.from(bitmap, (value) => value ? 1 : 0);
    binaryDrawingRef.current = binary;
    const copy = binary.slice();
    highlightedComponentByViewerRef.current = new WeakMap();
    const requestId = componentRequestRef.current + 1;
    componentRequestRef.current = requestId;
    setComponentBusy(true);
    const voxelVolumeMl = Math.abs(Number(viewer.volumes[0]?.hdr?.pixDims?.[1] || 1) * Number(viewer.volumes[0]?.hdr?.pixDims?.[2] || 1) * Number(viewer.volumes[0]?.hdr?.pixDims?.[3] || 1)) / 1000;
    worker.postMessage({ requestId, bitmap:copy, dims:[dims[1],dims[2],dims[3]], voxelVolumeMl, minVoxelCount:20 }, [copy.buffer]);
  }

  useEffect(() => {
    if (!referenceMenu) return undefined;
    const close = () => setReferenceMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [referenceMenu]);

  function syncCrosshairFrom(source) {
    const position = source?.scene?.crosshairPos;
    if (!position) return;
    const targets = [niivueRef.current, ...Object.values(referenceNiivueRefs.current)];
    targets.forEach((target) => {
      if (!target || target === source) return;
      target.scene.crosshairPos = [...position];
      target.drawScene();
    });
  }

  async function ensureReferenceViewer(item) {
    const viewers = referenceNiivueRefs.current;
      const canvas = referenceCanvasRefs.current[item.id];
      if (!canvas) return null;
      if (viewers[item.id]) return attachViewer(viewers[item.id], canvas);
      const reference = new Niivue({
        backColor: [0.015, 0.022, 0.032, 1],
        crosshairColor: [0.35, 0.85, 0.85, 0.7],
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
        // Linear texture filtering is applied by smoothMaskDisplay. Keeping
        // NiiVue's volumetric blur off avoids a full 3D blur on every component
        // highlight upload.
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
      // onLocationChange reports the hover voxel. Never use it to move the
      // shared locator: that made every auxiliary plane follow the pointer.
      reference.onLocationChange = () => {};
      viewers[item.id] = reference;
      return reference;
  }

  useEffect(() => {
    if (!canvasRef.current || niivueRef.current) return undefined;

    const nv = new Niivue({
      backColor: [0.025, 0.035, 0.05, 1],
      crosshairColor: [0.6, 0.7, 0.8, 0.75],
      crosshairWidth: 0.8,
      dragMode: DRAG_MODE.pan,
      isColorbar: false,
      isCornerOrientationText: false,
      isOrientationTextVisible: false,
      isRadiologicalConvention: true,
      isRuler: true,
      rulerColor: [0.38, 0.7, 0.98, 0.92],
      rulerWidth: 2,
      measureLineColor: [0.1, 0.79, 1, 1],
      measureTextColor: [0.88, 0.97, 1, 1],
      measureTextHeight: 0.045,
      loadingText: "Đang dựng thể tích CT…",
      multiplanarEqualSize: true,
      multiplanarForceRender: false,
      multiplanarLayout: MULTIPLANAR_TYPE.GRID,
      multiplanarPadPixels: 3,
      multiplanarShowRender: SHOW_RENDER.AUTO,
      show3Dcrosshair: true,
      smoothDrawing: 0,
      textHeight: 0.035,
      mouseEventConfig: {
        leftButton: { primary: DRAG_MODE.pan },
        rightButton: DRAG_MODE.none,
        centerButton: DRAG_MODE.pan,
      },
    });
    installConfidenceColormap(nv);

    nv.onLocationChange = (nextLocation) => {
      // NiiVue emits this continuously while the pointer moves. Updating both
      // this component and App on every event made the whole clinical screen
      // reconcile dozens of times per second, especially painfully once an AI
      // mask was present. Coalesce location readout updates without affecting
      // the WebGL interaction itself.
      locationUpdateRef.current.pending = locationSummary(nextLocation);
      if (locationUpdateRef.current.timer) return;
      locationUpdateRef.current.timer = window.setTimeout(() => {
        const normalized = locationUpdateRef.current.pending;
        locationUpdateRef.current.timer = null;
        if (!normalized) return;
        const signature = `${normalized.vox.join(",")}:${normalized.hu == null ? "" : Math.round(normalized.hu)}`;
        if (signature === locationUpdateRef.current.signature) return;
        locationUpdateRef.current.signature = signature;
        setLocation(normalized);
        onLocationChangeRef.current?.(normalized);
      }, 120);
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
    }).catch((attachError) => {
      if (niivueRef.current !== nv) return;
      setError(`Không khởi tạo được WebGL viewer: ${attachError.message}`);
    });
    niivueRef.current = nv;

    return () => {
      loadSequenceRef.current += 1;
      if (windowUpdateRef.current.timer) clearTimeout(windowUpdateRef.current.timer);
      if (windowUpdateRef.current.frame) cancelAnimationFrame(windowUpdateRef.current.frame);
      Object.values(overlayUpdateRef.current).forEach((update) => {
        if (update.timer) clearTimeout(update.timer);
        if (update.frame) cancelAnimationFrame(update.frame);
      });
      if (crosshairUpdateRef.current.timer) clearTimeout(crosshairUpdateRef.current.timer);
      if (locationUpdateRef.current.timer) clearTimeout(locationUpdateRef.current.timer);
      disposeViewer(nv);
      Object.values(referenceNiivueRefs.current).forEach(disposeViewer);
      referenceNiivueRefs.current = {};
      niivueRef.current = null;
    };
  }, []);

  function updateCrosshair(viewer, x, y, viewId) {
    if (!viewer?.volumes?.[0]) return;
    if (viewId === "render") {
      const dpr = viewer.uiData?.dpr || window.devicePixelRatio || 1;
      viewer.mousePos = [x * dpr, y * dpr];
      viewer.uiData.mouseDepthPicker = true;
      viewer.drawScene();
      viewer.drawScene();
    } else {
      viewer.mouseClick(x, y);
    }
    // mouseClick already renders and emits a location update for 2D views.
    if (viewId === "render") viewer.createOnLocationChange?.();
    const total = viewer.volumes[0].dimsRAS?.[3] || 1;
    setCurrentAxialSlice(Math.max(0, Math.min(total - 1, Math.floor((viewer.scene.crosshairPos?.[2] ?? 0.5) * total))));
    syncCrosshairFrom(viewer);
  }

  function followCrosshair(event) {
    const viewer = niivueRef.current;
    const canvas = canvasRef.current;
    if (crosshairLockedRef.current || event.buttons !== 0 || !viewer?.volumes?.[0] || !canvas) return;
    const bounds = canvas.getBoundingClientRect();
    crosshairUpdateRef.current.pending = { viewer, x: event.clientX - bounds.left, y: event.clientY - bounds.top, viewId: view };
    if (crosshairUpdateRef.current.timer) return;
    crosshairUpdateRef.current.timer = setTimeout(() => {
      const pending = crosshairUpdateRef.current.pending;
      crosshairUpdateRef.current.timer = null;
      if (pending) updateCrosshair(pending.viewer, pending.x, pending.y, pending.viewId);
    }, view === "render" ? 110 : (overlayVisible ? 80 : 40));
  }

  function toggleCrosshairLock(event) {
    event.preventDefault();
    event.stopPropagation();
    if(measurementMode||event.target!==canvasRef.current)return;
    const next = !crosshairLockedRef.current;
    if (next) {
      const canvas = canvasRef.current;
      const viewer = niivueRef.current;
      if (canvas && viewer?.volumes?.[0]) {
        const bounds = canvas.getBoundingClientRect();
        updateCrosshair(viewer, event.clientX - bounds.left, event.clientY - bounds.top, view);
      }
    }
    crosshairLockedRef.current = next;
    setCrosshairLocked(next);
  }

  function openComponentMenu(event){
    event.preventDefault();event.stopPropagation();
    if(!file||measurementMode||componentBusy)return;
    setComponentMenu({x:Math.max(8,Math.min(event.clientX,innerWidth-280)),y:Math.max(8,Math.min(event.clientY,innerHeight-330))});
  }

  function exitComponentFocus(){
    const previous=componentFocusRef.current,nv=niivueRef.current;
    componentFocusRef.current=null;setFocusedComponent(null);
    if(!previous||!nv)return;
    setView(previous.view);nv.setSliceType(VIEWS.find(v=>v.id===previous.view)?.type??SLICE_TYPE.AXIAL);
    nv.scene.crosshairPos=previous.crosshair;nv.setPan2Dxyzmm(previous.pan);
    crosshairLockedRef.current=previous.locked;setCrosshairLocked(previous.locked);
    clearComponentDisplay(nv);nv.createOnLocationChange();syncCrosshairFrom(nv);
  }

  function spotlightComponent(){
    const component=components.find(c=>c.number===selectedComponent),nv=niivueRef.current;
    if(!component||!nv)return;
    if(!componentFocusRef.current)componentFocusRef.current={pan:[...nv.scene.pan2Dxyzmm],crosshair:[...nv.scene.crosshairPos],view,locked:crosshairLockedRef.current};
    if(["render","mpr"].includes(view)){setView("axial");nv.setSliceType(SLICE_TYPE.AXIAL);}
    setDisplayMode("components");focusComponentCamera(nv,component);
    setFocusedComponent(component.key??String(component.number));crosshairLockedRef.current=true;setCrosshairLocked(true);syncCrosshairFrom(nv);setComponentMenu(null);
  }

  function setComponentStyle(field,value){const component=components.find(c=>c.number===selectedComponent);if(!component)return;const key=component.key??String(component.number);setComponentStyles(previous=>({...previous,[key]:{...previous[key],[field]:Number(value)}}));}

  function toggleMeasurement() {
    const next = !measurementMode;
    setMeasurementMode(next);
    niivueRef.current?.clearAllMeasurements?.();
    niivueRef.current?.setMouseEventConfig({
      leftButton: { primary: next ? DRAG_MODE.none : DRAG_MODE.pan },
      rightButton: DRAG_MODE.none,
      centerButton: DRAG_MODE.pan,
    });
  }

  function measurementPoint(event) { const canvas=canvasRef.current, viewer=niivueRef.current; if(!canvas||!viewer?.volumes?.[0])return null; const box=canvas.getBoundingClientRect(); const x=event.clientX-box.left,y=event.clientY-box.top; const frac=viewer.canvasPos2frac([x,y]); if(!frac||frac[0]<0||frac[0]>1||frac[1]<0||frac[1]>1)return null; const mm=viewer.frac2mm(frac); return {x,y,mm:[...mm]}; }
  function measurementDistance(a,b) { return Math.sqrt(a.mm.reduce((sum,value,index)=>sum+(value-b.mm[index])**2,0)); }
  function beginMeasure(event) { if(!measurementMode||event.button!==0)return; event.preventDefault(); event.stopPropagation(); const point=measurementPoint(event); if(point)setMeasurementDraft({start:point,end:point}); }
  function moveMeasure(event) { const point=measurementPoint(event); if(!point)return; if(measurementDragRef.current){event.preventDefault();setMeasurements(current=>current.map(item=>item.id===measurementDragRef.current.id?{...item,[measurementDragRef.current.side]:point}:item));return;} if(!measurementDraft)return; event.preventDefault(); setMeasurementDraft(current=>({...current,end:point})); }
  function endMeasure(event) { measurementDragRef.current=null; if(!measurementDraft)return; event.preventDefault(); const draft=measurementDraft; if(measurementDistance(draft.start,draft.end)>0.5)setMeasurements(current=>[...current,{id:crypto.randomUUID(),start:draft.start,end:draft.end}]); setMeasurementDraft(null); }
  function updateMeasurePoint(id,side,event) { event.preventDefault(); event.stopPropagation(); measurementDragRef.current={id,side}; setSelectedMeasurement(id); }
  useEffect(()=>{ const onKey=event=>{
    if (event.target.closest?.("input,textarea,select,[contenteditable=true]")) return;
    if ((event.ctrlKey || event.metaKey) && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      onCaseStep?.(event.key === "ArrowRight" ? 1 : -1);
      return;
    }
    if (!event.ctrlKey && !event.metaKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      stepCurrentSlice(event.key === "ArrowRight" ? 1 : -1);
      return;
    }
    if((event.key==="Delete"||event.key==="Backspace")&&selectedMeasurement){setMeasurements(current=>current.filter(item=>item.id!==selectedMeasurement));setSelectedMeasurement(null);}
  }; window.addEventListener("keydown",onKey); return()=>window.removeEventListener("keydown",onKey);},[selectedMeasurement, file, view, onCaseStep]);

  function zoomReference(item, event) {
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

  function beginReferenceResize(event) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    referenceResizeRef.current = { startX: event.clientX, startWidth: referenceWidth };
  }

  function moveReferenceResize(event) {
    const resize = referenceResizeRef.current;
    if (!resize) return;
    event.preventDefault();
    setReferenceWidth(Math.max(170, Math.min(460, resize.startWidth + resize.startX - event.clientX)));
  }

  function endReferenceResize(event) {
    if (!referenceResizeRef.current) return;
    referenceResizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    requestAnimationFrame(() => Object.values(referenceNiivueRefs.current).forEach((reference) => reference?.resizeListener()));
  }

  function resetReference(item) {
    const reference = referenceNiivueRefs.current[item.id];
    if (!reference) return;
    reference.setPan2Dxyzmm([0, 0, 0, 1]);
    if (item.id === "render") {
      reference.scene.volScaleMultiplier = 1;
      reference.setRenderAzimuthElevation(0, 0);
    }
  }

  async function fullscreenReference(item) {
    const card = referenceCardRefs.current[item.id];
    if (!card?.requestFullscreen) return;
    await card.requestFullscreen();
    requestAnimationFrame(() => referenceNiivueRefs.current[item.id]?.resizeListener());
  }

  function hideReference(item) {
    setEnabledReferenceViews((current) => {
      const next = new Set(current);
      next.delete(item.id);
      return next;
    });
    setReferenceMenu(null);
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !file) return undefined;
    const handleWheel = (event) => {
      const nv = niivueRef.current;
      if (!nv?.volumes?.[0]) return;
      const axis = VIEW_AXIS[view];
      if (event.ctrlKey && Number.isInteger(axis)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const total = nv.volumes[0].dimsRAS?.[axis + 1] || 1;
        const current = Math.max(0, Math.min(total - 1, Math.floor((nv.scene.crosshairPos?.[axis] ?? 0.5) * total)));
        const next = Math.max(0, Math.min(total - 1, current + (event.deltaY > 0 ? 1 : -1)));
        nv.scene.crosshairPos[axis] = (next + 0.5) / total;
        if (axis === 2) setCurrentAxialSlice(next);
        nv.createOnLocationChange();
        nv.drawScene();
        syncCrosshairFrom(nv);
        return;
      }
      // Let Niivue handle ordinary zoom. Its native wheel path calculates the
      // pan offset from the cursor/crosshair, keeping the hovered anatomy fixed.
      // We only intercept Ctrl+wheel above for slice navigation.
    };
    const handlePointerMove = (event) => followCrosshair(event);
    canvas.addEventListener("wheel", handleWheel, { passive: false, capture: true });
    canvas.addEventListener("pointermove", handlePointerMove, { capture: true });
    return () => {
      canvas.removeEventListener("wheel", handleWheel, true);
      canvas.removeEventListener("pointermove", handlePointerMove, true);
    };
  }, [file, view]);

  useEffect(() => {
    const nv = niivueRef.current;
    if (!nv || !file || !viewerReady) return undefined;
    const showOverlay = Boolean(maskUrl);
    setOverlayVisible(showOverlay);
    const sequence = loadSequenceRef.current + 1;
    loadSequenceRef.current = sequence;
    let cancelled = false;

    async function loadStudy() {
      loadingStudyRef.current = true;
      setLoading(true);
      setError("");
      crosshairLockedRef.current = false;
      setCrosshairLocked(false);
      setLesionCenterVox(null);
      setLesionSlices([]);
      try {
        const preservePosition = loadedFileRef.current === file && nv.volumes.length > 0;
        const preservedCrosshair = preservePosition && nv.scene?.crosshairPos ? [...nv.scene.crosshairPos] : null;
        const preservedPan = preservePosition && nv.scene?.pan2Dxyzmm ? [...nv.scene.pan2Dxyzmm] : null;
        while (nv.volumes.length) nv.removeVolumeByIndex(nv.volumes.length - 1);

        const preset = windowKey === "custom" ? windowValues : (WINDOWS[windowKey] || WINDOWS.brain);
        const ct = await NVImage.loadFromFile({
          file,
          name: file.name,
          colormap: "gray",
          opacity: 1,
          cal_min: preset.level - preset.width / 2,
          cal_max: preset.level + preset.width / 2,
          trustCalMinMax: true,
        });
        if (cancelled || sequence !== loadSequenceRef.current) return;
        nv.addVolume(ct);
        const totalAxial = ct.dimsRAS?.[3] || ct.hdr?.dims?.[3] || 0;
        setAxialSlices(totalAxial);
        if (totalAxial > 0) {
          setCurrentAxialSlice(Math.max(0, Math.min(totalAxial - 1, Math.floor((nv.scene.crosshairPos?.[2] ?? 0.5) * totalAxial))));
        }
        nv.setSliceType(VIEWS.find((item) => item.id === view)?.type ?? SLICE_TYPE.AXIAL);
        nv.drawScene();
        setLoading(false);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        let decodedMask = null;
        let decodedProbability = null;
        if (probabilityUrl) {
          const probabilityResponse = await fetchWithRetry(probabilityUrl, { cache:"force-cache" }, 3, 30000);
          if (!probabilityResponse.ok) throw new Error(`không tải được probability map (${probabilityResponse.status})`);
          const probabilityBlob = await probabilityResponse.blob();
          decodedProbability = await NVImage.loadFromFile({
            file:new File([probabilityBlob], "brainhem-probability.nii.gz", { type:probabilityBlob.type || "application/gzip" }),
            name:"Xác suất voxel", colormap:CONFIDENCE_COLORMAP, opacity:0, cal_min:threshold, cal_max:1, trustCalMinMax:true, colormapType:1,
          });
          probabilityVolumeRef.current = decodedProbability;
          nv.addVolume(decodedProbability);
        } else {
          probabilityVolumeRef.current = null;
        }
        if (maskUrl) {
          const response = await fetchWithRetry(
            maskUrl,
            { cache: "force-cache" },
            3,
            30000,
          );
          if (!response.ok) throw new Error(`không tải được mask (${response.status})`);
          const maskBlob = await response.blob();
          const maskFile = new File([maskBlob], "brainhem-segmentation.nii.gz", {
            type: maskBlob.type || "application/gzip",
          });
          const mask = await NVImage.loadFromFile({
            file: maskFile,
            name: maskFile.name,
            colormap: "red",
            opacity: showOverlay ? overlayOpacity : 0,
            cal_min: 0.5,
            cal_max: 1,
            trustCalMinMax: true,
          });
          if (cancelled || sequence !== loadSequenceRef.current) return;
          decodedMask = mask;
          nv.loadDrawing(mask.clone());
          smoothMaskDisplay(nv);
          nv.setDrawColormap(AI_DRAW_LUT);
          nv.drawRimOpacity = showOverlay && outlineOpacity > 0 ? outlineOpacity : -1;
          nv.setDrawOpacity(showOverlay ? Math.max(overlayOpacity, outlineOpacity > 0 ? 0.001 : 0) : 0);
          nv.refreshDrawing(true);
          analyzeComponents(nv);
          const dims = mask.hdr?.dims;
          const values = mask.img;
          if (dims?.length >= 4 && values?.length) {
            const [dimX, dimY, dimZ] = [dims[1], dims[2], dims[3]];
            const permRAS = mask.permRAS || [1, 2, 3];
            const dimRASZ = mask.dimsRAS?.[3] || dimZ;
            const sliceCounts = new Uint32Array(dimRASZ);
            const sliceSumX = new Float64Array(dimRASZ);
            const sliceSumY = new Float64Array(dimRASZ);
            const markedAxialSlices = new Set();
            for (let index = 0; index < values.length; index += 1) {
              if (Number(values[index]) <= 0) continue;
              const z = Math.floor(index / (dimX * dimY));
              const remainder = index - z * dimX * dimY;
              const y = Math.floor(remainder / dimX);
              const x = remainder - y * dimX;
              const nativeVox = [x, y, z];
              const rasVox = permRAS.map((axis) => {
                const nativeAxis = Math.abs(axis) - 1;
                const coordinate = nativeVox[nativeAxis];
                return axis < 0 ? dims[nativeAxis + 1] - 1 - coordinate : coordinate;
              });
              const [rx, ry, rz] = rasVox;
              markedAxialSlices.add(rz);
              sliceCounts[rz] += 1;
              sliceSumX[rz] += rx;
              sliceSumY[rz] += ry;
            }
            if (markedAxialSlices.size) {
              let bestSlice = 0;
              for (let z = 1; z < dimRASZ; z += 1) {
                if (sliceCounts[z] > sliceCounts[bestSlice]) bestSlice = z;
              }
              setLesionSlices([...markedAxialSlices].sort((left, right) => left - right));
              setLesionCenterVox([
                sliceSumX[bestSlice] / sliceCounts[bestSlice],
                sliceSumY[bestSlice] / sliceCounts[bestSlice],
                bestSlice,
              ]);
            }
          }
        }

        // Secondary planes initialize after the main CT is already usable.
        for (const item of REFERENCE_VIEWS) {
          if (cancelled || sequence !== loadSequenceRef.current) return;
          const reference = await ensureReferenceViewer(item);
          if (!reference || cancelled || sequence !== loadSequenceRef.current) return;
          while (reference.volumes.length) reference.removeVolumeByIndex(reference.volumes.length - 1);
          reference.addVolume(ct.clone());
          if (decodedProbability) {
            const probabilityClone = decodedProbability.clone();
            probabilityClone.opacity = 0;
            reference.addVolume(probabilityClone);
          }
          if (decodedMask) {
            const referenceMask = decodedMask.clone();
            reference.loadDrawing(referenceMask.clone());
            smoothMaskDisplay(reference);
            reference.setDrawColormap(AI_DRAW_LUT);
            reference.drawRimOpacity = showOverlay && outlineOpacity > 0 ? outlineOpacity : -1;
            reference.setDrawOpacity(showOverlay ? Math.max(overlayOpacity, outlineOpacity > 0 ? 0.001 : 0) : 0);
            reference.refreshDrawing(true);
          }
          reference.resizeListener();
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }

        nv.setSliceType(VIEWS.find((item) => item.id === view)?.type ?? SLICE_TYPE.MULTIPLANAR);
        if (view === "mpr") nv.setMultiplanarLayout(MULTIPLANAR_TYPE.GRID);
        if (preservedCrosshair) nv.scene.crosshairPos = preservedCrosshair;
        if (preservedPan) nv.scene.pan2Dxyzmm = preservedPan;
        REFERENCE_VIEWS.forEach((item) => referenceNiivueRefs.current[item.id]?.setSliceType(item.type));
        syncCrosshairFrom(nv);
        nv.drawScene();
        loadedFileRef.current = file;
      } catch (loadError) {
        if (!cancelled) setError(`Không mở được dữ liệu ảnh: ${loadError.message}`);
      } finally {
        loadingStudyRef.current = false;
        if (!cancelled) setLoading(false);
      }
    }

    loadStudy();
    return () => {
      cancelled = true;
    };
    // window/view/opacity changes are applied separately without reloading the volume.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, maskUrl, probabilityUrl, viewerReady]);

  function changeView(nextView) {
    const nv = niivueRef.current;
    setView(nextView.id);
    if (!nv) return;
    nv.setSliceType(nextView.type);
    if (nextView.type === SLICE_TYPE.MULTIPLANAR) {
      nv.setMultiplanarLayout(MULTIPLANAR_TYPE.GRID);
    }
    nv.setDragMode(nextView.id === "render" ? DRAG_MODE.crosshair : DRAG_MODE.pan);
    nv.setMouseEventConfig({
      leftButton: { primary: nextView.id === "render" ? DRAG_MODE.crosshair : DRAG_MODE.pan },
      rightButton: DRAG_MODE.none,
      centerButton: DRAG_MODE.pan,
    });
    requestAnimationFrame(() => {
      if (niivueRef.current !== nv) return;
      nv.setDragMode(nextView.id === "render" ? DRAG_MODE.crosshair : DRAG_MODE.pan);
      nv.setMouseEventConfig({
        leftButton: { primary: nextView.id === "render" ? DRAG_MODE.crosshair : DRAG_MODE.pan },
        rightButton: DRAG_MODE.none,
        centerButton: DRAG_MODE.pan,
      });
      nv.resizeListener();
      nv.drawScene();
    });
  }

  function changeWindow(nextKey) {
    const preset = WINDOWS[nextKey];
    if (!preset) return;
    setWindowKey(nextKey);
    setWindowValues({ level: preset.level, width: preset.width });
    scheduleWindowUpdate({ level: preset.level, width: preset.width }, 25);
  }

  function scheduleWindowUpdate(next, delay = 75) {
    const sequence = windowUpdateRef.current.sequence + 1;
    windowUpdateRef.current.sequence = sequence;
    if (windowUpdateRef.current.timer) clearTimeout(windowUpdateRef.current.timer);
    if (windowUpdateRef.current.frame) cancelAnimationFrame(windowUpdateRef.current.frame);
    // The large primary canvas follows the thumb on the next paint. Auxiliary
    // canvases settle afterwards so four WebGL updates do not compete in the
    // same frame.
    windowUpdateRef.current.frame = requestAnimationFrame(() => {
      windowUpdateRef.current.frame = null;
      if (sequence !== windowUpdateRef.current.sequence) return;
      const target = niivueRef.current;
      if (!target?.volumes?.[0]) return;
      target.volumes[0].cal_min = next.level - next.width / 2;
      target.volumes[0].cal_max = next.level + next.width / 2;
      target.updateGLVolume();
    });
    windowUpdateRef.current.timer = setTimeout(() => {
      const targets = Object.values(referenceNiivueRefs.current);
      targets.forEach((target, index) => {
        setTimeout(() => {
          if (sequence !== windowUpdateRef.current.sequence || !target?.volumes?.[0]) return;
          target.volumes[0].cal_min = next.level - next.width / 2;
          target.volumes[0].cal_max = next.level + next.width / 2;
          target.updateGLVolume();
        }, index * 24);
      });
    }, Math.max(110, delay));
  }

  function changeCustomWindow(field, rawValue) {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return;
    const next = {
      ...windowValues,
      [field]: field === "width" ? Math.max(1, Math.min(4000, parsed)) : Math.max(-1000, Math.min(2000, parsed)),
    };
    setWindowKey("custom");
    setWindowValues(next);
    scheduleWindowUpdate(next, 75);
  }

  function updateOverlay(nextOpacity, visible = overlayVisible) {
    setOverlayOpacity(nextOpacity);
    scheduleOverlayUpdate("fill", nextOpacity,70,visible);
  }

  function scheduleOverlayUpdate(kind, value, delay = 70,visible=overlayVisible) {
    const update = overlayUpdateRef.current[kind];
    const sequence = update.sequence + 1;
    update.sequence = sequence;
    if (update.timer) clearTimeout(update.timer);
    if (update.frame) cancelAnimationFrame(update.frame);
    const apply = (target) => {
      if (!target?.drawBitmap) return;
      if (kind === "fill") {
        target.drawRimOpacity = visible && outlineOpacity > 0 ? outlineOpacity : -1;
        const customVisible=Object.values(componentStyles).some(style=>(style.fill??0)>0||(style.rim??0)>0);
        target.setDrawOpacity(visible&&displayMode==="components" ? Math.max(value,(outlineOpacity>0||customVisible)?0.001:0) : 0);
      } else {
        target.drawRimOpacity = overlayVisible && value > 0 ? value : -1;
        target.setDrawOpacity(overlayVisible ? Math.max(overlayOpacity, value > 0 ? 0.001 : 0) : 0);
        target.drawScene();
      }
    };
    update.frame = requestAnimationFrame(() => {
      update.frame = null;
      if (sequence !== overlayUpdateRef.current[kind].sequence) return;
      apply(niivueRef.current);
    });
    update.timer = setTimeout(() => {
      const targets = Object.values(referenceNiivueRefs.current);
      targets.forEach((target, index) => {
        setTimeout(() => {
          if (sequence !== overlayUpdateRef.current[kind].sequence || !target?.drawBitmap) return;
          apply(target);
        }, index * 28);
      });
    }, Math.max(110, delay));
  }

  function toggleOverlay() {
    const nextVisible = !overlayVisible;
    setOverlayVisible(nextVisible);
    scheduleOverlayUpdate("fill", overlayOpacity,0,nextVisible);
    const targets = [niivueRef.current, ...Object.values(referenceNiivueRefs.current)];
    targets.forEach((target) => {
      if (target?.volumes?.[1]) target.setOpacity(1, nextVisible && displayMode === "confidence" ? .72 : 0);
    });
  }

  function updateOutline(nextOpacity) {
    setOutlineOpacity(nextOpacity);
    scheduleOverlayUpdate("outline", nextOpacity);
  }

  function focusLesion() {
    const nv = niivueRef.current;
    if (!nv || !lesionCenterVox) return;
    setView("axial");
    nv.setSliceType(SLICE_TYPE.AXIAL);
    nv.setPan2Dxyzmm([0, 0, 0, 1]);
    nv.scene.crosshairPos = nv.vox2frac(lesionCenterVox, 0);
    setCurrentAxialSlice(Math.round(lesionCenterVox[2]));
    nv.createOnLocationChange();
    nv.drawScene();
    syncCrosshairFrom(nv);
  }

  function componentIntersectsCurrentPlane(component) {
    const nv = niivueRef.current;
    const dims = nv?.volumes?.[0]?.dimsRAS;
    const axis = VIEW_AXIS[view];
    if (!component || !dims || !Number.isInteger(axis) || view === "render" || view === "mpr") return true;
    const voxel = nv.frac2vox(nv.scene.crosshairPos);
    const plane = Math.max(0, Math.min(dims[axis + 1] - 1, Math.round(voxel[axis])));
    const bounds = component.bounds;
    const boundPairs = [[bounds?.minX,bounds?.maxX],[bounds?.minY,bounds?.maxY],[bounds?.minZ,bounds?.maxZ]];
    const [minimum, maximum] = boundPairs[axis];
    if (Number.isFinite(minimum) && (plane < minimum || plane > maximum)) return false;
    const dimX = dims[1], dimY = dims[2], stride = dimX * dimY;
    for (const index of component.voxels) {
      const z = Math.floor(index / stride);
      const within = index - z * stride;
      const y = Math.floor(within / dimX);
      const x = within - y * dimX;
      if ([x,y,z][axis] === plane) return true;
    }
    return false;
  }

  function selectComponent(component, navigate = null) {
    const nv = niivueRef.current;
    const dims = nv?.volumes?.[0]?.dimsRAS;
    if (!component || !dims) return;
    const [x,y,z] = component.center;
    setSelectedComponent(component.number);
    setComponentSelecting(true);
    if (componentHighlightFrameRef.current) cancelAnimationFrame(componentHighlightFrameRef.current);
    componentHighlightFrameRef.current = requestAnimationFrame(() => {
      highlightComponent(component);
      setComponentSelecting(false);
    });
    const shouldNavigate = navigate === true || (navigate == null && !componentIntersectsCurrentPlane(component));
    if (!shouldNavigate) return;
    nv.scene.crosshairPos = [(x+.5)/dims[1], (y+.5)/dims[2], (z+.5)/dims[3]];
    setCurrentAxialSlice(Math.round(z));
    nv.createOnLocationChange();
    nv.drawScene();
    syncCrosshairFrom(nv);
  }

  function highlightComponent(component) {
    const main = niivueRef.current;
    const paint = (target) => {
      if (!target?.drawBitmap) return;
      const previous = highlightedComponentByViewerRef.current.get(target);
      if (previous) for (const index of previous) {
        if (target.drawBitmap[index] === 2) target.drawBitmap[index] = binaryDrawingRef.current?.[index] ? 1 : 0;
      }
      if (component) for (const index of component.voxels) target.drawBitmap[index] = 2;
      target.setDrawColormap(AI_DRAW_LUT);
      target.refreshDrawing(true, false);
      highlightedComponentByViewerRef.current.set(target, component?.voxels || null);
    };
    // Keep component selection responsive by uploading the highlighted 3D
    // bitmap only to the primary canvas. Reference planes retain the complete
    // red AI mask and still follow the selected component's crosshair. The old
    // path uploaded the full mask texture five times for every click.
    paint(main);
    if (componentHighlightFrameRef.current) cancelAnimationFrame(componentHighlightFrameRef.current);
    componentHighlightFrameRef.current = null;
  }

  function moveComponent(direction) {
    if (!components.length) return;
    const index = Math.max(0, components.findIndex((item) => item.number === selectedComponent));
    selectComponent(components[(index + direction + components.length) % components.length]);
  }

  function selectComponentAtCrosshair(event) {
    if (event.detail !== 1 || !components.length || !['axial','coronal','sagittal','render'].includes(view)) return;
    const nv = niivueRef.current;
    const dims = nv?.volumes?.[0]?.dimsRAS;
    if (!nv || !dims) return;
    const voxel = nv.frac2vox(nv.scene.crosshairPos);
    const index = Math.round(voxel[0]) + Math.round(voxel[1]) * dims[1] + Math.round(voxel[2]) * dims[1] * dims[2];
    const component = components.find((item) => {
      const values = item.voxels;
      let low=0, high=values.length-1;
      while(low<=high){const middle=(low+high)>>1;const value=values[middle];if(value===index)return true;if(value<index)low=middle+1;else high=middle-1;}
      return false;
    });
    if (component) selectComponent(component);
  }

  function goToAxialSlice(slice) {
    const nv = niivueRef.current;
    if (!nv?.volumes?.[0] || !axialSlices) return;
    const next = Math.max(0, Math.min(axialSlices - 1, slice));
    setView("axial");
    nv.setSliceType(SLICE_TYPE.AXIAL);
    nv.scene.crosshairPos[2] = (next + 0.5) / axialSlices;
    setCurrentAxialSlice(next);
    nv.createOnLocationChange();
    nv.drawScene();
    syncCrosshairFrom(nv);
  }

  function stepCurrentSlice(direction) {
    const nv = niivueRef.current;
    const axis = VIEW_AXIS[view];
    if (!file || !nv?.volumes?.[0] || !Number.isInteger(axis)) return;
    const total = nv.volumes[0].dimsRAS?.[axis + 1] || 1;
    const current = Math.max(0, Math.min(total - 1, Math.floor((nv.scene.crosshairPos?.[axis] ?? 0.5) * total)));
    const next = Math.max(0, Math.min(total - 1, current + direction));
    nv.scene.crosshairPos[axis] = (next + 0.5) / total;
    if (axis === 2) setCurrentAxialSlice(next);
    nv.createOnLocationChange();
    nv.drawScene();
    syncCrosshairFrom(nv);
  }

  const lesionRanges = lesionSlices.reduce((ranges, slice) => {
    const previous = ranges[ranges.length - 1];
    if (previous && slice === previous.end + 1) previous.end = slice;
    else ranges.push({ start: slice, end: slice });
    return ranges;
  }, []);
  const geometry = studyMeta?.geometry || {};
  const shape = Array.isArray(geometry.shape) ? geometry.shape : [];
  const zooms = Array.isArray(geometry.zooms) ? geometry.zooms : [];
  const patientName = studyMeta?.patient_name || studyMeta?.name || file?.name?.replace(/\.nii(?:\.gz)?$/i, "") || "Không định danh";
  const patientId = studyMeta?.patient_id || studyMeta?.accession_number || studyMeta?.id?.slice?.(0, 10) || "—";
  const sex = studyMeta?.patient_sex || studyMeta?.sex;
  const age = studyMeta?.patient_age || studyMeta?.age;
  const demographics = [sex && ({ M:"Nam", F:"Nữ", O:"Khác" }[String(sex).toUpperCase()] || sex), age && `${age} tuổi`].filter(Boolean).join(", ");
  const sliceThickness = Number(zooms[2]);
  const matrixX = Number(shape[0]) || 512;
  const matrixY = Number(shape[1]) || 512;
  const fovMm = Number.isFinite(Number(zooms[0])) && shape[0] ? Math.round(Number(zooms[0]) * Number(shape[0])) : null;
  const orientation = view === "sagittal" ? { left:"A", right:"P" } : { left:"R", right:"L" };
  const viewLabel = VIEWS.find((item) => item.id === view)?.label || "Axial";
  const modelDisplay = String(modelLabel || "BrainHem ICH");
  const selectedComponentIndex = Math.max(0, components.findIndex((item) => item.number === selectedComponent));
  const componentWindowStart = Math.max(0, Math.min(components.length - 4, selectedComponentIndex - 1));
  const visibleComponents = components.slice(componentWindowStart, componentWindowStart + 4);

  return (
    <section
      className={`clinical-viewer ${file ? "has-study" : "is-empty"}`}
      aria-label="Trình xem CT đa mặt phẳng"
    >
      {file && <header className="viewer-toolbar">
        {onEdit && <button className="viewer-label-action" type="button" disabled={labelingBusy} onClick={onEdit} title="Mở công cụ gán nhãn cho study đang xem"><Icon name="brush" size={16}/> {labelingBusy ? "Đang mở nhãn…" : "Gán nhãn"}</button>}
        {onEdit && <div className="viewer-tool-separator" />}
        <div className="viewer-tool-group view-switcher" aria-label="Kiểu hiển thị">
          <button className={view === "mpr" ? "active" : ""} onClick={() => changeView(VIEWS.find((item) => item.id === "mpr"))} type="button">MPR</button>
        </div>
        <div className="viewer-tool-separator" />
        <div className="viewer-tool-group measurement-tools" aria-label="Công cụ đo khoảng cách">
          <button className={measurementMode?"active":""} type="button" onClick={toggleMeasurement} title="Kéo từ điểm đầu đến điểm cuối để đo khoảng cách thật"><Icon name="measure" size={15}/> Thước</button>
          {selectedMeasurement&&<span className="measurement-delete-help">Chọn đoạn · Delete để xóa</span>}
        </div>
        <div className="viewer-tool-separator" />
        <button className={`reference-dock-toggle ${referenceDockOpen?"active":""}`} type="button" onClick={()=>setReferenceDockOpen(open=>!open)} title={referenceDockOpen?"Ẩn dải ảnh phụ":"Hiện dải ảnh phụ"}>Ảnh phụ</button>
        <div className="reference-picker reference-picker-toolbar">
          <button className={referencePickerOpen ? "active" : ""} type="button" onClick={() => setReferencePickerOpen((open) => !open)} aria-expanded={referencePickerOpen} title="Chọn các mặt phẳng phụ">
            Chọn ảnh phụ <span>▾</span>
          </button>
          {referencePickerOpen && <div className="reference-picker-menu">
            {REFERENCE_VIEWS.map((item) => <label key={item.id}>
              <input type="checkbox" checked={enabledReferenceViews.has(item.id)} disabled={item.id === view} onChange={(event) => setEnabledReferenceViews((current) => {
                const next = new Set(current);
                if (event.target.checked) next.add(item.id); else next.delete(item.id);
                return next;
              })} />
              {item.label}{item.id === view && <small>ảnh chính</small>}
            </label>)}
          </div>}
        </div>
        <div className="viewer-window-control">
        <label className="viewer-select">
          <span>W/L</span>
          <select value={windowKey} onChange={(event) => event.target.value === "custom" ? setWindowPanelOpen(true) : changeWindow(event.target.value)}>
            {Object.entries(WINDOWS).map(([key, preset]) => (
              <option key={key} value={key}>
                {preset.label} · W{preset.width}/L{preset.level}
              </option>
            ))}
            <option value="custom">Tùy chỉnh · W{Math.round(windowValues.width)}/L{Math.round(windowValues.level)}</option>
          </select>
        </label>
        <button className={`window-adjust-toggle ${windowPanelOpen ? "active" : ""}`} type="button" onClick={()=>setWindowPanelOpen(open=>!open)} title="Chỉnh Window/Level">Chỉnh</button>
        {windowPanelOpen&&<div className="window-adjust-panel">
          <header><strong>Window / Level</strong><button type="button" onClick={()=>setWindowPanelOpen(false)} aria-label="Đóng">×</button></header>
          <label><span>Window (W)</span><input type="number" min="1" max="4000" value={Math.round(windowValues.width)} onChange={event=>changeCustomWindow("width",event.target.value)}/></label>
          <input aria-label="Window width" type="range" min="1" max="4000" step="1" value={windowValues.width} onChange={event=>changeCustomWindow("width",event.target.value)}/>
          <label><span>Level (L)</span><input type="number" min="-1000" max="2000" value={Math.round(windowValues.level)} onChange={event=>changeCustomWindow("level",event.target.value)}/></label>
          <input aria-label="Window level" type="range" min="-1000" max="2000" step="1" value={windowValues.level} onChange={event=>changeCustomWindow("level",event.target.value)}/>
          <small>Kéo thanh để xem thay đổi trực tiếp trên tất cả mặt cắt.</small>
        </div>}
        </div>
        <div className="viewer-toolbar-spacer" />
        <button
          className="focus-lesion"
          disabled={!lesionCenterVox || !overlayVisible}
          onClick={focusLesion}
          type="button"
          title="Về kích thước vừa màn hình và mở lát Axial có vùng AI lớn nhất"
        >
          {overlayVisible && lesionCenterVox ? `Vùng AI · lát ${Math.round(lesionCenterVox[2]) + 1}` : "Vùng AI"}
        </button>
        <div className="ai-display-mode" aria-label="Cách hiển thị kết quả AI">
          <button className={displayMode==="components"&&overlayVisible?"active":""} disabled={!overlayVisible} type="button" onClick={()=>setDisplayMode("components")}>Ổ 3D</button>
          <button className={displayMode==="confidence"&&overlayVisible?"active":""} disabled={!probabilityUrl||!overlayVisible} type="button" onClick={()=>setDisplayMode("confidence")} title={probabilityUrl?"Vàng là sát ngưỡng, đỏ đậm là xác suất voxel cao":"Ca cũ chưa lưu probability map"}>Xác suất voxel</button>
        </div>
        <label className="threshold-control" title="Voxel có xác suất từ ngưỡng này được đưa vào mask và phân thành các ổ 3D">
          <span>Ngưỡng</span><input disabled={!probabilityUrl || !overlayVisible} type="range" min="0.05" max="0.95" step="0.05" value={thresholdPreview} onChange={event=>{setThresholdQueued(true);setThresholdPreview(Number(event.target.value));}} onPointerUp={()=>setThreshold(thresholdPreview)} onKeyUp={()=>setThreshold(thresholdPreview)} onBlur={()=>setThreshold(thresholdPreview)}/><b>{thresholdPreview.toFixed(2)}</b>
        </label>
        <button
          className={`overlay-toggle ${overlayVisible && maskUrl ? "active" : ""}`}
          disabled={!maskUrl}
          onClick={toggleOverlay}
          type="button"
          aria-pressed={overlayVisible}
          aria-label={overlayVisible ? "Ẩn lớp phủ AI" : "Hiện lớp phủ AI"}
        >
          <span className="overlay-swatch" />
          {overlayVisible ? "Ẩn AI" : "Hiện AI"}
        </button>
        <label className="opacity-control" title="Độ trong suốt mask">
          <span>Vùng</span>
          <input
            aria-label="Độ trong suốt mask"
            disabled={!maskUrl || !overlayVisible}
            max="1"
            min="0"
            onChange={(event) => updateOverlay(Number(event.target.value))}
            step="0.05"
            type="range"
            value={overlayOpacity}
          />
          <b>{Math.round(overlayOpacity * 100)}%</b>
        </label>
        <label className="opacity-control outline-opacity-control" title="Độ rõ đường biên AI">
          <span>Biên</span>
          <input aria-label="Độ rõ đường biên AI" disabled={!maskUrl || !overlayVisible} max="1" min="0" onChange={(event) => updateOutline(Number(event.target.value))} step="0.05" type="range" value={outlineOpacity} />
          <b>{Math.round(outlineOpacity * 100)}%</b>
        </label>
      </header>}

      <div className={`viewer-diagnostic-layout ${file ? "with-references" : ""} ${referenceDockOpen?"":"references-collapsed"}`} style={file ? { gridTemplateColumns: referenceDockOpen ? `minmax(0, 1fr) ${referenceWidth}px` : "minmax(0, 1fr) 0" } : undefined}>
      <div className={`viewer-stage viewer-stage-primary ${measurementMode?"is-measuring":""}`} onClick={measurementMode?undefined:selectComponentAtCrosshair} onDoubleClick={toggleCrosshairLock} onContextMenu={openComponentMenu} title={file ? (measurementMode?"Giữ và kéo từ điểm đầu đến điểm cuối để đo":"Rê chuột để định vị · Click vùng đỏ để chọn ổ · Nhấp đúp để ghim") : undefined}>
        <canvas ref={canvasRef} className={!file ? "is-empty" : ""} onContextMenu={(event) => event.preventDefault()} />
        {measurementMode&&<svg className="measurement-overlay" onPointerDown={beginMeasure} onPointerMove={moveMeasure} onPointerUp={endMeasure} onPointerCancel={endMeasure}>{[...measurements,...(measurementDraft?[measurementDraft]:[])].map((item,index)=>{const id=item.id||"draft",selected=id===selectedMeasurement, distance=measurementDistance(item.start,item.end);return <g key={id} className={selected?"selected":""} onPointerDown={event=>{event.stopPropagation();if(item.id)setSelectedMeasurement(item.id);}}><line x1={item.start.x} y1={item.start.y} x2={item.end.x} y2={item.end.y}/>{item.id&&<><circle className="measure-handle" cx={item.start.x} cy={item.start.y} r="7" onPointerDown={event=>{setSelectedMeasurement(id);updateMeasurePoint(id,"start",event);}}/><circle className="measure-handle" cx={item.end.x} cy={item.end.y} r="7" onPointerDown={event=>{setSelectedMeasurement(id);updateMeasurePoint(id,"end",event);}}/></>}<text x={(item.start.x+item.end.x)/2} y={(item.start.y+item.end.y)/2-10}>{(distance/10).toFixed(2)} cm · {distance.toFixed(1)} mm</text></g>})}</svg>}
        {file&&measurementMode&&<div className="measurement-hint"><Icon name="measure" size={14}/><span>Kéo giữa hai điểm để đo · kéo đầu mút để chỉnh</span>{selectedMeasurement&&<strong>Đã chọn · Delete để xóa</strong>}</div>}
        {file && crosshairLocked && <div className="viewer-crosshair-lock">● Điểm đã ghim · Nhấp đúp để bỏ ghim</div>}
        {focusedComponent&&<button className="component-focus-exit" type="button" onClick={exitComponentFocus}>Thoát focus · Esc</button>}
        {componentMenu&&<div className="label-reference-context-menu clinical-component-menu" role="menu" style={{left:componentMenu.x,top:componentMenu.y}} onClick={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()} onPointerDown={event=>event.stopPropagation()}><strong>{selectedComponent?`Component C${selectedComponent}`:"Chọn component"}</strong><button type="button" disabled={!selectedComponent} onClick={spotlightComponent}>Focus · Esc để thoát</button>{selectedComponent&&(()=>{const component=components.find(c=>c.number===selectedComponent),key=component?.key??String(selectedComponent),style=componentStyles[key]||{};return <><label className="component-style-control">Alpha <output>{Math.round((style.fill??overlayOpacity)*100)}%</output><input aria-label="Alpha component" type="range" min="0" max="1" step=".01" value={style.fill??overlayOpacity} onChange={e=>setComponentStyle("fill",e.target.value)}/></label><label className="component-style-control">Đường biên <output>{Math.round((style.rim??outlineOpacity)*100)}%</output><input aria-label="Đường biên component" type="range" min="0" max="1" step=".01" value={style.rim??outlineOpacity} onChange={e=>setComponentStyle("rim",e.target.value)}/></label><button type="button" onClick={()=>setComponentStyles(previous=>{const next={...previous};delete next[key];return next;})}>Đặt lại hiển thị</button></>;})()}{onEdit&&<button type="button" onClick={()=>{setComponentMenu(null);onEdit();}}>Chỉnh sửa / xóa nhãn…</button>}<small>Mask AI chỉ đọc. Chỉnh sửa và lưu trong Gán nhãn.</small></div>}
        {!file && <ViewerEmptyState />}
        {loading && (
          <div className="viewer-loading" role="status">
            <span className="viewer-spinner" />
            Đang giải mã thể tích CT…
          </div>
        )}
        {file && processing && !loading && (
          <div className="analysis-banner" role="status">
            <span className="viewer-spinner" />
            <div>
              <strong>AI đang tự phân tích</strong>
              <small>{processingLabel || "Bạn không cần thao tác thêm"}</small>
            </div>
            <b>{Math.max(0, Math.min(Number(processingProgress) || 0, 99))}%</b>
          </div>
        )}
        {error && <div className="viewer-error" role="alert">{error}</div>}
        {file && (
          <>
            <div className="diagnostic-meta diagnostic-meta-patient">
              <strong>Bệnh nhân: {patientName}</strong>
              <span>ID: {patientId}</span>
              {demographics && <span>{demographics}</span>}
              <span>Series: {studyMeta?.series_number || 1} · {studyMeta?.study_description || "Non-contrast CT"}</span>
              <span>Image: {currentAxialSlice + 1} / {axialSlices || shape[2] || "—"}</span>
            </div>
            <div className="diagnostic-meta diagnostic-meta-acquisition">
              <strong className="diagnostic-model-provenance" title={modelLabel}>AI: {modelDisplay}</strong>
              <span>{formatStudyDate(studyMeta?.study_date)}</span>
              {Number.isFinite(sliceThickness) && <span>Slice: {sliceThickness.toFixed(1)} mm</span>}
              <span>{matrixX} × {matrixY}</span>
            </div>
            {view !== "mpr" && view !== "render" && <><span className="diagnostic-orientation diagnostic-orientation-left">{orientation.left}</span><span className="diagnostic-orientation diagnostic-orientation-right">{orientation.right}</span></>}
            <div className="diagnostic-view-meta"><strong>{viewLabel}</strong>{fovMm && <span>FOV: {fovMm} mm</span>}</div>
            <div className="viewer-series-label viewer-source-chip"><span>{sourceLabel}</span></div>
            {maskUrl && overlayVisible && (
            <div className="viewer-overlay-legend">
              <span />
                AI segmentation · Ảnh chính: Ctrl + cuộn đổi lát
                {volumeMl != null && <strong>{Number(volumeMl).toFixed(2)} mL</strong>}
              </div>
            )}
            {overlayVisible&&displayMode==="confidence"&&probabilityUrl&&<div className="confidence-legend"><span>Sát ngưỡng</span><i/><span>Cao</span><small>Probability tại từng voxel · không phải độ tin cậy chẩn đoán của cả ca</small></div>}
            {overlayVisible&&displayMode==="components"&&components.length>0&&!thresholdQueued&&!componentBusy&&!componentSelecting&&<div className="component-navigator" aria-label="Các component xuất huyết 3D">
              <button type="button" onClick={()=>moveComponent(-1)} aria-label="Ổ trước">‹</button>
              <strong>{selectedComponent ? `${componentId(components.find(item=>item.number===selectedComponent))} · ${selectedComponent}/${components.length}` : `${components.length} ổ`}</strong>
              {selectedComponent>0?<button className="component-go" type="button" onClick={()=>selectComponent(components.find(item=>item.number===selectedComponent),true)}>Đến ổ</button>:<span className="component-go-spacer"/>}
              <button type="button" onClick={()=>moveComponent(1)} aria-label="Ổ sau">›</button>
              <div>{visibleComponents.map(item=><button key={item.key} className={item.number===selectedComponent?"active":""} onClick={()=>selectComponent(item)} onDoubleClick={()=>selectComponent(item,true)} title={`${componentId(item)} · ${item.volumeMl.toFixed(2)} mL · ${componentSliceText(item)} · nhấp đúp để đến tâm ổ`}><b>{componentId(item)}</b><span>{item.volumeMl.toFixed(2)} mL</span><small>{componentSliceText(item)}</small></button>)}</div>
            </div>}
            {overlayVisible&&(thresholdQueued||componentBusy||componentSelecting)&&displayMode==="components"&&<span className="component-processing">{componentSelecting?"Đang làm nổi ổ đã chọn…":thresholdQueued?"Đang áp dụng ngưỡng…":"Đang tách ổ 3D…"}</span>}
          </>
        )}
      </div>
      {file && (
        <aside className="reference-views" aria-label="Các mặt phẳng tham chiếu">
          <button className="reference-resize-handle" type="button" aria-label="Kéo để đổi chiều rộng dải ảnh phụ" onPointerDown={beginReferenceResize} onPointerMove={moveReferenceResize} onPointerUp={endReferenceResize} onPointerCancel={endReferenceResize} />
          {REFERENCE_VIEWS.map((item) => (
            <div key={item.id} ref={(node) => { referenceCardRefs.current[item.id] = node; }} className={`reference-view ${view === item.id ? "current" : ""}`} role="button" tabIndex={0} aria-label={`Đưa ${item.label} lên ảnh chính`} onDoubleClick={() => changeView(item)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); changeView(item); } }} onContextMenu={(event) => { event.preventDefault(); setReferenceMenu({ item, x: event.clientX, y: event.clientY }); }} title={`Nhấp đúp để đưa ${item.label} thành ảnh chính`}>
              <canvas className={!enabledReferenceViews.has(item.id) ? "reference-hidden" : ""} ref={(node) => { referenceCanvasRefs.current[item.id] = node; }} onWheelCapture={(event) => zoomReference(item, event)} onContextMenu={(event) => event.preventDefault()} />
              <span>{item.label}<small>{view === item.id ? "Đang là ảnh chính" : "Nhấp đúp để phóng lớn"}</small></span>
              <button className="reference-fullscreen" type="button" aria-label={`Toàn màn hình ${item.label}`} title="Toàn màn hình" onClick={(event) => { event.stopPropagation(); fullscreenReference(item); }}>⛶</button>
            </div>
          ))}
          <div className="reference-help">Cuộn để zoom · Chuột phải mở tùy chọn</div>
        </aside>
      )}
      {referenceMenu && <div className="reference-context-menu" role="menu" style={{ left: referenceMenu.x, top: referenceMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
        <strong>{referenceMenu.item.label}</strong>
        <button type="button" onClick={() => { changeView(referenceMenu.item); setReferenceMenu(null); }}>Đưa lên ảnh chính</button>
        <button type="button" onClick={() => { fullscreenReference(referenceMenu.item); setReferenceMenu(null); }}>Mở toàn màn hình</button>
        <button type="button" onClick={() => { resetReference(referenceMenu.item); setReferenceMenu(null); }}>Đặt lại zoom/góc nhìn</button>
        <button className="danger" type="button" onClick={() => hideReference(referenceMenu.item)}>Ẩn view này</button>
      </div>}
      </div>

      {file && <footer className="viewer-statusbar">
        <span>W {Math.round(windowValues.width)} / L {Math.round(windowValues.level)}</span>
        <div className="clinical-lesion-track" title={overlayVisible ? "Đỏ: các lát Axial có vùng AI. Bấm để đi tới tổn thương" : "Hiện AI để xem vị trí các vùng gợi ý"}>
          <span className="clinical-track-line" />
          {overlayVisible&&lesionRanges.map((range) => <button key={`${range.start}-${range.end}`} type="button" aria-label={`Tổn thương từ lát ${range.start + 1} đến ${range.end + 1}`} onClick={() => goToAxialSlice(Math.round((range.start + range.end) / 2))} style={{ left: `${axialSlices > 1 ? range.start / (axialSlices - 1) * 100 : 0}%`, width: `${Math.max(0.8, axialSlices > 1 ? (range.end - range.start + 1) / axialSlices * 100 : 1)}%` }} />)}
          {view === "axial" && axialSlices > 1 && <i style={{ left: `${Math.max(0, Math.min(100, currentAxialSlice / (axialSlices - 1) * 100))}%` }} />}
        </div>
        <b className="viewer-slice-position">Lát {currentAxialSlice + 1}/{axialSlices}</b>
        <span className="viewer-wheel-help">←/→ đổi lát · Ctrl + ←/→ đổi ca · Ctrl + cuộn đổi lát</span>
        <span>
          X {location.mm[0]?.toFixed?.(1) ?? "—"} · Y {location.mm[1]?.toFixed?.(1) ?? "—"} ·
          Z {location.mm[2]?.toFixed?.(1) ?? "—"} mm
        </span>
        <span>HU {location.hu != null ? Math.round(location.hu) : "—"}</span>
        <span className="viewer-engine">NiiVue · WebGL2</span>
      </footer>}
    </section>
  );
}
