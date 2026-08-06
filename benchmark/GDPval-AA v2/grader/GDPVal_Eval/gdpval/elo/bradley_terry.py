"""Bradley-Terry model for ELO rating computation.

Fits pairwise win/loss data via maximum likelihood estimation and anchors
ratings so that the designated reference model equals the anchor ELO score.
"""

from __future__ import annotations

import warnings
from typing import Dict, List, Optional, Tuple

import numpy as np
from scipy.optimize import minimize

# Default anchor: GPT-5.1 (Non-Reasoning) is fixed at ELO 1000.
DEFAULT_ANCHOR_MODEL = "gpt-5.1"
DEFAULT_ANCHOR_ELO = 1000.0


class BradleyTerry:
    """Compute ELO ratings from pairwise comparisons using the Bradley-Terry model.

    The Bradley-Terry model assigns each model a latent strength parameter
    ``beta_i``.  For a match between model *i* (winner) and model *j* (loser):

        P(i beats j) = exp(beta_i) / (exp(beta_i) + exp(beta_j))

    Parameters are estimated via MLE with L-BFGS-B.  The solution is then
    affinely shifted so that the anchor model receives ``anchor_elo``.

    Parameters
    ----------
    anchor_model:
        Name of the model whose ELO is fixed (default: ``"gpt-5.1"``).
    anchor_elo:
        ELO value assigned to the anchor model (default: ``1000``).
    """

    def __init__(
        self,
        anchor_model: str = DEFAULT_ANCHOR_MODEL,
        anchor_elo: float = DEFAULT_ANCHOR_ELO,
    ) -> None:
        self.anchor_model = anchor_model
        self.anchor_elo = anchor_elo
        self._ratings: Dict[str, float] = {}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def fit(self, matches: List[Tuple[str, str]]) -> Dict[str, float]:
        """Fit Bradley-Terry ratings from pairwise win/loss records.

        Ties are excluded, consistent with the GDPVal-AA methodology.

        Parameters
        ----------
        matches:
            List of ``(winner, loser)`` tuples.  Each entry represents one
            comparison where the first model beat the second.

        Returns
        -------
        dict
            Model name → ELO score mapping.

        Raises
        ------
        ValueError
            If ``matches`` is empty or the anchor model is not present in the
            data and no fallback can be applied.
        """
        if not matches:
            raise ValueError("'matches' must contain at least one comparison.")

        models = sorted({m for pair in matches for m in pair})

        if self.anchor_model not in models:
            raise ValueError(
                f"Anchor model '{self.anchor_model}' not found in match data. "
                "Ensure at least one comparison involves the anchor model."
            )

        model_index = {m: i for i, m in enumerate(models)}
        n = len(models)

        # Build win-count and total-game arrays.
        wins = np.zeros((n, n), dtype=float)
        for winner, loser in matches:
            i, j = model_index[winner], model_index[loser]
            wins[i, j] += 1.0

        betas = self._mle(wins, n)
        self._ratings = self._to_elo(betas, models, model_index)
        return dict(self._ratings)

    @property
    def ratings(self) -> Dict[str, float]:
        """Return the fitted ELO ratings (empty until :meth:`fit` is called)."""
        return dict(self._ratings)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _mle(self, wins: np.ndarray, n: int) -> np.ndarray:
        """Return MLE beta parameters via L-BFGS-B.

        The last model is fixed at beta=0 to resolve the scale indeterminacy;
        we will re-anchor to the designated model afterwards.
        """

        def neg_log_likelihood(betas_free: np.ndarray) -> float:
            # Append the fixed reference beta (0.0 for the last model).
            betas = np.append(betas_free, 0.0)
            # Log-likelihood: sum_{i,j} wins[i,j] * log(p_ij)
            # where p_ij = exp(b_i) / (exp(b_i) + exp(b_j))
            # Equivalent to: wins[i,j] * (b_i - log(exp(b_i) + exp(b_j)))
            ll = 0.0
            for i in range(n):
                for j in range(n):
                    if wins[i, j] > 0 and i != j:
                        log_denom = np.logaddexp(betas[i], betas[j])
                        ll += wins[i, j] * (betas[i] - log_denom)
            return -ll

        x0 = np.zeros(n - 1)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            result = minimize(
                neg_log_likelihood,
                x0,
                method="L-BFGS-B",
                options={"maxiter": 1000, "ftol": 1e-12, "gtol": 1e-8},
            )

        betas_free = result.x
        return np.append(betas_free, 0.0)

    def _to_elo(
        self,
        betas: np.ndarray,
        models: List[str],
        model_index: Dict[str, int],
    ) -> Dict[str, float]:
        """Convert raw beta values to ELO scores anchored at the reference model.

        ELO is linearly scaled so that a difference of ``log(10) * 400``
        in beta corresponds to a 400-point difference in ELO (standard chess
        convention).  The whole scale is then shifted so that the anchor model
        equals ``self.anchor_elo``.
        """
        scale = 400.0 / np.log(10)
        elos_raw = betas * scale
        anchor_idx = model_index[self.anchor_model]
        shift = self.anchor_elo - elos_raw[anchor_idx]
        elos = elos_raw + shift
        return {model: float(elos[model_index[model]]) for model in models}
