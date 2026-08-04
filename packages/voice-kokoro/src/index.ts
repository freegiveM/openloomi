const DEFAULT_SPEECH_ENDPOINT = "/api/ai/v1/audio/speech";
const DEFAULT_FALLBACK_VOICE = "af_bella";
const DEFAULT_WARMUP_TEXT = "Hi.";

function stripFencedCodeBlocks(text: string): string {
  const outputLines: string[] = [];
  let activeFence: { marker: string; length: number } | null = null;

  for (const line of text.split(/\r?\n/)) {
    const fenceMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);

    if (activeFence) {
      const isClosingFence =
        fenceMatch &&
        fenceMatch[1][0] === activeFence.marker &&
        fenceMatch[1].length >= activeFence.length &&
        fenceMatch[2].trim().length === 0;

      if (isClosingFence) {
        activeFence = null;
      }
      continue;
    }

    if (fenceMatch) {
      activeFence = {
        marker: fenceMatch[1][0],
        length: fenceMatch[1].length,
      };
      continue;
    }

    outputLines.push(line);
  }

  return outputLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function getBrowserSpeechSynthesis(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null;
  if (!("speechSynthesis" in window)) return null;
  return window.speechSynthesis;
}

export class KokoroPlugin {
  public enabled: boolean;
  public voice: string;

  private speechEndpoint: string;
  private currentRequestController: AbortController | null;
  private currentWarmupController: AbortController | null;
  private currentAudio: HTMLAudioElement | null;
  private currentObjectUrl: string | null;
  private hasWarmedUp: boolean;
  private warmupPromise: Promise<void> | null;

  constructor(options?: { enabled?: boolean; voice?: string }) {
    this.enabled = options?.enabled ?? true;
    this.voice = options?.voice ?? DEFAULT_FALLBACK_VOICE;
    this.speechEndpoint = DEFAULT_SPEECH_ENDPOINT;
    this.currentRequestController = null;
    this.currentWarmupController = null;
    this.currentAudio = null;
    this.currentObjectUrl = null;
    this.hasWarmedUp = false;
    this.warmupPromise = null;
  }

  public stop(): void {
    this.currentRequestController?.abort();
    this.currentRequestController = null;
    this.currentWarmupController?.abort();
    this.currentWarmupController = null;

    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.removeAttribute("src");
      this.currentAudio.load();
      this.currentAudio = null;
    }

    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl);
      this.currentObjectUrl = null;
    }

    const synthesis = getBrowserSpeechSynthesis();
    if (synthesis) {
      synthesis.cancel();
    }
  }

  public async warmup(text: string = DEFAULT_WARMUP_TEXT): Promise<void> {
    if (!this.enabled || this.hasWarmedUp) return;

    const input = text.trim();
    if (!input) return;

    if (typeof window === "undefined") {
      return;
    }

    if (this.warmupPromise) {
      return this.warmupPromise;
    }

    const warmupPromise = this.runWarmup(input);
    this.warmupPromise = warmupPromise;
    return warmupPromise;
  }

  public async speak(text: string): Promise<void> {
    if (!this.enabled) {
      console.log("[KokoroPlugin] Disabled, skipping TTS.");
      return;
    }

    const input = stripFencedCodeBlocks(text);
    if (!input) return;

    if (typeof window === "undefined") {
      console.warn("[KokoroPlugin] Browser APIs are unavailable.");
      return;
    }

    this.stop();

    try {
      await this.speakViaRemoteService(input);
      return;
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }

      console.warn("[KokoroPlugin] Remote TTS unavailable:", error);
      if (this.speakViaBrowser(input)) {
        return;
      }

      throw error;
    }
  }

  private async speakViaRemoteService(text: string): Promise<void> {
    if (typeof fetch !== "function") {
      throw new Error("Fetch is not available for Kokoro TTS.");
    }

    const controller = new AbortController();
    this.currentRequestController = controller;

    try {
      const audioBlob = await this.fetchSpeechBlob(text, controller.signal);
      await this.playAudioBlob(audioBlob);
    } finally {
      if (this.currentRequestController === controller) {
        this.currentRequestController = null;
      }
    }
  }

  private async runWarmup(text: string): Promise<void> {
    const controller = new AbortController();
    this.currentWarmupController = controller;

    try {
      await this.fetchSpeechBlob(text, controller.signal);
      this.hasWarmedUp = true;
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      throw error;
    } finally {
      if (this.currentWarmupController === controller) {
        this.currentWarmupController = null;
      }
      this.warmupPromise = null;
    }
  }

  private async fetchSpeechBlob(
    text: string,
    signal: AbortSignal,
  ): Promise<Blob> {
    if (typeof fetch !== "function") {
      throw new Error("Fetch is not available for Kokoro TTS.");
    }

    const response = await fetch(this.speechEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: text,
        voice: this.voice === DEFAULT_FALLBACK_VOICE ? undefined : this.voice,
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(await this.readProviderError(response));
    }

    const audioBlob = await response.blob();
    if (audioBlob.size <= 0) {
      throw new Error("Kokoro TTS response was empty.");
    }

    return audioBlob;
  }

  private async playAudioBlob(audioBlob: Blob): Promise<void> {
    if (typeof Audio === "undefined") {
      throw new Error("Browser audio playback is not available.");
    }

    const objectUrl = URL.createObjectURL(audioBlob);
    const audio = new Audio(objectUrl);
    audio.preload = "auto";
    audio.autoplay = true;
    audio.onended = () => {
      if (this.currentAudio === audio) {
        this.currentAudio = null;
      }
      if (this.currentObjectUrl === objectUrl) {
        URL.revokeObjectURL(objectUrl);
        this.currentObjectUrl = null;
      }
    };
    audio.onerror = () => {
      if (this.currentAudio === audio) {
        this.currentAudio = null;
      }
      if (this.currentObjectUrl === objectUrl) {
        URL.revokeObjectURL(objectUrl);
        this.currentObjectUrl = null;
      }
    };

    this.currentAudio = audio;
    this.currentObjectUrl = objectUrl;

    try {
      await audio.play();
    } catch (error) {
      if (this.currentAudio === audio) {
        this.currentAudio = null;
      }
      if (this.currentObjectUrl === objectUrl) {
        URL.revokeObjectURL(objectUrl);
        this.currentObjectUrl = null;
      }
      throw error;
    }
  }

  private speakViaBrowser(text: string): boolean {
    const synthesis = getBrowserSpeechSynthesis();
    if (!synthesis) {
      console.warn("[KokoroPlugin] No Web Speech API available for fallback.");
      return false;
    }

    if (synthesis.speaking || synthesis.pending) {
      synthesis.cancel();
    }

    const utterance = new SpeechSynthesisUtterance(text);
    synthesis.speak(utterance);
    return true;
  }

  private async readProviderError(response: Response): Promise<string> {
    const text = await response.text().catch(() => "");
    if (!text.trim()) {
      return `Kokoro returned HTTP ${response.status.toString()}`;
    }

    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: unknown };
        message?: unknown;
        detail?: unknown;
      };
      const message =
        typeof parsed.error?.message === "string"
          ? parsed.error.message
          : typeof parsed.message === "string"
            ? parsed.message
            : typeof parsed.detail === "string"
              ? parsed.detail
              : null;
      return message ?? text.trim().slice(0, 400);
    } catch {
      return text.trim().slice(0, 400);
    }
  }
}
