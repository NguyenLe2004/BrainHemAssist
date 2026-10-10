from __future__ import annotations

import io
import shutil
import zipfile
from pathlib import Path
from typing import Any

import requests
import pydicom

from .series_selection import SeriesCandidate, select_head_ct_series


class OrthancError(RuntimeError):
    pass


class OrthancClient:
    def __init__(self, base_url: str, username: str = "", password: str = "") -> None:
        self.base_url = base_url.rstrip("/")
        self.auth = (username, password) if username else None

    @property
    def configured(self) -> bool:
        return bool(self.base_url)

    def _get(self, path: str, *, timeout: int = 30) -> requests.Response:
        try:
            response = requests.get(
                f"{self.base_url}{path}", auth=self.auth, timeout=timeout
            )
            response.raise_for_status()
            return response
        except requests.RequestException as exc:
            raise OrthancError(f"Orthanc request failed: {exc}") from exc

    def store_instances(self, paths: list[Path]) -> dict[str, Any]:
        """Store a generated modality series through Orthanc's DICOM ingest API."""
        if not paths:
            raise OrthancError("No DICOM instances were supplied")
        first_instance_id = ""
        try:
            for path in paths:
                with path.open("rb") as stream:
                    response = requests.post(
                        f"{self.base_url}/instances",
                        data=stream,
                        headers={"Content-Type": "application/dicom"},
                        auth=self.auth,
                        timeout=60,
                    )
                response.raise_for_status()
                payload = response.json()
                first_instance_id = first_instance_id or payload.get("ID", "")
        except (OSError, ValueError, requests.RequestException) as exc:
            raise OrthancError(f"DICOM store failed: {exc}") from exc
        if not first_instance_id:
            raise OrthancError("Orthanc did not return a stored instance ID")
        instance = self._get(f"/instances/{first_instance_id}").json()
        series_id = instance.get("ParentSeries", "")
        if not series_id:
            raise OrthancError("Stored instance has no parent series")
        series = self._get(f"/series/{series_id}").json()
        study_id = series.get("ParentStudy", "")
        if not study_id:
            raise OrthancError("Stored series has no parent study")
        return {
            "orthanc_study_id": study_id,
            "orthanc_series_id": series_id,
            "instances_sent": len(paths),
        }

    def list_studies(self, limit: int = 50) -> list[dict[str, Any]]:
        study_ids = self._get("/studies").json()[-limit:]
        studies: list[dict[str, Any]] = []
        for study_id in reversed(study_ids):
            study = self._get(f"/studies/{study_id}").json()
            tags = study.get("PatientMainDicomTags", {}) | study.get("MainDicomTags", {})
            studies.append(
                {
                    "orthanc_id": study_id,
                    "study_instance_uid": tags.get("StudyInstanceUID", ""),
                    "patient_id": tags.get("PatientID", ""),
                    "patient_name": tags.get("PatientName", ""),
                    "study_date": tags.get("StudyDate", ""),
                    "study_description": tags.get("StudyDescription", ""),
                    "accession_number": tags.get("AccessionNumber", ""),
                    "series_count": len(study.get("Series", [])),
                    "is_stable": bool(study.get("IsStable", False)),
                    "last_update": study.get("LastUpdate", ""),
                }
            )
        return studies

    def get_study_summary(self, study_id: str) -> dict[str, Any]:
        study = self._get(f"/studies/{study_id}").json()
        tags = study.get("PatientMainDicomTags", {}) | study.get("MainDicomTags", {})
        return {
            "orthanc_id": study_id,
            "study_instance_uid": tags.get("StudyInstanceUID", ""),
            "is_stable": bool(study.get("IsStable", False)),
        }

    def select_series(self, study_id: str) -> SeriesCandidate:
        study = self._get(f"/studies/{study_id}").json()
        if study.get("IsStable") is False:
            raise OrthancError(
                "Study DICOM chưa ổn định; hãy đợi PACS nhận đủ ảnh rồi thử lại"
            )
        series = [self._get(f"/series/{series_id}").json() for series_id in study.get("Series", [])]
        return select_head_ct_series(series)

    def download_series(self, series_id: str, target_dir: Path) -> list[Path]:
        response = self._get(f"/series/{series_id}/archive", timeout=180)
        target_dir.mkdir(parents=True, exist_ok=False)
        try:
            with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                members = [item for item in archive.infolist() if not item.is_dir()]
                for member in members:
                    name = Path(member.filename)
                    if name.is_absolute() or ".." in name.parts:
                        raise OrthancError("Orthanc archive contains an unsafe path")
                    destination = target_dir / name
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(member) as source, destination.open("wb") as output:
                        shutil.copyfileobj(source, output)
        except (zipfile.BadZipFile, OSError) as exc:
            shutil.rmtree(target_dir, ignore_errors=True)
            raise OrthancError(f"Could not extract Orthanc series: {exc}") from exc
        files = sorted(path for path in target_dir.rglob("*") if path.is_file())
        if not files:
            raise OrthancError("Orthanc returned an empty series archive")
        return files


