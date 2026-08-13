"""
prompt_template.py
==================
The single prompt template. When OpenLoomi receives this prompt, its built-in
agent (base agent + MCP tools + skills) will:
  1. Plan (planner phase)
  2. Invoke bash/read/edit/grep/glob tools to actually modify code
  3. Run tests to verify
  4. Emit a ```diff ... ``` block in the final reply
"""

from __future__ import annotations

import json
from typing import List, Optional


def build_task_prompt(
    *,
    instance_id: str,
    repo: str,
    problem_statement: str,
    fail_to_pass: List[str],
    pass_to_pass: List[str],
    hints: Optional[str] = None,
    memory_excerpt: Optional[str] = None,
    work_dir: Optional[str] = None,
) -> str:
    """Build the full task prompt sent to OpenLoomi.

    work_dir: the SWE-Bench-CL repo has already been checked out at the
              corresponding base_commit and `git clean -fdx`'d by the harness
              (per the upstream SWE-Bench flow), but we still restate it in
              the prompt so the agent knows what to expect.
    """
    memory_block = ""
    if memory_excerpt:
        memory_block = (
            "\n## Past experience in this repository (from semantic memory)\n\n"
            + memory_excerpt
            + "\n\nUse these past task outcomes as evidence if relevant. Do not blindly copy old solutions — they are hints, not contracts.\n"
        )

    return f"""# SWE-Bench-CL Task: {instance_id}

You are operating inside the **OpenLoomi harness** with full access to its
built-in tools (Bash, Read, Edit, Glob, Grep, etc.).  Use them to inspect and
edit the repository.

## Working directory

```
{work_dir or "(will be set by harness)"}
```

This is a fresh checkout of `{repo}` at the specific base commit for this
task — nothing modified, nothing staged.  You can run any shell command
(`ls`, `cat`, `grep`, `git diff`, etc.) using the Bash tool.

## Issue to fix

{problem_statement}

## Tests that must pass after your fix (FAIL_TO_PASS)

{chr(10).join('- `' + t + '`' for t in fail_to_pass) or '(none provided)'}

## Tests that must keep passing after your fix (PASS_TO_PASS)

{chr(10).join('- `' + t + '`' for t in pass_to_pass) or '(none provided)'}

## Hints (optional)

{hints or "(none)"}

## Instructions

1. **Explore** the repository with your tools (Read, Grep, Glob, Bash).
   Identify the root cause of the issue.
2. **Plan** the minimal change. Avoid touching test files unless the issue
   explicitly requires it (the test patch is applied separately by the
   evaluator after your fix lands).
3. **Edit** the relevant source files.
4. **Run** the FAIL_TO_PASS and PASS_TO_PASS tests using Bash.  Iterate until
   they all pass — this is the success criterion.
5. **Final reply must include a unified diff** (the output of `git diff`)
   wrapped in a ` ```diff ... ``` ` code block.  This is what the harness will
   extract and `git apply` to evaluate.  Example:

   ```diff
   diff --git a/path/to/file.py b/path/to/file.py
   --- a/path/to/file.py
   +++ b/path/to/file.py
   @@ -1,3 +1,3 @@
   -old line
   +new line
   ```

6. Do **not** commit. Do **not** modify test files. Keep the change minimal.
7. If you genuinely cannot produce a correct fix after thorough investigation,
   write the literal line `NO_PATCH_AVAILABLE` as the final line of your
   reply (the harness will record this as failure).
{memory_block}

Begin.
"""
