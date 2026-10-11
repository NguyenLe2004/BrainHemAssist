"""Load the approved FP32 or mixed-precision Baseline S ONNX artifact."""
from pathlib import Path
import hashlib

import numpy as np

MODEL_PATH = Path(__file__).resolve().parents[1] / "models" / "baseline_s.onnx"
MODEL_SHA256 = "92bc39b59ba8edd9f59241baa0b6ebe707690d92257cccc32c5933dbdc282ee5"
ARTIFACTS = {
    "fp32": (MODEL_PATH, MODEL_SHA256),
    "int8": (MODEL_PATH.with_name("baseline_s.int8.onnx"),
             "e4e81c678bfdd920a7070ffbdca20eb01dc77da2a16478b7012b47819c4f8845"),
}


class BaselineS:
    name = "Baseline S"

    def __init__(self, session, precision="fp32"):
        self.session = session
        self.precision = precision

    def predict(self, image, enhanced):
        tensors = {"image": image, "enhanced": enhanced}
        for name, value in tensors.items():
            if not isinstance(value, np.ndarray) or value.dtype != np.float32:
                raise ValueError(f"{name} must be a float32 NumPy array")
            if value.ndim != 4 or value.shape[1:] != (1, 512, 512) or not 1 <= value.shape[0] <= 128:
                raise ValueError(f"{name} must have shape [D,1,512,512], with 1 <= D <= 128")
            if not np.isfinite(value).all():
                raise ValueError(f"{name} must contain finite values")
        if image.shape != enhanced.shape:
            raise ValueError("Input tensors must have identical shapes")
        return self.session.run(["logits"], tensors)[0]


def load_model_s(path=None, providers=None, precision="fp32"):
    """Verify and load the published artifact, using CPU by default."""
    import onnxruntime as ort

    if precision not in ARTIFACTS:
        raise ValueError("Unknown model precision; use fp32 or int8")
    default_path, expected_hash = ARTIFACTS[precision]
    target = Path(path) if path is not None else default_path
    if target.is_symlink() or not target.is_file():
        raise ValueError("Baseline S must be a regular local ONNX file")
    with target.open("rb") as stream:
        payload = stream.read(32 * 1024 * 1024 + 1)
    if len(payload) > 32 * 1024 * 1024 or hashlib.sha256(payload).hexdigest() != expected_hash:
        raise ValueError("Baseline S checksum does not match the public artifact")
    providers = list(providers) if providers is not None else ["CPUExecutionProvider"]
    if not providers or any(name not in ort.get_available_providers() for name in providers):
        raise ValueError("A requested ONNX provider is unavailable")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(payload, sess_options=options, providers=providers)
    if [item.name for item in session.get_inputs()] != ["image", "enhanced"]:
        raise ValueError("Unexpected Baseline S input interface")
    if [item.name for item in session.get_outputs()] != ["logits"]:
        raise ValueError("Unexpected Baseline S output interface")
    return BaselineS(session, precision)


def load_model_m(path=None, providers=None):
    """Reserved extension point."""
    return None


def load_model_l(path=None, providers=None):
    """Reserved extension point."""
    return None


def load_model(size="s", path=None, providers=None, precision="fp32"):
    loaders = {"s": load_model_s, "m": load_model_m, "l": load_model_l}
    if not isinstance(size, str) or size.lower() not in loaders:
        raise ValueError("Unknown model slot")
    if size.lower() == "s":
        return load_model_s(path=path, providers=providers, precision=precision)
    if precision != "fp32":
        raise ValueError("Precision variants are available only for Baseline S")
    return loaders[size.lower()](path=path, providers=providers)
