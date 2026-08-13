"""
patch_parser.py
================
Extract the unified diff block from OpenLoomi agent's final reply.

Strategy (priority order):
1. ```` ```diff ... ``` ```` code block (preferred)
2. Any ```` ``` ... ``` ```` code block containing ``diff --git``
3. From the first ``diff --git`` in plain text up to the end of the reply
   (stripping trailing "success" and similar literal noise)
4. Nothing found → return None (treat as NO_PATCH_AVAILABLE)

Cleaning: strip common trailing literals like "success" / "```success" / "Done."
when appropriate.
"""

from __future__ import annotations

import re
from typing import Optional


_NO_PATCH_MARKERS = (
    "NO_PATCH_AVAILABLE",
    "I cannot",
    "I'm unable",
    "I am unable",
    "Sorry, I can't",
)


# Cleaning phase: many agents append "success" to the end of patch blocks
_TRAILING_NOISE = re.compile(
    r"(?:[\n\r]+\s*\`\`\`\s*|[\n\r]+\s*)+(?:success|SUCCESS|Done\.?|Complete\.?)?\s*$",
    re.MULTILINE,
)


def extract_patch(agent_reply: str) -> Optional[str]:
    """Return the unified diff text, or None if no patch is found."""
    if not agent_reply:
        return None

    # Case 1: ```diff ... ```
    m = re.search(r"```diff\s*\n([\s\S]*?)\n```", agent_reply)
    if m:
        diff = _clean(m.group(1).strip())
        if diff.startswith("diff --git"):
            return diff

    # Case 2: any ``` ... ``` block containing diff --git
    for m in re.finditer(r"```[a-zA-Z]*\s*\n([\s\S]*?)\n```", agent_reply):
        block = _clean(m.group(1).strip())
        if block.startswith("diff --git"):
            return block

    # Case 3: pull the first diff --git from plain text up to the end of the reply
    m = re.search(r"(diff --git[\s\S]+)$", agent_reply, re.MULTILINE)
    if m:
        return _clean(m.group(1).strip())

    return None


def _clean(diff: str) -> str:
    """Strip decorative trailing tails like ```` ```success`` while keeping the patch intact."""
    cleaned = _TRAILING_NOISE.sub("", diff)
    # The patch must start with "diff --git" and end with "\n" followed by any line
    # that does not start with "diff --git". python-patch does not accept tails like
    # "EOF: success".
    return cleaned.rstrip() + "\n"


def classify_no_patch(agent_reply: str) -> bool:
    """If the agent clearly says it couldn't produce a patch, treat as NO_PATCH."""
    upper = agent_reply.lower()
    return any(m.lower() in upper for m in _NO_PATCH_MARKERS) and extract_patch(agent_reply) is None
