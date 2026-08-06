"""Tests for the dataset loader (HTTP calls are mocked)."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from gdpval.dataset.loader import DATASET_NAME, fetch_sample


_MOCK_ROW = {
    "task_id": "test-task-id-001",
    "sector": "Professional, Scientific, and Technical Services",
    "occupation": "Accountants and Auditors",
    "prompt": "Review the attached spreadsheet and flag anomalies.",
    "reference_files": ["data.xlsx"],
    "reference_file_urls": ["https://example.com/data.xlsx"],
    "rubric_pretty": "Award points for accuracy and completeness.",
    "rubric_json": {"max_score": 100},
}

_MOCK_API_RESPONSE = {
    "rows": [
        {"row_idx": 0, "row": _MOCK_ROW, "truncated_cells": []},
    ],
    "num_rows_total": 220,
    "num_rows_per_page": 1,
}


def _make_mock_response(data: dict, status_code: int = 200) -> MagicMock:
    mock = MagicMock()
    mock.status_code = status_code
    mock.json.return_value = data
    mock.raise_for_status = MagicMock()
    return mock


class TestFetchSample:
    @patch("gdpval.dataset.loader.requests.get")
    def test_returns_row_dict(self, mock_get):
        mock_get.return_value = _make_mock_response(_MOCK_API_RESPONSE)
        row = fetch_sample(offset=0)
        assert row == _MOCK_ROW

    @patch("gdpval.dataset.loader.requests.get")
    def test_uses_correct_dataset_name(self, mock_get):
        mock_get.return_value = _make_mock_response(_MOCK_API_RESPONSE)
        fetch_sample(offset=0)
        _, kwargs = mock_get.call_args
        assert kwargs["params"]["dataset"] == DATASET_NAME

    @patch("gdpval.dataset.loader.requests.get")
    def test_offset_forwarded(self, mock_get):
        mock_get.return_value = _make_mock_response(_MOCK_API_RESPONSE)
        fetch_sample(offset=5)
        _, kwargs = mock_get.call_args
        assert kwargs["params"]["offset"] == 5

    @patch("gdpval.dataset.loader.requests.get")
    def test_fetches_exactly_one_row(self, mock_get):
        mock_get.return_value = _make_mock_response(_MOCK_API_RESPONSE)
        fetch_sample(offset=0)
        _, kwargs = mock_get.call_args
        assert kwargs["params"]["length"] == 1

    @patch("gdpval.dataset.loader.requests.get")
    def test_raises_value_error_on_empty_rows(self, mock_get):
        mock_get.return_value = _make_mock_response({"rows": []})
        with pytest.raises(ValueError, match="No rows returned"):
            fetch_sample(offset=0)

    @patch("gdpval.dataset.loader.requests.get")
    def test_raises_on_http_error(self, mock_get):
        import requests as req
        mock_resp = MagicMock()
        mock_resp.raise_for_status.side_effect = req.exceptions.HTTPError("404")
        mock_get.return_value = mock_resp
        with pytest.raises(req.exceptions.HTTPError):
            fetch_sample(offset=0)

    @patch("gdpval.dataset.loader.requests.get")
    def test_split_forwarded(self, mock_get):
        mock_get.return_value = _make_mock_response(_MOCK_API_RESPONSE)
        fetch_sample(offset=0, split="test")
        _, kwargs = mock_get.call_args
        assert kwargs["params"]["split"] == "test"

    @patch("gdpval.dataset.loader.requests.get")
    def test_timeout_forwarded(self, mock_get):
        mock_get.return_value = _make_mock_response(_MOCK_API_RESPONSE)
        fetch_sample(offset=0, timeout=60)
        _, kwargs = mock_get.call_args
        assert kwargs["timeout"] == 60
