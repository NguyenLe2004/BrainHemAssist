from __future__ import annotations

from datetime import datetime
from pathlib import Path
import shutil
import subprocess

import numpy as np
import pydicom
import SimpleITK as sitk
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import (
    CTImageStorage,
    ExplicitVRLittleEndian,
    PYDICOM_IMPLEMENTATION_UID,
    generate_uid,
)


def nifti_to_ct_series(
    input_path: Path,
    output_dir: Path,
    *,
    patient_id: str,
    patient_name: str,
) -> dict:
    """Convert an anonymized research NIfTI fixture into a CT modality series."""
    image = sitk.ReadImage(str(input_path))
    if image.GetDimension() != 3:
        raise ValueError("CT simulator requires a 3D NIfTI volume")
    volume = np.rint(sitk.GetArrayFromImage(image)).clip(-32768, 32767).astype(np.int16)
    if volume.shape[0] < 2:
        raise ValueError("CT simulator requires at least two axial slices")

    spacing = image.GetSpacing()
    direction = np.asarray(image.GetDirection(), dtype=float).reshape(3, 3)
    row_cosine = direction[:, 0]
    column_cosine = direction[:, 1]
    study_uid = generate_uid()
    series_uid = generate_uid()
    frame_uid = generate_uid()
    now = datetime.now()
    accession = f"SIM{now:%y%m%d%H%M%S}"
    output_dir.mkdir(parents=True, exist_ok=False)
    paths: list[Path] = []

    for z_index, pixels in enumerate(volume):
        sop_uid = generate_uid()
        meta = FileMetaDataset()
        meta.MediaStorageSOPClassUID = CTImageStorage
        meta.MediaStorageSOPInstanceUID = sop_uid
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        meta.ImplementationClassUID = PYDICOM_IMPLEMENTATION_UID
        path = output_dir / f"IM_{z_index + 1:04d}.dcm"
        dataset = FileDataset(str(path), {}, file_meta=meta, preamble=b"\0" * 128)
        dataset.SOPClassUID = CTImageStorage
        dataset.SOPInstanceUID = sop_uid
        dataset.StudyInstanceUID = study_uid
        dataset.SeriesInstanceUID = series_uid
        dataset.FrameOfReferenceUID = frame_uid
        dataset.PatientName = patient_name
        dataset.PatientID = patient_id
        dataset.PatientBirthDate = ""
        dataset.PatientSex = "O"
        dataset.StudyDate = now.strftime("%Y%m%d")
        dataset.StudyTime = now.strftime("%H%M%S")
        dataset.SeriesDate = dataset.StudyDate
        dataset.SeriesTime = dataset.StudyTime
        dataset.AcquisitionDate = dataset.StudyDate
        dataset.AcquisitionTime = dataset.StudyTime
        dataset.AccessionNumber = accession
        dataset.StudyID = "BRAINHEM-SIM"
        dataset.StudyDescription = "Anonymized NCCT Head Simulator"
        dataset.SeriesDescription = "Head NCCT Brain"
        dataset.ProtocolName = "Non Contrast Head"
        dataset.Modality = "CT"
        dataset.ImageType = ["ORIGINAL", "PRIMARY", "AXIAL"]
        dataset.SeriesNumber = 1
        dataset.AcquisitionNumber = 1
        dataset.InstanceNumber = z_index + 1
        dataset.PatientPosition = "HFS"
        dataset.Manufacturer = "BrainHem Research Simulator"
        dataset.ManufacturerModelName = "CT-SIM-01"
        dataset.ImageOrientationPatient = [
            float(value) for value in (*row_cosine, *column_cosine)
        ]
        dataset.ImagePositionPatient = [
            float(value)
            for value in image.TransformIndexToPhysicalPoint((0, 0, z_index))
        ]
        dataset.PixelSpacing = [float(spacing[1]), float(spacing[0])]
        dataset.SliceThickness = float(spacing[2])
        dataset.SpacingBetweenSlices = float(spacing[2])
        dataset.Rows, dataset.Columns = pixels.shape
        dataset.SamplesPerPixel = 1
        dataset.PhotometricInterpretation = "MONOCHROME2"
        dataset.BitsAllocated = 16
        dataset.BitsStored = 16
        dataset.HighBit = 15
        dataset.PixelRepresentation = 1
        dataset.RescaleIntercept = "0"
        dataset.RescaleSlope = "1"
        dataset.RescaleType = "HU"
        dataset.WindowCenter = "40"
        dataset.WindowWidth = "80"
        dataset.PixelData = pixels.tobytes()
        dataset.save_as(path, enforce_file_format=True)
        paths.append(path)

    return {
        "paths": paths,
        "study_instance_uid": study_uid,
        "series_instance_uid": series_uid,
        "accession_number": accession,
        "rows": int(volume.shape[1]),
        "columns": int(volume.shape[2]),
        "slices": int(volume.shape[0]),
    }


def send_c_store(
    dicom_dir: Path,
    *,
    host: str,
    port: int,
    calling_aet: str,
    called_aet: str,
) -> None:
    """Send the simulated acquisition with real DICOM DIMSE C-STORE."""
    executable = shutil.which("storescu")
    if not executable:
        raise RuntimeError("DCMTK storescu is not installed on the simulator host")
    subprocess.run(
        [
            executable,
            "-aet",
            calling_aet,
            "-aec",
            called_aet,
            "+sd",
            "+r",
            host,
            str(port),
            str(dicom_dir),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=300,
    )
