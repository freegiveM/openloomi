"""OpenLoomi-backed continual learning system for CL-bench.

Implements the same ICL-style linear context history the built-in ICL baseline
uses, but routes every ``respond()`` through the OpenLoomi ``/api/native/agent``
HTTP endpoint instead of LiteLLM/upstream providers.

Configuration is environment-driven so the registered CLI params stay small:

  OPENLOOMI_BASE_URL   e.g. http://172.31.224.1:3515
  OPENLOOMI_TOKEN_PATH e.g. /mnt/c/Users/<you>/.openloomi/token
  OPENLOOMI_PROVIDER   defaults to "claude" (the only tracked provider right now)
  OPENLOOMI_TIMEOUT    seconds, default 2400 (40 min, matches OpenLoomi's own runner)

Drop the system into ``clbench run <task> --system openloomi --system.model <name>``.
The ``model`` argument is forwarded via the OpenLoomi agent request so the
server can pick the right provider/model on its side (it gets passed through
to the upstream LLM).

Important: the OpenLoomi agent API is a **server-sent events** endpoint. The
response body is a stream of ``data: {...}`` lines, not a single JSON object.
We read the full stream and stitch the assistant text back together.

Important 2: the request body is just ``{"prompt": "...", "provider": "claude"}``
(see apps/web/benchmark/*/src/memory-adapter.ts callAgentApi). No ``messages``
array, no ``modelConfig``, no ``response_format``. The upstream model is
chosen by the OpenLoomi server based on its own configuration.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any

from pydantic import BaseModel, ValidationError

from ...interface import (
    ContinualLearningSystem,
    Observation,
    Query,
    Response,
)
from ...registry import register_system
from ...usage import UsageEvent, build_usage_event
from ..utils import TokenBudgetTracker, count_tokens


def _env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    return value if value else default


def _post_sse(url: str, headers: dict[str, str], payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    """POST a JSON payload, read the full SSE stream, return a stitched result.

    Real OpenLoomi /api/native/agent event types (observed):
      - "session"    first event, gives {sessionId, messageId}
      - "reasoning"  upstream chain-of-thought ({content: "..."})
      - "text"       assistant text chunks ({content: "..."})
      - "result"     terminal, includes {content: "success", cost, duration, usage: {inputTokens, outputTokens}}
      - "error"      any failure

    We accumulate text and reasoning; usage comes from the final "result" event.
    Returns: {text, reasoning, usage, events, session_id, message_id}
    """
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={**headers, "content-type": "application/json", "accept": "text/event-stream"},
        method="POST",
    )
    text_parts: list[str] = []
    reasoning_parts: list[str] = []
    usage: dict[str, Any] | None = None
    events: list[dict[str, Any]] = []
    session_id: str | None = None
    message_id: str | None = None
    with urllib.request.urlopen(request, timeout=timeout) as response:
        buffer: list[str] = []
        for raw in response:
            line = raw.decode("utf-8", errors="replace").rstrip("\n").rstrip("\r")
            if line == "":
                # End of one event; flush.
                if not buffer:
                    continue
                data_lines = [l[5:].strip() for l in buffer if l.startswith("data:")]
                payload_text = "\n".join(data_lines).strip()
                buffer = []
                if not payload_text or payload_text == "[DONE]":
                    continue
                # Skip comment/heartbeat lines like ": keep-alive".
                if payload_text.startswith(":"):
                    continue
                try:
                    event = json.loads(payload_text)
                except json.JSONDecodeError:
                    continue
                events.append(event)
                etype = event.get("type")
                if etype == "session":
                    session_id = event.get("sessionId") or session_id
                    message_id = event.get("messageId") or message_id
                elif etype == "reasoning":
                    content = event.get("content")
                    if isinstance(content, str):
                        reasoning_parts.append(content)
                elif etype == "text":
                    content = event.get("content")
                    if isinstance(content, str):
                        text_parts.append(content)
                elif etype == "result":
                    if isinstance(event.get("usage"), dict):
                        usage = event["usage"]
                elif etype == "error":
                    raise RuntimeError(f"OpenLoomi SSE error event: {event}")
            else:
                buffer.append(line)
    return {
        "text": "".join(text_parts),
        "reasoning": "\n".join(reasoning_parts),
        "usage": usage,
        "events": events,
        "session_id": session_id,
        "message_id": message_id,
    }


@register_system("openloomi")
class OpenLoomiSystem(ContinualLearningSystem):
    """ICL-style system that delegates every turn to OpenLoomi's native agent API."""

    def __init__(
        self,
        model: str = "claude-sonnet-4-5",
        max_tokens: int | None = None,
        system_prompt: str = "",
        name: str = "openloomi_baseline",
        reserve_tokens: int = 500,
        base_url: str | None = None,
        token_path: str | None = None,
        provider: str | None = None,
        reasoning_effort: str | None = None,
        request_timeout: float = 2400.0,
        max_http_attempts: int = 3,
    ):
        self._name = name
        self.model = model
        self.max_tokens = max_tokens or 200_000
        self.reserve_tokens = reserve_tokens
        self.system_prompt = system_prompt
        self.base_url = (base_url or _env("OPENLOOMI_BASE_URL") or "").rstrip("/")
        if not self.base_url:
            raise RuntimeError(
                "OpenLoomi base URL is required. Pass base_url=... or set "
                "OPENLOOMI_BASE_URL in the environment."
            )
        self.token_path = token_path or _env("OPENLOOMI_TOKEN_PATH")
        self.provider = provider or _env("OPENLOOMI_PROVIDER", "claude")
        self.reasoning_effort = reasoning_effort or _env("OPENLOOMI_REASONING_EFFORT")
        self.request_timeout = float(request_timeout)
        self.max_http_attempts = max(1, int(max_http_attempts))

        # Token-side context bookkeeping mirrors the ICL baseline.
        self.messages: list[dict[str, str]] = []
        self._token_budget = TokenBudgetTracker()
        self.truncation_count: int = 0
        self.has_truncated_flag: bool = False
        self.interaction_count: int = 0

    # ------------------------------------------------------------------ helpers
    def _http_headers(self) -> dict[str, str]:
        if not self.token_path:
            raise RuntimeError("OPENLOOMI_TOKEN_PATH must be set before calling OpenLoomi.")
        token_path = self.token_path
        # Re-read each turn so token rotation works without re-instantiating the system.
        with open(token_path, "r", encoding="utf-8") as handle:
            token = handle.read().strip()
        return {
            "authorization": f"Bearer {token}",
            "accept": "text/event-stream",
        }

    def _build_request_payload(self, prompt_text: str) -> dict[str, Any]:
        # Match apps/web/benchmark/*/src/memory-adapter.ts callAgentApi exactly:
        # body is {prompt, provider}. The model name is forwarded separately.
        payload: dict[str, Any] = {
            "prompt": prompt_text,
            "provider": self.provider,
        }
        if self.reasoning_effort:
            payload["reasoning_effort"] = self.reasoning_effort
        # Forward the desired model name so OpenLoomi can route to the right
        # upstream (it expects the model id under this key on the request body).
        payload["model"] = self.model
        return payload

    def _call_openloomi(self, prompt_text: str) -> dict[str, Any]:
        url = f"{self.base_url}/api/native/agent"
        payload = self._build_request_payload(prompt_text)
        last_error: Exception | None = None
        for attempt in range(self.max_http_attempts):
            try:
                result = _post_sse(url, self._http_headers(), payload, self.request_timeout)
                if not result["text"].strip():
                    raise RuntimeError("OpenLoomi returned empty text body")
                return result
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")
                last_error = RuntimeError(f"OpenLoomi HTTP {exc.code}: {detail[:200]}")
                # Don't retry 4xx (client error), only 5xx.
                if 400 <= exc.code < 500:
                    raise last_error
                wait = min(30.0, 2.0 * (2**attempt))
                time.sleep(wait)
                continue
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                last_error = exc
                wait = min(30.0, 2.0 * (2**attempt))
                time.sleep(wait)
                continue
            except RuntimeError as exc:
                last_error = exc
                wait = min(15.0, 1.0 * (2**attempt))
                time.sleep(wait)
                continue
        raise RuntimeError(
            f"OpenLoomi request failed after {self.max_http_attempts} attempts: {last_error}"
        )

    @staticmethod
    def _parse_content(text: str, response_schema: type[BaseModel]) -> BaseModel:
        content = text.strip()
        # Strip optional ```json ... ``` fences the upstream model may wrap.
        if content.startswith("```"):
            content = content.strip("`")
            if content.lower().startswith("json"):
                content = content[4:]
            content = content.strip()
        try:
            data = json.loads(content)
        except json.JSONDecodeError:
            start = content.find("{")
            end = content.rfind("}")
            if start == -1 or end == -1 or end <= start:
                raise
            data = json.loads(content[start : end + 1])
        return response_schema.model_validate(data)

    # ------------------------------------------------------------------ bookkeeping
    def _estimate_message_tokens(self, messages: list[dict[str, str]]) -> int:
        total = 0
        for message in messages:
            total += 4
            total += count_tokens(self.model, message.get("role", ""))
            total += count_tokens(self.model, message.get("content", ""))
        return total + 2

    def _truncate_context(self) -> None:
        while self.messages:
            current_tokens = self._token_budget.count(
                self.messages, self._estimate_message_tokens
            )
            if current_tokens <= self.max_tokens - self.reserve_tokens:
                break
            self.messages.pop(0)
            self.truncation_count += 1
            self.has_truncated_flag = True

    # ------------------------------------------------------------------ interface
    def reset(self) -> None:
        self.messages = []
        self._token_budget.reset()
        self.truncation_count = 0
        self.has_truncated_flag = False
        self.interaction_count = 0

    def observe(self, observation: Observation, next_query: Query | None = None) -> None:
        content = observation.content.strip()
        if not content:
            return
        self.messages.append({"role": "user", "content": f"FEEDBACK: {content}"})
        self._truncate_context()

    def respond(self, query: Query) -> Response:
        self.interaction_count += 1
        prompt = query.prompt if query.prompt else "(no content)"
        self.messages.append({"role": "user", "content": prompt})
        self._truncate_context()

        # Stitch the visible message history into a single prompt that the
        # OpenLoomi agent (which only takes a flat string) can consume.
        # System prompt first, then the dialogue so the model sees full context.
        prompt_parts: list[str] = []
        if self.system_prompt:
            prompt_parts.append(self.system_prompt)
        for message in self.messages:
            role = message.get("role", "user").upper()
            content = message.get("content", "")
            prompt_parts.append(f"[{role}]\n{content}")
        # Tell the model the expected response shape, since OpenLoomi's
        # /api/native/agent does not pass response_format through to the LLM.
        schema_hint = (
            "\n\nRespond with JSON that matches this schema:\n"
            f"```json\n{json.dumps(query.response_schema.model_json_schema(), indent=2)}\n```"
        )
        prompt_parts.append(schema_hint)
        full_prompt = "\n\n".join(prompt_parts)

        try:
            result = self._call_openloomi(full_prompt)
        except Exception as exc:
            raise RuntimeError(f"OpenLoomi call failed: {exc}") from exc

        assistant_text = result["text"]
        try:
            action = self._parse_content(assistant_text, query.response_schema)
        except (json.JSONDecodeError, ValidationError) as exc:
            raise RuntimeError(
                f"OpenLoomi returned text that did not match response_schema. "
                f"Text: {assistant_text[:300]!r} ... Error: {exc}"
            )

        assistant_record = action.model_dump_json()
        self.messages.append({"role": "assistant", "content": assistant_record})
        self._truncate_context()

        usage_event = self._build_usage_event(result.get("usage"))
        if usage_event is not None:
            self.record_usage_event(usage_event)

        return Response(
            action=action,
            metadata={
                "interaction_count": self.interaction_count,
                "system_type": "openloomi",
                "model": self.model,
                "provider": self.provider,
                "has_truncated": self.has_truncated_flag,
                "truncation_count": self.truncation_count,
            },
        )

    def _build_usage_event(self, usage: dict[str, Any] | None) -> UsageEvent | None:
        if not isinstance(usage, dict):
            return None
        # OpenLoomi's "result" event uses camelCase keys: inputTokens / outputTokens.
        return build_usage_event(
            model=self.model,
            provider="openloomi",
            input_tokens=usage.get("inputTokens") or usage.get("input_tokens") or usage.get("prompt_tokens"),
            output_tokens=usage.get("outputTokens") or usage.get("output_tokens") or usage.get("completion_tokens"),
            total_tokens=usage.get("totalTokens") or usage.get("total_tokens"),
            call_type="completion",
            metadata={"raw_usage": usage, "provider": self.provider},
            response=None,
        )

    @property
    def name(self) -> str:
        return self._name

    def get_run_artifacts(self) -> dict[str, Any]:
        return {
            "artifact_type": "openloomi",
            "messages": list(self.messages),
            "message_count": len(self.messages),
            "interaction_count": self.interaction_count,
            "model": self.model,
            "provider": self.provider,
            "has_truncated": self.has_truncated_flag,
            "truncation_count": self.truncation_count,
        }
