import { afterEach, describe, expect, it, vi } from "vitest";

import { KokoroPlugin } from "@melandlabs/voice-kokoro";

function createLongSpeechText(): string {
  return [
    "第一段先说明核心结论，语音应该尽快开始播放，避免用户等待整段回答全部合成完成。",
    "第二段继续补充更多背景信息，让文字长度足够触发多个 TTS 请求，同时仍然沿着自然句子边界切分。",
    "第三段解释实现方式，当前音频播放时后台会提前请求下一段音频，这样段落之间的空隙会更短。",
    "最后一段保留一点收尾说明，确保尾段不要短到听起来很突兀。",
  ].join(" ");
}

function installBrowserAudioMocks(options?: { autoEnd?: boolean }) {
  const autoEnd = options?.autoEnd ?? true;
  const fetchBodies: string[] = [];
  const playedUrls: string[] = [];
  let objectUrlIndex = 0;

  vi.stubGlobal("window", {
    localStorage: {
      getItem: () => null,
    },
    speechSynthesis: {
      speaking: false,
      pending: false,
      cancel: vi.fn(),
      speak: vi.fn(),
    },
  });

  class MockAudio {
    public preload = "";
    public autoplay = false;
    public onended: (() => void) | null = null;
    public onerror: (() => void) | null = null;

    constructor(public src: string) {}

    async play() {
      playedUrls.push(this.src);
      if (autoEnd) {
        queueMicrotask(() => {
          this.onended?.();
        });
      }
    }

    pause() {}
    removeAttribute(_name: string) {}
    load() {}
  }

  vi.stubGlobal("Audio", MockAudio);
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
    objectUrlIndex += 1;
    return `blob:kokoro-test-${objectUrlIndex.toString()}`;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input: string };
      fetchBodies.push(body.input);
      return new Response(new Blob([body.input], { type: "audio/mpeg" }), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    }),
  );

  return {
    fetchBodies,
    playedUrls,
  };
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for condition.");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("KokoroPlugin queued speech", () => {
  it("skips fenced code blocks and sends long replies as smaller chunks", async () => {
    const { fetchBodies, playedUrls } = installBrowserAudioMocks();
    const plugin = new KokoroPlugin({ enabled: true });

    await plugin.speak(`${createLongSpeechText()}

\`\`\`ts
const secret = "do not speak this";
\`\`\`

${createLongSpeechText()}`);

    expect(fetchBodies.length).toBeGreaterThan(1);
    expect(playedUrls).toHaveLength(fetchBodies.length);
    expect(fetchBodies.every((chunk) => !chunk.includes("secret"))).toBe(true);
    expect(fetchBodies[0].length).toBeLessThanOrEqual(220);
    expect(fetchBodies.slice(1).every((chunk) => chunk.length <= 420)).toBe(
      true,
    );
  });

  it("prefetches the next chunk while the current chunk is playing", async () => {
    const { fetchBodies, playedUrls } = installBrowserAudioMocks({
      autoEnd: false,
    });
    const plugin = new KokoroPlugin({ enabled: true });

    const speakPromise = plugin.speak(
      `${createLongSpeechText()} ${createLongSpeechText()}`,
    );
    await waitForCondition(() => fetchBodies.length >= 2);

    expect(playedUrls).toHaveLength(1);
    expect(fetchBodies.length).toBeGreaterThanOrEqual(2);

    plugin.stop();
    await expect(speakPromise).resolves.toBeUndefined();
  });
});
