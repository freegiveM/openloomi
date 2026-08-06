"""Pairwise grading using Gemini 3 Pro.

Submissions are randomly anonymised as "Submission A" and "Submission B" to
mitigate model or position bias.  Gemini 3 Pro Preview (``gemini-2.5-pro-preview``)
is used as the grader.
"""

from __future__ import annotations

import os
import random
import textwrap
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Tuple

GRADER_MODEL = "gemini-2.5-pro-preview"

_GRADING_PROMPT_TEMPLATE = textwrap.dedent(
    """
    You are an expert evaluator assessing the quality of two submissions for
    an economically valuable task.

    ## Original Task

    {task}

    ## Grading Instructions

    Review both submissions carefully and determine which one better completes
    the task.  Consider accuracy, completeness, clarity, and practical value.

    Respond with **exactly one** of the following tokens on the first line of
    your response (do not include quotes):
      - `A` if Submission A is better
      - `B` if Submission B is better
      - `TIE` if the submissions are of equal quality

    After the verdict token, you may provide a brief explanation (optional).
    """
).strip()


@dataclass
class GradeResult:
    """Result of a single pairwise grading comparison.

    Attributes
    ----------
    winner:
        Name of the winning model, or ``None`` on a tie.
    loser:
        Name of the losing model, or ``None`` on a tie.
    is_tie:
        ``True`` when the grader judged the submissions to be equal.
    raw_verdict:
        Raw verdict token returned by the grader (``"A"``, ``"B"``, or ``"TIE"``).
    explanation:
        Optional explanation from the grader.
    model_a:
        Name of the model assigned as Submission A.
    model_b:
        Name of the model assigned as Submission B.
    task_id:
        Identifier of the task being graded.
    """

    model_a: str
    model_b: str
    task_id: str
    raw_verdict: str
    is_tie: bool
    winner: Optional[str]
    loser: Optional[str]
    explanation: str = ""


class PairwiseGrader:
    """Grade model submission pairs using Gemini 3 Pro.

    Parameters
    ----------
    api_key:
        Gemini API key.  Falls back to the ``GEMINI_API_KEY`` environment
        variable if not provided.
    model:
        Gemini model name to use for grading.
    random_seed:
        Optional seed used when randomly assigning A/B positions.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: str = GRADER_MODEL,
        random_seed: Optional[int] = None,
    ) -> None:
        self.model = model
        self._rng = random.Random(random_seed)
        self._api_key = api_key or os.environ.get("GEMINI_API_KEY", "")
        self._client = self._build_client()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def grade(
        self,
        task_id: str,
        task_description: str,
        model_a: str,
        submission_a: str,
        model_b: str,
        submission_b: str,
    ) -> GradeResult:
        """Grade a single pairwise comparison.

        Submissions are randomly shuffled before being sent to the grader so
        that neither position (A vs B) is systematically advantaged.

        Parameters
        ----------
        task_id:
            Identifier for the task.
        task_description:
            The original task prompt shown to the models.
        model_a, model_b:
            Names of the two models being compared.
        submission_a, submission_b:
            Text content of each model's submission.

        Returns
        -------
        GradeResult
        """
        # Randomly shuffle A/B assignment.
        if self._rng.random() < 0.5:
            model_a, model_b = model_b, model_a
            submission_a, submission_b = submission_b, submission_a

        prompt = self._build_prompt(task_description, submission_a, submission_b)
        raw_response = self._call_grader(prompt)
        return self._parse_response(raw_response, model_a, model_b, task_id)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _build_client(self):
        """Initialise the Gemini client (lazy import to allow offline testing)."""
        try:
            import google.generativeai as genai  # type: ignore[import]

            genai.configure(api_key=self._api_key)
            return genai.GenerativeModel(self.model)
        except ImportError:
            return None

    def _build_prompt(
        self,
        task_description: str,
        submission_a: str,
        submission_b: str,
    ) -> str:
        grading_instructions = _GRADING_PROMPT_TEMPLATE.format(task=task_description)
        return (
            f"{grading_instructions}\n\n"
            f"## Submission A\n\n{submission_a}\n\n"
            f"## Submission B\n\n{submission_b}"
        )

    def _call_grader(self, prompt: str) -> str:
        if self._client is None:
            raise RuntimeError(
                "google-generativeai is not installed. "
                "Run: pip install google-generativeai"
            )
        response = self._client.generate_content(prompt)
        return response.text.strip()

    @staticmethod
    def _parse_response(
        raw_response: str,
        model_a: str,
        model_b: str,
        task_id: str,
    ) -> GradeResult:
        first_line = raw_response.splitlines()[0].strip().upper()
        explanation = "\n".join(raw_response.splitlines()[1:]).strip()

        if first_line == "A":
            return GradeResult(
                model_a=model_a,
                model_b=model_b,
                task_id=task_id,
                raw_verdict="A",
                is_tie=False,
                winner=model_a,
                loser=model_b,
                explanation=explanation,
            )
        if first_line == "B":
            return GradeResult(
                model_a=model_a,
                model_b=model_b,
                task_id=task_id,
                raw_verdict="B",
                is_tie=False,
                winner=model_b,
                loser=model_a,
                explanation=explanation,
            )
        # Treat anything else (including "TIE") as a tie.
        return GradeResult(
            model_a=model_a,
            model_b=model_b,
            task_id=task_id,
            raw_verdict=first_line,
            is_tie=True,
            winner=None,
            loser=None,
            explanation=explanation,
        )
