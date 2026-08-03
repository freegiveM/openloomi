import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import net from "node:net";

export const DEFAULT_PORTS = [3515];

export async function findAvailablePort(): Promise<number> {
  for (const port of DEFAULT_PORTS) {
    const available = await checkPortAvailable(port);
    if (!available) return port;
  }
  throw new Error(
    `No OpenLoomi API server found on ports ${DEFAULT_PORTS.join(", ")}. Start pnpm tauri dev first.`,
  );
}

function checkPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(true));
    socket.connect(port, "127.0.0.1");
  });
}

export function readAuthToken(tokenPath?: string): string | undefined {
  const filePath = tokenPath ?? join(homedir(), ".openloomi", "token");
  try {
    const raw = readFileSync(filePath, "utf-8").trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

export async function callAgentApi(
  prompt: string,
  port: number,
  authToken?: string,
): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const requestBody = {
    prompt,
    provider: "claude",
    permissionMode: "dontAsk",
    platform: "benchmark-jobbench",
  };

  console.log(
    `  [AGENT] Sending request to http://127.0.0.1:${port}/api/native/agent`,
  );
  console.log(
    `  [AGENT] Prompt preview: ${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}`,
  );
  console.log("  [AGENT] Request body:", JSON.stringify(requestBody, null, 2));

  const startTime = Date.now();
  const response = await fetch(`http://127.0.0.1:${port}/api/native/agent`, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(2_400_000),
  });
  const elapsed = Date.now() - startTime;

  console.log(
    `  [AGENT] Response received: ${response.status} ${response.statusText} (${elapsed}ms)`,
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.log("  [AGENT] Error response body:", errorText);
    throw new Error(
      `Agent API error: ${response.status} ${response.statusText}`,
    );
  }

  // Read SSE stream directly
  console.log("  [AGENT] Reading SSE stream...");
  const body = response.body;
  if (!body) {
    throw new Error("Response body is null");
  }
  const text = await readSSEStream(body);
  console.log(`  [AGENT] Stream complete: ${text.length} chars`);

  const extracted = extractAgentText(text);
  console.log(
    `  [AGENT] Extracted answer: ${extracted.slice(0, 200)}${extracted.length > 200 ? "..." : ""}`,
  );

  return extracted;
}

async function readSSEStream(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let buffer = "";
  let resultReceived = false;
  const deadline = Date.now() + 120000; // 2 min total timeout
  let lastDataTime = Date.now();

  try {
    while (Date.now() < deadline && !resultReceived) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      chunks.push(chunk);
      buffer += chunk;
      lastDataTime = Date.now();

      // Check if we received a "result" type message (indicates completion)
      const lines = buffer.split("\n");
      let foundResult = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) {
          try {
            const jsonStr = trimmed.slice(5).trim();
            if (jsonStr && jsonStr !== "[DONE]") {
              const parsed = JSON.parse(jsonStr) as { type?: string };
              if (parsed.type === "result") {
                resultReceived = true;
                foundResult = true;
                console.log(
                  "  [AGENT] Result message received, closing stream...",
                );
                break;
              }
            }
          } catch {
            // Ignore JSON parse errors for non-JSON lines
          }
        }
      }
      if (foundResult) break;

      // Clear processed lines from buffer (keep last partial line)
      const lastLine = lines[lines.length - 1] || "";
      buffer = lastLine.startsWith("data:") ? lastLine : "";

      // Log progress
      if (chunks.length % 10 === 0) {
        console.log(
          `  [AGENT] Received ${chunks.length} chunks, ${chunks.join("").length} chars...`,
        );
        // Log last non-heartbeat message
        for (let i = lines.length - 1; i >= 0; i--) {
          const trimmed = lines[i].trim();
          if (
            trimmed.startsWith("data:") &&
            !trimmed.includes(": keep-alive")
          ) {
            console.log(
              `  [AGENT] Last data message: ${trimmed.slice(0, 200)}...`,
            );
            break;
          }
        }
      }

      // Check idle timeout (no data for 30 seconds)
      if (Date.now() - lastDataTime > 30000) {
        console.log("  [AGENT] Idle timeout (30s), closing stream...");
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return chunks.join("");
}

function extractAgentText(text: string): string {
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    for (const key of ["text", "content", "message", "result", "response"]) {
      if (typeof data[key] === "string" && data[key]) {
        return data[key] as string;
      }
    }
  } catch {
    // SSE/plain text path below.
  }

  const textParts: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:") && !trimmed.startsWith("0:")) continue;

    try {
      const jsonStr = trimmed.startsWith("data:")
        ? trimmed.slice(5).trim()
        : trimmed.slice(1).trim();
      if (!jsonStr || jsonStr === "[DONE]") continue;
      const parsed = JSON.parse(jsonStr) as {
        type?: string;
        content?: string;
        message?: string;
      };
      if (parsed.type === "text" && parsed.content)
        textParts.push(parsed.content);
      if (parsed.type === "direct_answer" && parsed.content)
        textParts.push(parsed.content);
      if (parsed.type === "error" && parsed.message)
        textParts.push(parsed.message);
    } catch {
      // Ignore malformed stream lines.
    }
  }

  return textParts.length > 0 ? textParts.join("") : text || "(empty response)";
}
