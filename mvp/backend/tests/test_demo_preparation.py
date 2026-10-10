import pytest

from app.demo_preparation import prepare_demo49
from app.mlops_store import WorkflowError


def test_public_demo_hook_requires_supplied_dataset():
    with pytest.raises(WorkflowError, match="separately supplied dataset"):
        prepare_demo49(None, None, "operator")
