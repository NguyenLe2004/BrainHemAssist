from pathlib import Path

import numpy as np
import pytest

from baseline.model_loader import load_model, load_model_s, load_model_m, load_model_l


def test_optional_model_loaders_are_empty_and_never_read_a_model():
    missing = Path("missing-private-extension.onnx")
    assert load_model_m(missing) is None
    assert load_model_l(missing) is None
    assert load_model("M", path=missing) is None
    assert load_model("L", path=missing) is None


def test_unknown_slot_is_rejected():
    with pytest.raises(ValueError, match="Unknown model slot"):
        load_model("unknown")


def test_changed_model_cannot_be_loaded(tmp_path):
    changed = tmp_path / "changed.onnx"
    changed.write_bytes(b"untrusted artifact")
    with pytest.raises(ValueError, match="checksum"):
        load_model_s(changed)


def test_public_model_runs_on_cpu_with_the_documented_tensor_interface():
    model = load_model_s()
    inputs = np.zeros((1, 1, 512, 512), dtype=np.float32)
    result = model.predict(inputs, inputs)
    assert model.name == "Baseline S"
    assert result.shape == (1, 2, 512, 512)
    assert result.dtype == np.float32
    assert np.isfinite(result).all()
    with pytest.raises(ValueError, match="float32"):
        model.predict(inputs.astype(np.float64), inputs)
    bad = inputs.copy()
    bad[0, 0, 0, 0] = np.nan
    with pytest.raises(ValueError, match="finite"):
        model.predict(bad, inputs)
