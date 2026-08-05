// Quick smoke test for the v2 finish / abandon text protocol parser.
// Run with: npx tsx scripts/smoke_finish_protocol.ts

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOfficialPrompts,
  buildFinishDeliverables,
  FINISH_TOKEN,
  ABANDON_TOKEN,
} from "../src/agent.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("OK  :", msg);
}

async function main() {
  // 1) buildOfficialPrompts -> wraps the task in the v2 spec
  const taskText = "Create a bar chart of US GDP by sector.";
  const refs = ["data.csv", "Population v2.xlsx"];
  const { system_prompt, task_prompt } = buildOfficialPrompts(taskText, refs);
  assert(
    system_prompt.includes("250 steps"),
    "system_prompt mentions 250-step cap",
  );
  assert(
    system_prompt.includes("finish") && system_prompt.includes("abandon"),
    "system_prompt mentions finish and abandon",
  );
  assert(
    task_prompt.includes("TASK_SUBMISSION_PROMPT") ||
      task_prompt.includes("## Runtime") ||
      task_prompt.includes("Runtime"),
    "task_prompt includes the v2 'Runtime' section",
  );
  assert(
    task_prompt.includes("data.csv") &&
      task_prompt.includes("Population v2.xlsx"),
    "task_prompt lists reference files",
  );
  assert(
    task_prompt.includes("TeX Live") || task_prompt.includes("LibreOffice"),
    "task_prompt lists the v2 preinstalled package set",
  );
  assert(
    task_prompt.includes(taskText),
    "task_prompt embeds the original task text",
  );

  // 2) buildFinishDeliverables parses <<<FINISH>>> paths and resolves them
  //    on disk (relative to the workDir). We create two files in a tmp dir
  //    and verify the parser finds both.
  const workdir = join(tmpdir(), `gdpval-smoke-${Date.now()}`);
  mkdirSync(workdir, { recursive: true });
  writeFileSync(join(workdir, "report.pdf"), "%PDF-1.4 stub");
  writeFileSync(join(workdir, "chart.png"), "PNGstub");
  const fakeHandle = {
    text: `I made two files.\n\n${FINISH_TOKEN}\nProduced the v2 deliverables.\n${workdir}\\report.pdf\n${workdir}/chart.png\n`,
    tool_calls: [],
    submitted_paths: [],
    abandoned: false,
    abandon_reason: null,
    deliverables: [],
    usage: { input_tokens: 0, output_tokens: 0 },
    session_id: "smoke",
    turn_count: 1,
    result_event_seen: true,
    truncated: false,
  };
  // We can't import parseFinishProtocol (it isn't exported) — replicate the
  // logic here to keep the smoke test honest about the protocol.
  function parse(handle: typeof fakeHandle): string[] {
    const text = handle.text;
    const finishIdx = text.lastIndexOf(FINISH_TOKEN);
    if (finishIdx === -1) return [];
    const tail = text
      .slice(finishIdx + FINISH_TOKEN.length)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const paths: string[] = [];
    for (let i = 1; i < tail.length; i++) {
      if (/^([/\\]|[A-Za-z]:[/\\])/.test(tail[i])) paths.push(tail[i]);
    }
    return paths;
  }
  const parsed = parse(fakeHandle);
  assert(parsed.length === 2, "FINISH protocol yields 2 paths");
  const dels = buildFinishDeliverables(workdir, parsed);
  assert(dels.length === 2, "buildFinishDeliverables resolves both files");
  assert(
    dels.some((d) => d.workdir_path.toLowerCase().endsWith("report.pdf")),
    "report.pdf present in deliverables",
  );
  assert(
    dels.some((d) => d.workdir_path.toLowerCase().endsWith("chart.png")),
    "chart.png present in deliverables",
  );

  // 3) ABANDON path
  const abandonHandle = {
    ...fakeHandle,
    text: `Can't finish.\n\n${ABANDON_TOKEN}\nMissing reference PDF.\n`,
  };
  const aIdx = abandonHandle.text.lastIndexOf(ABANDON_TOKEN);
  const aReason = abandonHandle.text
    .slice(aIdx + ABANDON_TOKEN.length)
    .trim()
    .split("\n")[0]
    .trim();
  assert(aReason === "Missing reference PDF.", "ABANDON reason parsed");

  console.log("\nALL SMOKE TESTS PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
