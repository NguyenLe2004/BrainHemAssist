from __future__ import annotations

import pytest

from app.orthanc import OrthancClient, OrthancError


class _Response:
    def __init__(self, payload):
        self.payload = payload

    def json(self):
        return self.payload


def test_unstable_study_is_not_analyzed(monkeypatch) -> None:
    client = OrthancClient("http://orthanc")

    def fake_get(path: str, **_kwargs):
        assert path == "/studies/study-1"
        return _Response({"IsStable": False, "Series": ["series-1"]})

    monkeypatch.setattr(client, "_get", fake_get)
    with pytest.raises(OrthancError, match="chưa ổn định"):
        client.select_series("study-1")


def test_worklist_exposes_pacs_stability(monkeypatch) -> None:
    client = OrthancClient("http://orthanc")
    payloads = {
        "/studies": ["study-1"],
        "/studies/study-1": {
            "IsStable": True,
            "LastUpdate": "20260805T120000",
            "Series": ["series-1"],
            "PatientMainDicomTags": {"PatientID": "ANON-1"},
            "MainDicomTags": {"StudyInstanceUID": "1.2.3"},
        },
    }
    monkeypatch.setattr(client, "_get", lambda path, **_kwargs: _Response(payloads[path]))

    item = client.list_studies()[0]
    assert item["is_stable"] is True
    assert item["last_update"] == "20260805T120000"
