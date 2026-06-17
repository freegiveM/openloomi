export class WhisperPlugin {
  public enabled: boolean;
  public model: string;

  constructor(options?: { enabled?: boolean; model?: string }) {
    this.enabled = options?.enabled ?? true;
    this.model = options?.model ?? "whisper-1";
  }
}
