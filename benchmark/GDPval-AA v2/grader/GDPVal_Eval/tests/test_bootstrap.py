"""Tests for bootstrap confidence intervals."""

import pytest

from gdpval.elo.bootstrap import bootstrap_confidence_intervals
from gdpval.elo.bradley_terry import DEFAULT_ANCHOR_MODEL


def _simple_matches():
    anchor = DEFAULT_ANCHOR_MODEL
    return [
        (anchor, "model_b"),
        (anchor, "model_c"),
        ("model_b", "model_c"),
        (anchor, "model_b"),
        ("model_c", "model_b"),
    ]


class TestBootstrapCI:
    def test_returns_all_models(self):
        matches = _simple_matches()
        point_est, cis = bootstrap_confidence_intervals(
            matches, n_bootstrap=50, random_seed=0
        )
        assert set(point_est.keys()) == {DEFAULT_ANCHOR_MODEL, "model_b", "model_c"}
        assert set(cis.keys()) == {DEFAULT_ANCHOR_MODEL, "model_b", "model_c"}

    def test_ci_lower_le_upper(self):
        matches = _simple_matches()
        _, cis = bootstrap_confidence_intervals(
            matches, n_bootstrap=100, random_seed=42
        )
        for model, (lo, hi) in cis.items():
            assert lo <= hi, f"CI for {model} has lower > upper"

    def test_anchor_model_ci_tight(self):
        """Anchor model ELO is always fixed so its CI should be very narrow."""
        matches = _simple_matches()
        point_est, cis = bootstrap_confidence_intervals(
            matches, n_bootstrap=200, random_seed=1
        )
        lo, hi = cis[DEFAULT_ANCHOR_MODEL]
        # The anchor is fixed in every bootstrap resample, so CI should be narrow.
        assert (hi - lo) < 50.0

    def test_point_estimate_within_ci(self):
        matches = _simple_matches()
        point_est, cis = bootstrap_confidence_intervals(
            matches, n_bootstrap=200, random_seed=7
        )
        for model in point_est:
            lo, hi = cis[model]
            # Point estimate should lie within or very close to the CI bounds.
            assert lo - 5 <= point_est[model] <= hi + 5

    def test_reproducibility_with_seed(self):
        matches = _simple_matches()
        pe1, ci1 = bootstrap_confidence_intervals(
            matches, n_bootstrap=50, random_seed=99
        )
        pe2, ci2 = bootstrap_confidence_intervals(
            matches, n_bootstrap=50, random_seed=99
        )
        for model in pe1:
            assert abs(pe1[model] - pe2[model]) < 1e-9
            assert abs(ci1[model][0] - ci2[model][0]) < 1e-9
