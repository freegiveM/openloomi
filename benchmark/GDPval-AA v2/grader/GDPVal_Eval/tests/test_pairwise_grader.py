"""Tests for PairwiseGrader parsing logic (no API calls)."""

import pytest

from gdpval.grading.pairwise_grader import GradeResult, PairwiseGrader


class TestParseResponse:
    """Unit tests for _parse_response (no Gemini API calls required)."""

    def _grade(self, raw_response: str) -> GradeResult:
        return PairwiseGrader._parse_response(
            raw_response, model_a="model_a", model_b="model_b", task_id="task_01"
        )

    def test_verdict_a(self):
        result = self._grade("A\nmodel_a was much more thorough.")
        assert result.winner == "model_a"
        assert result.loser == "model_b"
        assert not result.is_tie
        assert result.raw_verdict == "A"
        assert "thorough" in result.explanation

    def test_verdict_b(self):
        result = self._grade("B\nmodel_b covered all edge cases.")
        assert result.winner == "model_b"
        assert result.loser == "model_a"
        assert not result.is_tie
        assert result.raw_verdict == "B"

    def test_verdict_tie(self):
        result = self._grade("TIE\nBoth submissions were equivalent.")
        assert result.is_tie
        assert result.winner is None
        assert result.loser is None
        assert result.raw_verdict == "TIE"

    def test_verdict_case_insensitive(self):
        result = self._grade("a")
        assert result.winner == "model_a"

    def test_unknown_verdict_treated_as_tie(self):
        result = self._grade("UNCLEAR\nCould not decide.")
        assert result.is_tie

    def test_metadata_preserved(self):
        result = self._grade("A")
        assert result.model_a == "model_a"
        assert result.model_b == "model_b"
        assert result.task_id == "task_01"
