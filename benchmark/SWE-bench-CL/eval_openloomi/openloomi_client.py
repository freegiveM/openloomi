"""
openloomi_client.py
====================

薄薄一层 Python 客户端：直接 POST 到 OpenLoomi 的 /api/native/agent。

**关键点**：
- 这里不把 OpenLoomi 当 LLM 用；
- OpenLoomi 本身就是多步 coding agent (plan / execute / reflect / tool calls)
- 我们只调一次 HTTP，把整条 SWE-Bench-CL task 的完整 prompt 交给它；
- 让它在自己的会话里：用 bash/read/edit/grep 等内置工具去改仓库；
- 拿回 agent 最终回复，从里面抠 ```diff```。

字段对齐（依据 packages/ai/src/agent/native-runner/index.ts）：
    NativeAgentRequest {
      prompt: str;
      workDir?: str;          # ← 我们传 SWE-Bench-CL 仓库本地路径
      useProvidedWorkDir?: bool;
      provider?: "claude" | "codex" | "hermes" | ...;
      permissionMode?: "dontAsk" | ...;     # 避免 agent 卡权限弹窗
      platform?: str;          # 标识用途
      phase?: "plan" | "execute";
      ...
    }
"""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import requests


@dataclass
class OpenLoomiConfig:
    base_url: str = os.getenv("OPENLOOMI_BASE_URL", "http://127.0.0.1:3515")
    provider: str = os.getenv("OPENLOOMI_PROVIDER", "claude")  # claude / codex / hermes
    platform: str = os.getenv("OPENLOOMI_PLATFORM", "swe-bench-cl")
    timeout: int = int(os.getenv("OPENLOOMI_TIMEOUT", "1200"))  # 20 min default
    use_provided_work_dir: bool = True


def call_agent(
    prompt: str,
    *,
    work_dir: Path,
    config: Optional[OpenLoomiConfig] = None,
    log_prefix: str = "",
) -> str:
    """Run one /api/native/agent round, return the agent final reply as plain text."""
    cfg = config or OpenLoomiConfig()
    url = cfg.base_url.rstrip("/") + "/api/native/agent"

    body = {
        "prompt": prompt,
        "provider": cfg.provider,
        "platform": cfg.platform,
        "permissionMode": "dontAsk",
        # ↓ 关键：把 OpenLoomi 的 cwd 切到 SWE-Bench-CL 仓库根目录
        "workDir": str(Path(work_dir).resolve()),
        "useProvidedWorkDir": cfg.use_provided_work_dir,
        # 注意：不要传 `phase`。
        #   phase=="plan"   → 只跑规划，不动工具
        #   phase=="execute"→ 必须先传 planId（用于上轮 plan 后的执行）
        #   都不传           → 走 createRunGenerator() 完整流程：
        #                       plan → execute → reflect → final reply
        #   这正是 swe-bench-cl 想要的"agent 一次性跑完"语义
    }
    print(f"{log_prefix}[OpenLoomi] POST {url}  workDir={work_dir}", flush=True)
    print(f"{log_prefix}[OpenLoomi] prompt[:200] = {prompt[:200]!r}", flush=True)

    started = time.time()
    # 用 stream=True 自己 read chunks，避免 OpenLoomi 服务 abort 后 stream 不关、
    # harness 在 resp.text 等 EOF 死等。设 connect timeout 60s + read timeout 60s；
    # 整个请求最长 cfg.timeout 秒。
    try:
        resp = requests.post(
            url, json=body,
            stream=True,
            timeout=(60, 60),  # (connect, read)
        )
        # 自己迭代读，每次 read 最多 60s 内必须读到下一段。
        # OpenLoomi abort 后 stream EOF 会到达；或者我们用 cfg.timeout 全局卡死。
        body_chunks: list[str] = []
        deadline = started + cfg.timeout
        last_data_at = time.time()
        for chunk in resp.iter_content(chunk_size=None, decode_unicode=True):
            if chunk:
                body_chunks.append(chunk)
                last_data_at = time.time()
            if time.time() > deadline:
                resp.close()
                raise TimeoutError(f"OpenLoomi request exceeded {cfg.timeout}s total")
            if time.time() - last_data_at > 1800:  # 30 分钟没数据 = 死
                resp.close()
                raise TimeoutError(
                    f"OpenLoomi stream silent for 1800s (likely dead); abort"
                )
        resp_body = "".join(body_chunks)
    except requests.ReadTimeout:
        raise TimeoutError(f"OpenLoomi timed out after {cfg.timeout}s")
    elapsed = time.time() - started
    print(f"{log_prefix}[OpenLoomi] {resp.status_code} in {elapsed:.1f}s "
          f"({len(resp_body)} bytes)", flush=True)

    if resp.status_code != 200:
        raise RuntimeError(f"OpenLoomi {resp.status_code}: {resp_body[:500]}")

    return _extract_text(resp_body)


def _extract_text(body: str) -> str:
    """把 OpenLoomi SSE 流 dump 出来的 body 还原成 agent 的最终回复。

    与 clbench/jobbench 评测器中同款提取策略：解析 ``data: {...}`` 行，
    累积 ``type==\"text\"`` 的 ``content`` 字段，组成最终输出。
    """
    parts: list[str] = []
    # AI SDK v1 风格
    for line in body.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("data:"):
            payload = line[5:].strip()
        elif line.startswith("0:"):
            payload = line[1:].strip()
        else:
            continue
        if not payload or payload == "[DONE]":
            continue
        try:
            obj = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if obj.get("type") == "text" and isinstance(obj.get("content"), str):
            parts.append(obj["content"])
        elif obj.get("type") == "result" and isinstance(obj.get("content"), str):
            parts.append(obj["content"])
    if parts:
        return "".join(parts).strip()
    # 兜底：返回原文
    return body.strip()
