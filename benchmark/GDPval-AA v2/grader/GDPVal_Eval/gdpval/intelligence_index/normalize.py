"""Intelligence Index ELO normalization.

GDPVal ELO scores are normalized for inclusion in the Intelligence Index using:

    normalized_score = clamp((elo - 500) / 2000, 0.0, 1.0)

Subtracting 500 accounts for the practical floor in ELO scores.  For example,
a model with ELO 1400 contributes 45 % ((1400 - 500) / 2000) to its
Intelligence Index calculation.
"""

from __future__ import annotations

from typing import Dict


def normalize_elo(elo: float) -> float:
    """Normalize a single ELO score for the Intelligence Index.

    Parameters
    ----------
    elo:
        Raw ELO score (e.g., 1400).

    Returns
    -------
    float
        Clamped normalized score in [0.0, 1.0].

    Examples
    --------
    >>> normalize_elo(1400)
    0.45
    >>> normalize_elo(500)
    0.0
    >>> normalize_elo(2500)
    1.0
    >>> normalize_elo(100)
    0.0
    """
    raw = (elo - 500.0) / 2000.0
    return float(max(0.0, min(1.0, raw)))


def normalize_ratings(ratings: Dict[str, float]) -> Dict[str, float]:
    """Normalize a dict of model ELO ratings for the Intelligence Index.

    Parameters
    ----------
    ratings:
        Model name → ELO score mapping (e.g., from :class:`~gdpval.elo.bradley_terry.BradleyTerry`).

    Returns
    -------
    dict
        Model name → normalized score in [0.0, 1.0].
    """
    return {model: normalize_elo(elo) for model, elo in ratings.items()}
