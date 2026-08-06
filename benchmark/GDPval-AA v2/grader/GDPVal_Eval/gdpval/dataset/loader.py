"""Loader for the openai/gdpval HuggingFace dataset.

Uses the HuggingFace Datasets Server REST API to fetch individual rows without
requiring the ``datasets`` package to be installed.
"""

from __future__ import annotations

from typing import Any, Dict

import requests

DATASET_NAME = "openai/gdpval"
_DATASETS_SERVER_URL = "https://datasets-server.huggingface.co"


def fetch_sample(
    offset: int = 0,
    split: str = "train",
    timeout: int = 30,
) -> Dict[str, Any]:
    """Fetch a single row from the openai/gdpval dataset.

    Uses the HuggingFace Datasets Server API, so no extra packages beyond
    ``requests`` are required.

    Parameters
    ----------
    offset:
        Zero-based row index.  ``0`` fetches the very first task.
    split:
        Dataset split to query (default ``"train"``).
    timeout:
        HTTP request timeout in seconds.

    Returns
    -------
    Dict[str, Any]
        The sample row as a plain dictionary.  Expected keys include
        ``task_id``, ``sector``, ``occupation``, ``prompt``,
        ``reference_files``, ``reference_file_urls``, ``rubric_pretty``,
        and ``rubric_json``.

    Raises
    ------
    requests.exceptions.RequestException
        If the HTTP request fails (network error, non-2xx status, etc.).
    ValueError
        If the API response contains no rows.
    """
    url = f"{_DATASETS_SERVER_URL}/rows"
    params: Dict[str, Any] = {
        "dataset": DATASET_NAME,
        "config": "default",
        "split": split,
        "offset": offset,
        "length": 1,
    }
    response = requests.get(url, params=params, timeout=timeout)
    response.raise_for_status()

    data = response.json()
    rows = data.get("rows", [])
    if not rows:
        raise ValueError(
            f"No rows returned by the dataset API at offset={offset}, split={split!r}."
        )
    return rows[0]["row"]
