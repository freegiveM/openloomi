// Mimic the EXACT Runner loop pattern, including the post-chunk
// processing (parseSSERecord / handleEvent / buffer / appendFileSync).
import { appendFileSync } from "node:fs";

async function main() {
  const url = "http://127.0.0.1:3515/api/native/agent";
  console.log("[test] sending POST at", new Date().toISOString());
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
  const decoder = new TextDecoder();
  let buffer = "";
  let chunkIdx = 0;
  let loopIter = 0;
  const sseStallMs = 5000;
  const debugPath = "D:/openloomi3/openloomi/results/race_probe_debug.log";
  while (true) {
    loopIter += 1;
    console.log(`[test] iter=${loopIter} chunkIdx=${chunkIdx} enter at ${Date.now() - start}ms`);
    const readPromise = reader.read();
    const stallTimer = new Promise<{ stalled: true }>((resolve) => {
      setTimeout(() => {
        console.log(`[test] iter=${loopIter} stallTimer fired at ${Date.now() - start}ms`);
        resolve({ stalled: true });
      }, sseStallMs);
    });
    const outcome = await Promise.race([readPromise, stallTimer]);
    console.log(`[test] iter=${loopIter} race resolved: stalled=${"stalled" in outcome} at ${Date.now() - start}ms`);
    if ("stalled" in outcome) {
      console.log(`[test] iter=${loopIter} stalled, breaking`);
      break;
    }
    const { done, value } = outcome;
    if (done) {
      console.log(`[test] iter=${loopIter} done, breaking`);
      break;
    }
    chunkIdx += 1;
    console.log(`[test] iter=${loopIter} got chunk #${chunkIdx}: ${value?.byteLength ?? 0} bytes`);
    try {
      appendFileSync(
        debugPath,
        `[${new Date().toISOString()}] raw read #${chunkIdx}: ${value?.byteLength ?? 0} bytes\n`,
      );
    } catch {}
    buffer += decoder.decode(value, { stream: true });
    const sep = buffer.indexOf("\n\n");
    if (sep !== -1) {
      const record = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      console.log(`[test] iter=${loopIter} parsed SSE record (${record.length} bytes)`);
    }
    if (chunkIdx >= 5) {
      console.log("[test] got 5 chunks, exiting");
      break;
    }
  }
  try {
    await reader.cancel();
  } catch {}
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});