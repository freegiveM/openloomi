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

  const response = await fetch(`http://127.0.0.1:${port}/api/native/agent`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt,
      provider: "claude",
      permissionMode: "dontAsk",
      platform: "benchmark-gdpval",
    }),
    signal: AbortSignal.timeout(2_400_000),
  });

  if (!response.ok) {
    throw new Error(
      `Agent API error: ${response.status} ${response.statusText}`,
    );
  }

  const text = await response.text();
  return extractAgentText(text);
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
