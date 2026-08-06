"""Pairwise match sampling strategies.

GDPVal-AA uses two sampling stages:

1. **Balanced sampling** – Each model pair is sampled once while ensuring
   diverse coverage across models' task submissions.
2. **Active (ELO-informed) sampling** – Pairings are prioritised between
   models with similar ELO ratings to maximise information gain per
   comparison, while maintaining balanced task exposure within each model.
"""

from __future__ import annotations

import random
from itertools import combinations
from typing import Dict, Iterator, List, Optional, Tuple

ModelPair = Tuple[str, str]


def balanced_pairs(
    models: List[str],
    task_ids: Optional[List[str]] = None,
    random_seed: Optional[int] = None,
) -> List[Tuple[str, str, Optional[str]]]:
    """Generate a balanced set of pairwise comparisons.

    Each ordered model pair ``(model_a, model_b)`` appears exactly once.
    If ``task_ids`` is provided, one task is sampled randomly for each pair to
    ensure diverse task coverage.

    Parameters
    ----------
    models:
        List of model names to compare.
    task_ids:
        Optional list of task identifiers from which one is sampled per pair.
    random_seed:
        Optional seed for reproducibility.

    Returns
    -------
    list of (model_a, model_b, task_id) tuples.
        ``task_id`` is ``None`` when ``task_ids`` is not supplied.
    """
    rng = random.Random(random_seed)
    pairs = list(combinations(models, 2))
    rng.shuffle(pairs)

    result: List[Tuple[str, str, Optional[str]]] = []
    for model_a, model_b in pairs:
        task = rng.choice(task_ids) if task_ids else None
        # Randomly assign which model is "A" vs "B" to reduce position bias.
        if rng.random() < 0.5:
            model_a, model_b = model_b, model_a
        result.append((model_a, model_b, task))

    return result


def active_pairs(
    models: List[str],
    ratings: Dict[str, float],
    n_pairs: int,
    task_ids: Optional[List[str]] = None,
    task_counts: Optional[Dict[Tuple[str, str], int]] = None,
    random_seed: Optional[int] = None,
) -> List[Tuple[str, str, Optional[str]]]:
    """Generate ELO-informed pairwise comparisons.

    Prioritises model pairs with similar ELO ratings (closer ratings yield
    more information per comparison under the Bradley-Terry model).  Task
    exposure within each model is balanced by downweighting pairs whose task
    has already been compared many times for either model.

    Parameters
    ----------
    models:
        List of model names.
    ratings:
        Current ELO estimates, keyed by model name.
    n_pairs:
        Number of comparisons to generate.
    task_ids:
        Optional list of task identifiers.
    task_counts:
        Optional mapping of ``(model, task_id)`` → number of times that model
        has already been compared on that task.  Used to balance task exposure.
    random_seed:
        Optional seed for reproducibility.

    Returns
    -------
    list of (model_a, model_b, task_id) tuples.
    """
    rng = random.Random(random_seed)
    pairs = list(combinations(models, 2))

    # Weight pairs by inverse ELO distance (add small epsilon to avoid div/0).
    elo_diffs = [abs(ratings.get(a, 1000.0) - ratings.get(b, 1000.0)) for a, b in pairs]
    weights = [1.0 / (d + 1e-6) for d in elo_diffs]
    total_weight = sum(weights)
    probs = [w / total_weight for w in weights]

    result: List[Tuple[str, str, Optional[str]]] = []
    for _ in range(n_pairs):
        idx = rng.choices(range(len(pairs)), weights=probs, k=1)[0]
        model_a, model_b = pairs[idx]

        # Select task while balancing exposure.
        task: Optional[str] = None
        if task_ids:
            if task_counts:
                task_weights = [
                    1.0 / (1 + task_counts.get((model_a, t), 0) + task_counts.get((model_b, t), 0))
                    for t in task_ids
                ]
            else:
                task_weights = [1.0] * len(task_ids)
            task = rng.choices(task_ids, weights=task_weights, k=1)[0]

        # Randomly assign submission order to reduce position bias.
        if rng.random() < 0.5:
            model_a, model_b = model_b, model_a

        result.append((model_a, model_b, task))

    return result
