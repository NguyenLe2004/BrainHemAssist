from __future__ import annotations

import os
import sys
import tempfile
import threading
import time
from pathlib import Path

import nibabel as nib
import numpy as np


class Sam2Unavailable(RuntimeError):
    pass


class Sam2Propagator:
    """Lazy, process-local MedSAM2 CT/RECIST runner for annotation previews."""

    def __init__(self, checkpoint: str = "", source_dir: str = "") -> None:
        workspace = Path(__file__).resolve().parents[3]
        self.checkpoint = Path(
            checkpoint
            or workspace
            / "artifacts/prompt_model_benchmark/checkpoints/medsam2_FLARE25_RECIST_baseline.pt"
        ).resolve()
        self.source_dir = Path(
            source_dir or workspace / "third_party/MedSAM2"
        ).resolve()
        self._model = None
        self._lock = threading.Lock()

    @property
    def available(self) -> bool:
        return self.checkpoint.is_file() and self.source_dir.is_dir()

    @property
    def ready(self) -> bool:
        if not self.available:
            return False
        try:
            import torch
        except (ImportError, OSError):
            return False
        return bool(torch.cuda.is_available())

    def _get_model(self):
        if self._model is not None:
            return self._model
        if not self.available:
            raise Sam2Unavailable(
                f"MedSAM2 is not configured (checkpoint={self.checkpoint}, source={self.source_dir})"
            )
        if str(self.source_dir) not in sys.path:
            sys.path.insert(0, str(self.source_dir))
        try:
            import torch
            from sam2.build_sam import build_sam2_video_predictor_npz
        except ImportError as exc:
            raise Sam2Unavailable(f"SAM2 dependencies are unavailable: {exc}") from exc
        if not torch.cuda.is_available():
            raise Sam2Unavailable("MedSAM2 propagation requires a CUDA GPU")
        config = "//" + str((self.source_dir / "sam2/configs/sam2.1_hiera_t512.yaml").resolve())
        self._model = build_sam2_video_predictor_npz(config, str(self.checkpoint))
        return self._model

    @staticmethod
    def _frames(source_xyz: np.ndarray) -> np.ndarray:
        volume = np.moveaxis(source_xyz, -1, 0).astype(np.float32, copy=False)
        finite = volume[np.isfinite(volume)]
        if finite.size == 0:
            raise ValueError("Source CT contains no finite voxels")
        # Preserve already-windowed research inputs; window native head CT for SAM2 RGB frames.
        if float(finite.min()) < -50 or float(finite.max()) > 300:
            volume = np.clip(volume, -20, 100)
            volume = (volume + 20) * (255.0 / 120.0)
        else:
            low, high = np.percentile(finite, (0.5, 99.5))
            if high <= low:
                high = low + 1
            volume = (np.clip(volume, low, high) - low) * (255.0 / (high - low))
        return np.nan_to_num(volume).astype(np.uint8)

    def predict(self, source_path: Path, mask_path: Path, output_path: Path) -> dict:
        import torch

        source_img = nib.load(source_path)
        mask_img = nib.load(mask_path)
        # NiiVue presents anatomical RAS views even when the file is stored with
        # permuted/flipped voxel axes. Run the video along canonical RAS axial Z,
        # then transform the preview back to the source file's original layout.
        source_ras = nib.as_closest_canonical(source_img)
        mask_ras = nib.as_closest_canonical(mask_img)
        source = np.asanyarray(source_ras.dataobj)
        manual = np.asanyarray(mask_ras.dataobj) > 0
        if source.shape[:3] != manual.shape[:3]:
            raise ValueError("Seed mask geometry does not match source CT")
        seed_slices = np.where(manual.any(axis=(0, 1)))[0].astype(int).tolist()
        if not seed_slices:
            raise ValueError("Draw a mask on at least one axial slice before using SAM2")

        frames = self._frames(source)
        started = time.perf_counter()
        with self._lock, tempfile.TemporaryDirectory(prefix="brainhem-sam2-") as frame_dir:
            model = self._get_model()
            # MedSAM2's NPZ predictor consumes normalized RGB tensors [T,3,H,W].
            image = torch.from_numpy(np.repeat(frames[:, None], 3, axis=1)).float().cuda().div_(255.0)
            mean = torch.tensor((0.485, 0.456, 0.406), device="cuda")[:, None, None]
            std = torch.tensor((0.229, 0.224, 0.225), device="cuda")[:, None, None]
            image.sub_(mean).div_(std)
            state = model.init_state(image, frames.shape[1], frames.shape[2])
            with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
                for z in seed_slices:
                    model.add_new_mask(
                        state,
                        frame_idx=z,
                        obj_id=1,
                        # Frames are [Z, X, Y], so the predictor's [H, W]
                        # mask is already manual[:, :, z].  Transposing here
                        # mirrors square CT slices across the diagonal and
                        # makes propagation start from a different lesion.
                        mask=np.asarray(manual[:, :, z], dtype=bool),
                    )
                predicted = {}
                for frame_idx, _, logits in model.propagate_in_video(state):
                    predicted[int(frame_idx)] = logits[0].detach().cpu().numpy().squeeze() > 0
                for frame_idx, _, logits in model.propagate_in_video(
                    state, start_frame_idx=max(seed_slices), reverse=True
                ):
                    predicted[int(frame_idx)] = logits[0].detach().cpu().numpy().squeeze() > 0

        result = manual.copy()
        for z, mask_yx in predicted.items():
            if z not in seed_slices:
                # Predictor output uses the same [X, Y] plane convention as
                # the input frames; do not transpose it back.
                result[:, :, z] = mask_yx
        ras_ornt = nib.orientations.io_orientation(source_ras.affine)
        source_ornt = nib.orientations.io_orientation(source_img.affine)
        to_source = nib.orientations.ornt_transform(ras_ornt, source_ornt)
        source_layout_result = nib.orientations.apply_orientation(result, to_source)
        output = nib.Nifti1Image(
            source_layout_result.astype(np.uint8), source_img.affine, source_img.header.copy()
        )
        output.set_data_dtype(np.uint8)
        nib.save(output, output_path)
        return {
            "seed_slices": seed_slices,
            "predicted_slices": [z for z in sorted(predicted) if z not in seed_slices],
            "seconds": round(time.perf_counter() - started, 3),
            "model": "medsam2-flare25-recist",
        }
