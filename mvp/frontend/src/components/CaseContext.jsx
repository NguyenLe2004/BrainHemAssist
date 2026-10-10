import React from "react";
import "./CaseContext.css";

/**
 * CaseContext - Compact dark medical CT research annotation header
 * Matches existing AnnotationWorkspace styling and visual conventions.
 *
 * @param {Object} props
 * @param {Object} props.caseItem - Selected case object
 * @param {Object} [props.windowPreset] - Active window preset { label, width, level }
 * @param {string} [props.activeTool] - Active tool id ('pointer', 'brush', 'fill', 'eraser')
 * @param {number} [props.displayedRevision] - Currently displayed revision number
 * @param {boolean} [props.dirty] - Whether there are unsaved drawing modifications
 */
export default function CaseContext({
  caseItem,
  windowPreset,
  activeTool,
  displayedRevision,
  dirty,
}) {
  if (!caseItem) {
    return null;
  }

  const caseName = caseItem.name || "Ca chụp CT";
  const caseId = caseItem.id || "";
  const shortCaseId = caseId.length > 8 ? caseId.slice(0, 8) : caseId;

  // Source PACS if series_instance_uid else NIfTI nghiên cứu
  const hasSeriesUid = Boolean(caseItem.series_instance_uid);
  const sourceLabel = hasSeriesUid ? "PACS" : "NIfTI nghiên cứu";

  // Series ID if present
  const seriesId = caseItem.series_instance_uid || caseItem.series_id || "";
  const shortSeriesId =
    seriesId.length > 18
      ? `${seriesId.slice(0, 8)}…${seriesId.slice(-6)}`
      : seriesId;

  // Voxel spacing from geometry.zooms in mm
  const zooms = caseItem.geometry?.zooms;
  let voxelSpacing = null;
  if (Array.isArray(zooms) && zooms.length > 0) {
    voxelSpacing = `${zooms
      .slice(0, 3)
      .map((val) => {
        const n = Number(val);
        return Number.isNaN(n) ? String(val) : parseFloat(n.toFixed(2));
      })
      .join(" × ")} mm`;
  }

  // Current displayed revision (0 means "Chưa đánh giá", never 0mL)
  const isUnassessed =
    displayedRevision === 0 ||
    displayedRevision === null ||
    displayedRevision === undefined;
  const revisionLabel = isUnassessed
    ? "Chưa đánh giá"
    : `Rev ${displayedRevision}`;

  // Mode: "Xem ảnh" if pointer else "Đang chỉnh nhãn"
  const isPointer = activeTool === "pointer";
  const modeLabel = isPointer ? "Xem ảnh" : "Đang chỉnh nhãn";

  // Window preset
  const windowLabel = windowPreset?.label || "Mặc định";
  const windowWidth =
    windowPreset?.width !== undefined && windowPreset?.width !== null
      ? windowPreset.width
      : "—";
  const windowLevel =
    windowPreset?.level !== undefined && windowPreset?.level !== null
      ? windowPreset.level
      : "—";

  return (
    <header
      className="case-context-bar"
      role="region"
      aria-label="Thông tin ca chụp và cấu hình hiển thị"
    >
      <div className="case-context-section case-context-primary">
        <span className="case-context-badge case-context-case-tag" aria-label="Loại ảnh chụp">
          CT
        </span>
        <strong className="case-context-name" title={caseName}>
          {caseName}
        </strong>
        {caseId && (
          <span
            className="case-context-id"
            title={caseId}
            aria-label={`Mã định danh ca: ${caseId}`}
          >
            #{shortCaseId}
          </span>
        )}
        <span
          className={`case-context-badge case-context-source ${
            hasSeriesUid ? "source-pacs" : "source-nifti"
          }`}
          title={`Nguồn dữ liệu ca chụp: ${sourceLabel}`}
        >
          {sourceLabel}
        </span>
        {seriesId && (
          <div
            className="case-context-item case-context-series"
            title={`Series Instance UID: ${seriesId}`}
          >
            <span className="case-context-kicker">Series:</span>
            <span className="case-context-mono">{shortSeriesId}</span>
          </div>
        )}
      <div className="case-context-section case-context-convention-wrap">
        <span
          className="case-context-convention"
          title="Quy ước hiển thị chuẩn X quang (Bên phải bệnh nhân hiển thị ở bên trái màn hình)"
        >
          Quy ước hiển thị: X quang
        </span>
      </div>
      </div>

      <div className="case-context-section case-context-details">
        {voxelSpacing && (
          <div
            className="case-context-item"
            title={`Kích thước voxel (voxel spacing): ${voxelSpacing}`}
          >
            <span className="case-context-kicker">Voxel:</span>
            <span className="case-context-value">{voxelSpacing}</span>
          </div>
        )}

        <div
          className="case-context-item"
          title={`Phiên bản chú thích đang hiển thị: ${revisionLabel}`}
        >
          <span className="case-context-kicker">Phiên bản:</span>
          <span
            className={`case-context-revision-badge ${
              isUnassessed ? "unassessed" : "active-rev"
            }`}
          >
            {revisionLabel}
          </span>
        </div>


        <span
          className={`case-context-badge case-context-mode ${
            isPointer ? "mode-view" : "mode-edit"
          }`}
          title={`Chế độ thao tác hiện hành: ${modeLabel}`}
        >
          <span className="case-context-kicker">Chế độ:</span> {modeLabel}
        </span>

        <div
          className="case-context-item case-context-label-info"
          title="Mục tiêu phân vùng y khoa"
        >
          <span className="case-context-dot" aria-hidden="true" />
          <span className="case-context-label-text">
            Nhãn: vùng xuất huyết (nhị phân)
          </span>
        </div>

        <div
          className="case-context-item case-context-window"
          title={`Cửa sổ ảnh cắt lớp: ${windowLabel} (Độ rộng WW: ${windowWidth}, Mức sáng WL: ${windowLevel})`}
        >
          <span className="case-context-kicker">Cửa sổ ảnh:</span>
          <span className="case-context-value">
            {windowLabel} (WW/{windowWidth} WL/{windowLevel})
          </span>
        </div>
      </div>


    </header>
  );
}
