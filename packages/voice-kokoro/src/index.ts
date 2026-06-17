export class KokoroPlugin {
  public enabled: boolean;
  public voice: string;

  constructor(options?: { enabled?: boolean; voice?: string }) {
    this.enabled = options?.enabled ?? true;
    this.voice = options?.voice ?? "default";
  }

  public async speak(text: string): Promise<void> {
    if (!this.enabled) {
      console.log("[KokoroPlugin] Disabled, skipping TTS.");
      return;
    }

    // Defaulting to fallback since Kokoro backend isn't integrated yet.
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      const utterance = new SpeechSynthesisUtterance(text);
      window.speechSynthesis.speak(utterance);
    } else {
      console.warn("[KokoroPlugin] No Web Speech API available for fallback.");
    }
  }
}