def dicom_series_to_nifti(
    source_dir: Path, series_instance_uid: str, output_path: Path
) -> None:
    """Convert one selected DICOM series while preserving patient geometry."""
    try:
        import SimpleITK as sitk
    except ImportError as exc:
        raise OrthancError("SimpleITK is required for DICOM ingestion") from exc

    selected_files: list[str] = []
    directories = [source_dir, *(path for path in source_dir.rglob("*") if path.is_dir())]
    for directory in directories:
        if not any(path.is_file() for path in directory.iterdir()):
            continue
        try:
            identifiers = sitk.ImageSeriesReader.GetGDCMSeriesIDs(str(directory)) or []
        except RuntimeError:
            continue
        for identifier in identifiers:
            if not series_instance_uid or identifier == series_instance_uid:
                selected_files = list(
                    sitk.ImageSeriesReader.GetGDCMSeriesFileNames(str(directory), identifier)
                )
                if selected_files:
                    break
        if selected_files:
            break
    if not selected_files:
        raise OrthancError("Downloaded archive does not contain the selected DICOM series")
    reader = sitk.ImageSeriesReader()
    reader.SetFileNames(selected_files)
    reader.MetaDataDictionaryArrayUpdateOn()
    reader.LoadPrivateTagsOff()
    try:
        image = reader.Execute()
    except RuntimeError as exc:
        raise OrthancError(f"Could not reconstruct CT volume: {exc}") from exc
    if image.GetDimension() != 3 or image.GetSize()[2] < 2:
        raise OrthancError(f"Expected a 3D CT series, got size {image.GetSize()}")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sitk.WriteImage(image, str(output_path), True)


def inspect_uploaded_dicom(source_dir: Path) -> tuple[SeriesCandidate, dict[str, str]]:
    """Validate one uploaded DICOM study and select its diagnostic head CT series."""
    grouped: dict[str, dict[str, Any]] = {}
    study_uids: set[str] = set()
    for path in source_dir.rglob("*"):
        if not path.is_file():
            continue
        try:
            # Some PACS exports omit the 128-byte preamble and DICM marker.
            # Forced header parsing is safe here because identity and CT tags are
            # still required below before a file can enter the selected series.
            dataset = pydicom.dcmread(path, stop_before_pixels=True, force=True)
        except Exception:
            continue
        series_uid = str(getattr(dataset, "SeriesInstanceUID", "") or "").strip()
        study_uid = str(getattr(dataset, "StudyInstanceUID", "") or "").strip()
        if not series_uid or not study_uid:
            continue
        study_uids.add(study_uid)
        entry = grouped.setdefault(
            series_uid,
            {
                "ID": series_uid,
                "Instances": [],
                "MainDicomTags": {
                    "Modality": str(getattr(dataset, "Modality", "") or ""),
                    "SeriesDescription": str(getattr(dataset, "SeriesDescription", "") or ""),
                    "ProtocolName": str(getattr(dataset, "ProtocolName", "") or ""),
                    "SeriesInstanceUID": series_uid,
                    "ImageType": list(getattr(dataset, "ImageType", []) or []),
                    "SliceThickness": str(getattr(dataset, "SliceThickness", "") or ""),
                    "ConvolutionKernel": str(getattr(dataset, "ConvolutionKernel", "") or ""),
                },
                "dataset": dataset,
            },
        )
        entry["Instances"].append(path.name)
    if not grouped:
        raise OrthancError("Không tìm thấy ảnh DICOM có Study/Series hợp lệ")
    if len(study_uids) != 1:
        raise OrthancError("Mỗi lần chỉ tiếp nhận một DICOM Study")
    candidate = select_head_ct_series(grouped.values())
    dataset = grouped[candidate.series_instance_uid]["dataset"]
    metadata = {
        "study_instance_uid": str(getattr(dataset, "StudyInstanceUID", "") or ""),
        "series_instance_uid": candidate.series_instance_uid,
        "patient_id": str(getattr(dataset, "PatientID", "") or ""),
        "patient_name": str(getattr(dataset, "PatientName", "") or ""),
        "study_date": str(getattr(dataset, "StudyDate", "") or ""),
        "study_description": str(getattr(dataset, "StudyDescription", "") or ""),
        "accession_number": str(getattr(dataset, "AccessionNumber", "") or ""),
        "series_description": candidate.description,
    }
    return candidate, metadata
