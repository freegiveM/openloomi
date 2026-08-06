"""Tests for pairwise match sampling strategies."""

import pytest

from gdpval.grading.sampling import active_pairs, balanced_pairs


MODELS = ["alpha", "beta", "gamma", "delta"]
TASKS = ["task_01", "task_02", "task_03", "task_04", "task_05"]


class TestBalancedPairs:
    def test_correct_pair_count(self):
        """Balanced sampling should produce n*(n-1)/2 pairs for n models."""
        pairs = balanced_pairs(MODELS, random_seed=0)
        expected = len(MODELS) * (len(MODELS) - 1) // 2
        assert len(pairs) == expected

    def test_each_pair_once(self):
        """Each unordered model pair should appear exactly once."""
        pairs = balanced_pairs(MODELS, random_seed=0)
        unordered = {frozenset((a, b)) for a, b, _ in pairs}
        from itertools import combinations
        expected = {frozenset(p) for p in combinations(MODELS, 2)}
        assert unordered == expected

    def test_task_assigned_when_provided(self):
        """When task_ids is given every comparison should have a task."""
        pairs = balanced_pairs(MODELS, task_ids=TASKS, random_seed=0)
        for _, _, task in pairs:
            assert task in TASKS

    def test_no_task_when_not_provided(self):
        """Task should be None when task_ids is not supplied."""
        pairs = balanced_pairs(MODELS, random_seed=0)
        for _, _, task in pairs:
            assert task is None

    def test_reproducibility(self):
        """Same seed should yield identical results."""
        p1 = balanced_pairs(MODELS, task_ids=TASKS, random_seed=42)
        p2 = balanced_pairs(MODELS, task_ids=TASKS, random_seed=42)
        assert p1 == p2


class TestActivePairs:
    def _ratings(self):
        return {"alpha": 1000, "beta": 1050, "gamma": 1500, "delta": 900}

    def test_correct_pair_count(self):
        n_pairs = 20
        pairs = active_pairs(MODELS, self._ratings(), n_pairs=n_pairs, random_seed=0)
        assert len(pairs) == n_pairs

    def test_close_models_preferred(self):
        """Models with similar ELO should be paired more often than distant ones."""
        ratings = {"alpha": 1000, "beta": 1010, "gamma": 2000, "delta": 1990}
        pairs = active_pairs(
            ["alpha", "beta", "gamma", "delta"],
            ratings,
            n_pairs=500,
            random_seed=0,
        )
        close_count = sum(
            1
            for a, b, _ in pairs
            if frozenset([a, b]) in (frozenset(["alpha", "beta"]), frozenset(["gamma", "delta"]))
        )
        # Close pairs should account for significantly more than random (25%).
        assert close_count > len(pairs) * 0.30

    def test_task_assigned_when_provided(self):
        pairs = active_pairs(
            MODELS, self._ratings(), n_pairs=10, task_ids=TASKS, random_seed=0
        )
        for _, _, task in pairs:
            assert task in TASKS

    def test_reproducibility(self):
        r = self._ratings()
        p1 = active_pairs(MODELS, r, n_pairs=10, task_ids=TASKS, random_seed=7)
        p2 = active_pairs(MODELS, r, n_pairs=10, task_ids=TASKS, random_seed=7)
        assert p1 == p2
