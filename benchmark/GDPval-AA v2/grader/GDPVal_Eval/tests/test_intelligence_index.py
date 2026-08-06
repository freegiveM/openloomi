"""Tests for Intelligence Index normalization."""

import pytest

from gdpval.intelligence_index.normalize import normalize_elo, normalize_ratings


class TestNormalizeElo:
    def test_example_from_spec(self):
        """ELO 1400 → 45 % as specified in the problem statement."""
        assert abs(normalize_elo(1400) - 0.45) < 1e-9

    def test_floor_elo(self):
        """ELO 500 is the practical floor and should map to 0.0."""
        assert normalize_elo(500) == 0.0

    def test_below_floor_clamped(self):
        """ELO values below 500 should be clamped to 0.0."""
        assert normalize_elo(100) == 0.0
        assert normalize_elo(0) == 0.0
        assert normalize_elo(-500) == 0.0

    def test_above_ceiling_clamped(self):
        """ELO values that would exceed 1.0 should be clamped to 1.0."""
        assert normalize_elo(2500) == 1.0
        assert normalize_elo(9999) == 1.0

    def test_anchor_1000(self):
        """ELO 1000 (GPT-5.1 anchor) should map to 0.25."""
        assert abs(normalize_elo(1000) - 0.25) < 1e-9

    def test_full_range(self):
        """ELO 2500 (500 + 2000) should map to exactly 1.0."""
        assert normalize_elo(2500) == 1.0

    def test_returns_float(self):
        assert isinstance(normalize_elo(1200), float)


class TestNormalizeRatings:
    def test_normalizes_all_models(self):
        ratings = {"model_a": 1400, "model_b": 1000, "model_c": 500}
        normalized = normalize_ratings(ratings)
        assert set(normalized.keys()) == set(ratings.keys())
        assert abs(normalized["model_a"] - 0.45) < 1e-9
        assert abs(normalized["model_b"] - 0.25) < 1e-9
        assert normalized["model_c"] == 0.0

    def test_empty_dict(self):
        assert normalize_ratings({}) == {}
