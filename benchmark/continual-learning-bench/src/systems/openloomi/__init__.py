"""OpenLoomi-backed continual learning system package.

Routes a benchmark turn through the OpenLoomi ``/api/native/agent`` HTTP endpoint
instead of an upstream LLM provider. Keeps the same ICL-style linear message
history the ICL baseline uses, so the only behavioural difference vs. the
baseline is which model actually generates responses.
"""
from .system import OpenLoomiSystem

__all__ = ["OpenLoomiSystem"]
