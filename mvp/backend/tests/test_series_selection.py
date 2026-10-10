from app.series_selection import NoEligibleSeries, rank_head_ct_series, select_head_ct_series


def _series(identifier: str, description: str, count: int = 32, **tags):
    return {
        "ID": identifier,
        "Instances": [str(index) for index in range(count)],
        "MainDicomTags": {
            "Modality": "CT",
            "SeriesDescription": description,
            "SeriesInstanceUID": f"1.2.3.{identifier}",
            "ImageType": "ORIGINAL\\PRIMARY\\AXIAL",
            "SliceThickness": "5",
            **tags,
        },
    }


def test_prefers_original_noncontrast_head_series():
    items = [
        _series("scout", "Head Scout", 2),
        _series("cta", "CTA Head with contrast", 120),
        _series("mpr", "Head coronal MPR", 60),
        _series("ncct", "Brain NCCT", 35),
    ]
    selected = select_head_ct_series(items)
    assert selected.orthanc_id == "ncct"
    assert selected.score >= 50


def test_refuses_ambiguous_series_instead_of_guessing():
    items = [_series("one", "Routine", 10), _series("two", "Soft tissue", 10)]
    try:
        select_head_ct_series(items)
    except NoEligibleSeries as exc:
        assert "chọn series" in str(exc)
    else:
        raise AssertionError("ambiguous series should require manual review")


def test_rank_excludes_non_diagnostic_series():
    ranked = rank_head_ct_series(
        [_series("localizer", "LOCALIZER"), _series("brain", "Head plain")]
    )
    assert [item.orthanc_id for item in ranked] == ["brain"]


def test_non_contrast_phrase_is_not_mistaken_for_contrast():
    selected = select_head_ct_series(
        [_series("ncct", "Head NCCT Brain", ProtocolName="Non Contrast Head")]
    )
    assert selected.orthanc_id == "ncct"
