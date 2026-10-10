"""Optional demo preparation hook; no private datasets are shipped."""
from .mlops_store import WorkflowError


def prepare_demo49(studio, annotations, actor):
    raise WorkflowError("Demo preparation requires a separately supplied dataset extension")
