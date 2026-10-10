from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable


class NoEligibleSeries(ValueError):
    pass


@dataclass(frozen=True)
class SeriesCandidate:
    orthanc_id: str
    series_instance_uid: str
    description: str
    protocol_name: str
    modality: str
    image_count: int
    slice_thickness_mm: float | None
    convolution_kernel: str
    image_type: str
    score: int


def _text(tags: dict[str, Any], key: str) -> str:
    value = tags.get(key, "")
    if isinstance(value, list):
        return "\\".join(str(item) for item in value)
    return str(value or "").strip()


def _number(tags: dict[str, Any], key: str) -> float | None:
    try:
        return float(_text(tags, key))
    except (TypeError, ValueError):
        return None


def rank_head_ct_series(series_items: Iterable[dict[str, Any]]) -> list[SeriesCandidate]:
    """Rank diagnostic axial non-contrast head CT series conservatively.

    The rules intentionally reject localizers, derived/reformatted images and
    contrast-enhanced studies. Ambiguous studies remain visible in the worklist
    but require explicit user selection instead of silently analyzing the wrong
    series.
    """

    candidates: list[SeriesCandidate] = []
    for item in series_items:
        tags = item.get("MainDicomTags", item.get("tags", {})) or {}
        modality = _text(tags, "Modality").upper()
        if modality != "CT":
            continue
        description = _text(tags, "SeriesDescription")
        protocol = _text(tags, "ProtocolName")
        image_type = _text(tags, "ImageType").upper()
        combined = f"{description} {protocol} {image_type}".lower()
        if any(word in combined for word in ("localizer", "scout", "topogram", "scanogram")):
            continue
        if any(word in combined for word in ("mpr", "coronal", "sagittal", "3d", "derived", "reformat")):
            continue
        is_noncontrast = any(
            word in combined
            for word in ("non contrast", "noncontrast", "without contrast", "wo contrast", "ncct", "plain")
        )
        if not is_noncontrast and any(
            word in combined for word in ("contrast", "post contrast", "with contrast", "cta", "angio")
        ):
            continue

        count = int(item.get("Instances") and len(item["Instances"]) or item.get("image_count") or 0)
        thickness = _number(tags, "SliceThickness")
        score = 0
        if any(word in combined for word in ("head", "brain", "cranium", "sọ", "não")):
            score += 40
        if is_noncontrast:
            score += 25
        if "primary" in image_type or "original" in image_type:
            score += 15
        if count >= 20:
            score += 10
        if thickness is not None and 0.5 <= thickness <= 6.0:
            score += 10

        candidates.append(
            SeriesCandidate(
                orthanc_id=str(item.get("ID") or item.get("orthanc_id") or ""),
                series_instance_uid=_text(tags, "SeriesInstanceUID"),
                description=description,
                protocol_name=protocol,
                modality=modality,
                image_count=count,
                slice_thickness_mm=thickness,
                convolution_kernel=_text(tags, "ConvolutionKernel"),
                image_type=image_type,
                score=score,
            )
        )
    return sorted(candidates, key=lambda value: (value.score, value.image_count), reverse=True)


def select_head_ct_series(series_items: Iterable[dict[str, Any]]) -> SeriesCandidate:
    ranked = rank_head_ct_series(series_items)
    if not ranked:
        raise NoEligibleSeries("Không tìm thấy series CT đầu chẩn đoán phù hợp")
    best = ranked[0]
    if best.score < 50:
        raise NoEligibleSeries(
            "Không thể tự tin xác định NCCT đầu; cần bác sĩ chọn series thủ công"
        )
    if len(ranked) > 1 and ranked[1].score == best.score and ranked[1].image_count == best.image_count:
        raise NoEligibleSeries(
            "Có nhiều series CT đầu tương đương; cần bác sĩ chọn series thủ công"
        )
    return best
