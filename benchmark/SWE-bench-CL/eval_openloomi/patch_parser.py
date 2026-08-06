"""
patch_parser.py
================
从 OpenLoomi agent 的最终回复里抠出 unified diff 代码块。

策略（按优先级）：
1. ```` ```diff ... ``` ```` 代码块（最理想）
2. 任意 ```` ``` ... ``` ```` 代码块含 ``diff --git``
3. 文本中第一个 ``diff --git`` 到回复末尾（剥掉尾部 "success" 等字面）
4. 完全没有 → 返回 None（视为 NO_PATCH_AVAILABLE）

清洗：尾部常见的字面 "success" / "```success" / "Done." 视情况剥掉。
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


# 清洗阶段：很多 agent 在 patch 代码块尾加 "success" 字样
_TRAILING_NOISE = re.compile(
    r"(?:[\n\r]+\s*\`\`\`\s*|[\n\r]+\s*)+(?:success|SUCCESS|Done\.?|Complete\.?)?\s*$",
    re.MULTILINE,
)


def extract_patch(agent_reply: str) -> Optional[str]:
    """Return the unified diff text, or None if no patch is found."""
    if not agent_reply:
        return None

    # 情况 1：```diff ... ```
    m = re.search(r"```diff\s*\n([\s\S]*?)\n```", agent_reply)
    if m:
        diff = _clean(m.group(1).strip())
        if diff.startswith("diff --git"):
            return diff

    # 情况 2：任意 ``` ... ``` 块含 diff --git
    for m in re.finditer(r"```[a-zA-Z]*\s*\n([\s\S]*?)\n```", agent_reply):
        block = _clean(m.group(1).strip())
        if block.startswith("diff --git"):
            return block

    # 情况 3：纯文本里抽首个 diff --git 起直到回复末尾
    m = re.search(r"(diff --git[\s\S]+)$", agent_reply, re.MULTILINE)
    if m:
        return _clean(m.group(1).strip())

    return None


def _clean(diff: str) -> str:
    """剥掉尾部 ```` ```success`` 这种装饰性尾巴，再保 patch 完整。"""
    cleaned = _TRAILING_NOISE.sub("", diff)
    # patch 必须以 "diff --git" 开头、以 "\n" + 任意非 "diff --git" 行结尾。
    # python-patch 不接受 "EOF: success" 这种尾部。
    return cleaned.rstrip() + "\n"


def classify_no_patch(agent_reply: str) -> bool:
    """If the agent clearly says it couldn't produce a patch, treat as NO_PATCH."""
    upper = agent_reply.lower()
    return any(m.lower() in upper for m in _NO_PATCH_MARKERS) and extract_patch(agent_reply) is None
