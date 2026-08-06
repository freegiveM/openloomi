"""Tests for the evaluate.py entry-point (HTTP calls are mocked)."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from evaluate import evaluate_sample, main


_MOCK_SAMPLE = {
    "task_id": "test-task-id-001",
    "sector": "Professional, Scientific, and Technical Services",
    "occupation": "Accountants and Auditors",
    "prompt": "Review the attached spreadsheet and flag anomalies.",
    "reference_files": ["data.xlsx"],
    "reference_file_urls": ["https://example.com/data.xlsx"],
    "rubric_pretty": "Award points for accuracy and completeness.",
    "rubric_json": {"max_score": 100},
}


class TestEvaluateSample:
    @patch("evaluate.fetch_sample", return_value=_MOCK_SAMPLE)
    def test_returns_expected_keys(self, _mock):
        result = evaluate_sample(offset=0)
        for key in ("evaluated_at", "dataset", "offset", "task_id", "sector",
                    "occupation", "prompt", "reference_files", "rubric_pretty",
                    "task_prompt"):
            assert key in result, f"Missing key: {key}"

    @patch("evaluate.fetch_sample", return_value=_MOCK_SAMPLE)
    def test_metadata_preserved(self, _mock):
        result = evaluate_sample(offset=0)
        assert result["task_id"] == _MOCK_SAMPLE["task_id"]
        assert result["sector"] == _MOCK_SAMPLE["sector"]
        assert result["occupation"] == _MOCK_SAMPLE["occupation"]
        assert result["dataset"] == "openai/gdpval"
        assert result["offset"] == 0

    @patch("evaluate.fetch_sample", return_value=_MOCK_SAMPLE)
    def test_task_prompt_contains_task_text(self, _mock):
        result = evaluate_sample(offset=0)
        assert _MOCK_SAMPLE["prompt"] in result["task_prompt"]

    @patch("evaluate.fetch_sample", return_value=_MOCK_SAMPLE)
    def test_task_prompt_contains_reference_file(self, _mock):
        result = evaluate_sample(offset=0)
        assert "data.xlsx" in result["task_prompt"]

    @patch("evaluate.fetch_sample", return_value=_MOCK_SAMPLE)
    def test_offset_forwarded(self, mock_fetch):
        evaluate_sample(offset=3)
        mock_fetch.assert_called_once_with(offset=3)


class TestMain:
    @patch("evaluate.fetch_sample", return_value=_MOCK_SAMPLE)
    def test_writes_json_file(self, _mock, tmp_path):
        out = tmp_path / "out.json"
        main(["--output", str(out)])
        assert out.exists()
        data = json.loads(out.read_text())
        assert data["task_id"] == _MOCK_SAMPLE["task_id"]

    @patch("evaluate.fetch_sample", return_value=_MOCK_SAMPLE)
    def test_creates_parent_directory(self, _mock, tmp_path):
        out = tmp_path / "sub" / "result.json"
        main(["--output", str(out)])
        assert out.exists()
