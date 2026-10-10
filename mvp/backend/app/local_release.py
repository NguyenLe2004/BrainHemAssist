"""Optional release integration; an implementation is not shipped here."""
from .mlops_store import WorkflowError


class LocalReleaseManager:
    def __init__(self, studio):
        self.studio = studio
        self.store, self.settings = studio.store, studio.settings

    @property
    def configured(self):
        return False

    def initialize(self):
        pass

    def list(self):
        return []

    def live(self):
        return None

    def resolve(self, tag):
        if tag.startswith("brainhem-s-auto-"):
            raise WorkflowError("Pinned extension release is unavailable")
        return None

    def blocker(self, model):
        return "Auto-release extension is not included in this public source"

    def queue(self, run_id, actor, automatic=False):
        raise WorkflowError(self.blocker(None))

    @staticmethod
    def verify_artifacts(result, output):
        raise WorkflowError("Release verification extension is not included")

    def tick(self):
        return None
