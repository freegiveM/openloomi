"""Tests for the task submission prompt helpers."""

import pytest

from gdpval.submission.prompt import (
    SUMMARIZATION_BRIDGE_PROMPT,
    SUMMARIZATION_PROMPT,
    TASK_SUBMISSION_PROMPT,
    build_summarization_bridge,
    build_task_prompt,
    build_turn_limit_warning,
)


class TestBuildTaskPrompt:
    def test_task_interpolated(self):
        prompt = build_task_prompt(
            task="Write a spreadsheet.",
            reference_files=["/home/user/data.xlsx"],
        )
        assert "Write a spreadsheet." in prompt

    def test_reference_files_interpolated(self):
        files = ["/home/user/a.pdf", "/home/user/b.docx"]
        prompt = build_task_prompt(task="Summarise documents.", reference_files=files)
        for f in files:
            assert f in prompt

    def test_finish_tool_name_interpolated(self):
        prompt = build_task_prompt(
            task="Do something.",
            reference_files=[],
            finish_tool_name="complete_task",
        )
        assert "complete_task" in prompt

    def test_no_reference_files_uses_none_placeholder(self):
        prompt = build_task_prompt(task="Do something.", reference_files=[])
        assert "(none)" in prompt

    def test_default_finish_tool_name(self):
        prompt = build_task_prompt(task="Task.", reference_files=[])
        assert "`finish`" in prompt


class TestBuildTurnLimitWarning:
    def test_remaining_turns_included(self):
        msg = build_turn_limit_warning(15)
        assert "15" in msg

    def test_finish_tool_name_included(self):
        msg = build_turn_limit_warning(5, finish_tool_name="done")
        assert "done" in msg


class TestBuildSummarizationBridge:
    def test_summary_included(self):
        summary = "The model created a chart and saved it to /home/user/chart.png."
        bridge = build_summarization_bridge(summary)
        assert summary in bridge
