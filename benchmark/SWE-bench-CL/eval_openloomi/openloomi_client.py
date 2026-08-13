"""
openloomi_client.py
====================

A thin Python client that POSTs directly to OpenLoomi's /api/native/agent.

**Key points**:
- We do not use OpenLoomi as an LLM here;
- OpenLoomi is itself a multi-step coding agent (plan / execute / reflect / tool calls)
- We issue a single HTTP call, handing it the full prompt for the SWE-Bench-CL task;
- In its own session it uses built-in tools (bash/read/edit/grep) to modify the repo;
- We get the agent's final reply back and extract the ```diff``` from it.

Field mapping (per packages/ai/src/agent/native-runner/index.ts):
    NativeAgentRequest {
      prompt: str;
      workDir?: str;          # <-- We pass the SWE-Bench-CL repo's local path
      useProvidedWorkDir?: bool;
      provider?: "claude" | "codex" | "hermes" | ...;
      permissionMode?: "dontAsk" | ...;     # Prevent agent from stalling on permission prompts
      platform?: str;          # Identifies the use case
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
        # Key: switch OpenLoomi's cwd to the SWE-Bench-CL repo root
        "workDir": str(Path(work_dir).resolve()),
        "useProvidedWorkDir": cfg.use_provided_work_dir,
        # Note: do NOT pass `phase`.
        #   phase=="plan"   → planning only, no tool calls
        #   phase=="execute"→ must first pass planId (used to execute after a prior plan)
        #   neither passed   → goes through createRunGenerator() full flow:
        #                       plan → execute → reflect → final reply
        #   This is exactly the "agent runs end-to-end in one shot" semantics that
        #   swe-bench-cl wants.
    }
    print(f"{log_prefix}[OpenLoomi] POST {url}  workDir={work_dir}", flush=True)
    print(f"{log_prefix}[OpenLoomi] prompt[:200] = {prompt[:200]!r}", flush=True)

    started = time.time()
    # Use stream=True and read chunks manually to avoid the case where the OpenLoomi
    # service aborts without closing the stream, leaving the harness stuck waiting
    # for EOF on resp.text. Set connect timeout 60s + read timeout 60s; the whole
    # request is bounded by cfg.timeout seconds.
    try:
        resp = requests.post(
            url, json=body,
            stream=True,
            timeout=(60, 60),  # (connect, read)
        )
        # Iterate reads manually; each read must yield the next chunk within 60s.
        # When OpenLoomi aborts, stream EOF arrives; otherwise we cap with cfg.timeout.
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
            if time.time() - last_data_at > 1800:  # 30 min with no data = dead
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
    """Reconstruct the agent's final reply from an OpenLoomi SSE stream dump.

    Uses the same extraction strategy as the clbench/jobbench evaluators: parse
    ``data: {...}`` lines and accumulate the ``content`` field of entries where
    ``type == "text"`` to compose the final output.
    """
    parts: list[str] = []
    # AI SDK v1 style
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
    # Fallback: return the raw body
    return body.strip()
