"""Bootstrap confidence intervals for Bradley-Terry ELO ratings.

Resamples pairwise match data with replacement and refits the Bradley-Terry
model to construct 95 % confidence intervals around each model's ELO score.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple

import numpy as np

from gdpval.elo.bradley_terry import BradleyTerry, DEFAULT_ANCHOR_MODEL, DEFAULT_ANCHOR_ELO

ConfidenceIntervals = Dict[str, Tuple[float, float]]


def bootstrap_confidence_intervals(
    matches: List[Tuple[str, str]],
    n_bootstrap: int = 1000,
    confidence: float = 0.95,
    anchor_model: str = DEFAULT_ANCHOR_MODEL,
    anchor_elo: float = DEFAULT_ANCHOR_ELO,
    random_seed: Optional[int] = None,
) -> Tuple[Dict[str, float], ConfidenceIntervals]:
    """Compute bootstrapped ELO scores and confidence intervals.

    The procedure mirrors the GDPVal-AA methodology: the Bradley-Terry model
    is refit ``n_bootstrap`` times on resampled match data, and the resulting
    distribution of ratings is used to estimate confidence intervals.

    Parameters
    ----------
    matches:
        List of ``(winner, loser)`` tuples representing pairwise comparisons
        (ties excluded).
    n_bootstrap:
        Number of bootstrap iterations (default: 1000).
    confidence:
        Desired confidence level (default: 0.95 for 95 % CI).
    anchor_model:
        Name of the model whose ELO is fixed at ``anchor_elo``.
    anchor_elo:
        ELO value for the anchor model.
    random_seed:
        Optional seed for reproducibility.

    Returns
    -------
    point_estimates : dict
        ELO point estimates from the full dataset fit.
    confidence_intervals : dict
        Model name → ``(lower, upper)`` confidence interval tuple.
    """
    rng = np.random.default_rng(random_seed)
    matches_arr = np.array(matches, dtype=object)
    n_matches = len(matches_arr)

    bt_full = BradleyTerry(anchor_model=anchor_model, anchor_elo=anchor_elo)
    point_estimates = bt_full.fit(matches)
    models = list(point_estimates.keys())

    boot_ratings: Dict[str, List[float]] = {m: [] for m in models}

    for _ in range(n_bootstrap):
        indices = rng.integers(0, n_matches, size=n_matches)
        resampled = [tuple(matches_arr[i]) for i in indices]

        # Skip resamples that drop the anchor model entirely.
        resampled_models = {m for pair in resampled for m in pair}
        if anchor_model not in resampled_models:
            continue

        try:
            bt = BradleyTerry(anchor_model=anchor_model, anchor_elo=anchor_elo)
            ratings = bt.fit(resampled)
        except (ValueError, RuntimeError):
            continue

        for model in models:
            if model in ratings:
                boot_ratings[model].append(ratings[model])

    alpha = 1.0 - confidence
    lower_p = (alpha / 2.0) * 100.0
    upper_p = (1.0 - alpha / 2.0) * 100.0

    confidence_intervals: ConfidenceIntervals = {}
    for model in models:
        samples = boot_ratings[model]
        if len(samples) < 2:
            # Fall back to point estimate when too few resamples converge.
            ci = (point_estimates[model], point_estimates[model])
        else:
            arr = np.array(samples)
            ci = (float(np.percentile(arr, lower_p)), float(np.percentile(arr, upper_p)))
        confidence_intervals[model] = ci

    return point_estimates, confidence_intervals
