// Quick test: does Promise.race between reader.read() and a 5s setTimeout
// actually resolve after 5s when the stream stalls after the first chunk?
import { setTimeout as delay } from "node:timers/promises";

async function main() {
  const url = "http://127.0.0.1:3515/api/native/agent";
  console.log("[test] sending POST");
  const start = Date.now();
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      prompt: "Reply with the single word: pong. Do not use any tools.",
      provider: "claude",
      permissionMode: "bypassPermissions",
      workDir: "D:/openloomi3/openloomi/results/race_probe_workdir",
      useProvidedWorkDir: true,
      taskId: "race-probe-task",
      modelConfig: { model: "MiniMax-M3-highspeed" },
    }),
  });
  console.log(`[test] response status ${resp.status} after ${Date.now() - start}ms`);
  const reader = resp.body!.getReader();
  // First read — should get the first chunk immediately (session frame).
  const first = await reader.read();
  console.log(`[test] first read: done=${first.done} bytes=${first.value?.byteLength ?? 0}`);
  // Now race a second read against a 5s timer.
  console.log(`[test] starting race at ${Date.now() - start}ms`);
  const t0 = Date.now();
  const outcome = await Promise.race([
    reader.read(),
    delay(5000).then(() => ({ stalled: true })),
  ]);
  console.log(`[test] race resolved at ${Date.now() - start}ms (${Date.now() - t0}ms) with ${"stalled" in outcome ? "stalled" : "data"}`);
  // Abort to clean up.
  try {
    await reader.cancel();
  } catch {}
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});