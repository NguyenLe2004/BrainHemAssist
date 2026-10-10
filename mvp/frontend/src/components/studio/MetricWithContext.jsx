import React from "react";

export default function MetricWithContext({
  label,
  value,
  unit = "",
  cohortName = "",
  studyCount = null,
  delta = null,
  lowerIsBetter = false,
  digits = 3,
  compact = false,
  className = "",
}) {
  let displayValue = "—";
  if (typeof value === "number" && Number.isFinite(value)) {
    displayValue = value.toLocaleString("vi-VN", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  } else if (value !== undefined && value !== null && value !== "") {
    displayValue = String(value);
  }

  // Delta computation with semantic coloring
  let deltaNode = null;
  if (typeof delta === "number" && Number.isFinite(delta) && delta !== 0) {
    const isPositive = delta > 0;
    const isGood = lowerIsBetter ? !isPositive : isPositive;
    const sign = isPositive ? "+" : "";
    const formattedDelta = `${sign}${delta.toLocaleString("vi-VN", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })}`;

    deltaNode = (
      <span className={`sw-metric-delta ${isGood ? "good" : "bad"}`}>
        {isPositive ? "▲" : "▼"} {formattedDelta}
      </span>
    );
  }

  return (
    <div className={`sw-metric-card ${compact ? "compact" : ""} ${className}`}>
      <span className="sw-metric-label">{label}</span>
      <div className="sw-metric-value-row">
        <strong className="sw-metric-val">{displayValue}</strong>
        {unit && displayValue !== "—" && <em className="sw-metric-unit">{unit}</em>}
        {deltaNode}
      </div>
      {(cohortName || studyCount !== null) && (
        <div className="sw-metric-context">
          {cohortName && <span className="sw-metric-cohort">{cohortName}</span>}
          {studyCount !== null && (
            <small className="sw-metric-studies">
              {studyCount.toLocaleString("vi-VN")} studies
            </small>
          )}
        </div>
      )}
    </div>
  );
}
