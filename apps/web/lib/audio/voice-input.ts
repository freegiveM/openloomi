export type VoiceInputPhase =
  | "idle"
  | "recording"
  | "preparing"
  | "uploading"
  | "transcribing";

export type WaveformSample = number;

export const MAX_WAVEFORM_SAMPLES = 48;
export const MAX_VOICE_UPLOAD_BYTES = 50 * 1024 * 1024;
export const VOICE_SILENCE_TIMEOUT_MS = 60 * 1000;

export function formatVoiceDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs
    .toString()
    .padStart(2, "0")}`;
}

export function isVoiceProcessingPhase(phase: VoiceInputPhase): boolean {
  return (
    phase === "preparing" || phase === "uploading" || phase === "transcribing"
  );
}
