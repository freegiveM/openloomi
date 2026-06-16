"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { fetchWithAuth } from "@/lib/utils";
import { uploadImageTUS } from "@/lib/files/tus-upload";
import {
  formatVoiceDuration,
  isVoiceProcessingPhase,
  MAX_VOICE_UPLOAD_BYTES,
  MAX_WAVEFORM_SAMPLES,
  VOICE_SILENCE_TIMEOUT_MS,
  type VoiceInputPhase,
  type WaveformSample,
} from "@/lib/audio/voice-input";

/**
 * Detect if running in Tauri environment
 */
const isTauriEnv = typeof window !== "undefined" && "__TAURI__" in window;

function getSupportedAudioMimeType(): string {
  if (typeof MediaRecorder === "undefined") {
    return "";
  }
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

const DEFAULT_AUDIO_TRANSCRIPTION_MODEL = "gemini-2.5-flash-lite";

/** Reject trivially empty recordings before upload */
const MIN_VOICE_UPLOAD_BYTES = 256;
const VOICE_ACTIVITY_THRESHOLD = 0.12;
const MIN_VOICE_ACTIVITY_FRAMES = 4;

/** Convert AudioBuffer to WAV Blob */
function audioBufferToWav(buffer: AudioBuffer): Blob {
  if (buffer.length === 0) {
    return new Blob([], { type: "audio/wav" });
  }

  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataLength = buffer.length * numChannels * bytesPerSample;
  const bufferLength = 44 + dataLength;
  const arrayBuffer = new ArrayBuffer(bufferLength);
  const view = new DataView(arrayBuffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, "data");
  view.setUint32(40, dataLength, true);

  const offset = 44;
  const channels: Float32Array[] = [];
  for (let i = 0; i < numChannels; i++) {
    channels.push(buffer.getChannelData(i));
  }

  let index = 0;
  for (let i = 0; i < buffer.length; i++) {
    for (let channel = 0; channel < numChannels; channel++) {
      const sample = Math.max(-1, Math.min(1, channels[channel][i]));
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset + index, intSample, true);
      index += 2;
    }
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}

/** Convert webm/opus Blob to WAV Blob using Web Audio API */
async function convertWebmToWav(webmBlob: Blob): Promise<Blob> {
  const arrayBuffer = await webmBlob.arrayBuffer();
  const audioContext = new AudioContext();
  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    return audioBufferToWav(audioBuffer);
  } finally {
    await audioContext.close();
  }
}

interface UseAudioRecordingOptions {
  /** Called when transcription completes with the transcribed text */
  onTranscriptionComplete: (text: string) => void;
}

interface UseAudioRecordingReturn {
  phase: VoiceInputPhase;
  isRecordingAudio: boolean;
  isTranscribingAudio: boolean;
  isProcessingAudio: boolean;
  audioLevel: number;
  waveformSamples: WaveformSample[];
  durationSeconds: number;
  durationText: string;
  canCancel: boolean;
  canConfirm: boolean;
  startRecording: () => Promise<void>;
  confirmRecording: () => Promise<void>;
  cancelRecording: () => Promise<void>;
  cancelProcessing: () => void;
}

/**
 * Hook for audio recording and transcription.
 * Shared across composer-style input components.
 */
export function useAudioRecording({
  onTranscriptionComplete,
}: UseAudioRecordingOptions): UseAudioRecordingReturn {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<VoiceInputPhase>("idle");
  const [audioLevel, setAudioLevel] = useState(0);
  const [waveformSamples, setWaveformSamples] = useState<WaveformSample[]>([]);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const phaseRef = useRef<VoiceInputPhase>("idle");
  const recordingStartedAtRef = useRef<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioRafRef = useRef<number | null>(null);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  /** Store MediaStreamSourceNode so we can disconnect it on cleanup */
  const mediaStreamSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const uploadAbortControllerRef = useRef<AbortController | null>(null);
  const transcriptionAbortControllerRef = useRef<AbortController | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const currentUploadIdRef = useRef<string | null>(null);
  const hasDetectedSpeechRef = useRef(false);
  const voiceActivityFramesRef = useRef(0);
  const lastVoiceActivityAtRef = useRef<number | null>(null);
  const silenceStopInFlightRef = useRef(false);

  // Use ref for callback to avoid re-creating functions when callback changes
  const onTranscriptionCompleteRef = useRef(onTranscriptionComplete);
  onTranscriptionCompleteRef.current = onTranscriptionComplete;

  /** Guard against rapid double-click creating duplicate streams */
  const isStartingRef = useRef(false);

  /** Track whether the component is still mounted to skip async callbacks after unmount */
  const isCancelledRef = useRef(false);

  const resetVisualState = useCallback(() => {
    setAudioLevel(0);
    setWaveformSamples([]);
    setDurationSeconds(0);
    recordingStartedAtRef.current = null;
  }, []);

  const setPhaseState = useCallback((nextPhase: VoiceInputPhase) => {
    phaseRef.current = nextPhase;
    setPhase(nextPhase);
  }, []);

  const resetVoiceActivityState = useCallback(() => {
    hasDetectedSpeechRef.current = false;
    voiceActivityFramesRef.current = 0;
    lastVoiceActivityAtRef.current = null;
    silenceStopInFlightRef.current = false;
  }, []);

  const syncDurationFromStart = useCallback(() => {
    const startedAt = recordingStartedAtRef.current;
    if (startedAt == null) {
      setDurationSeconds(0);
      return;
    }

    const elapsedSeconds = Math.max(
      0,
      Math.floor((Date.now() - startedAt) / 1000),
    );
    setDurationSeconds(elapsedSeconds);
  }, []);

  const stopDurationTimer = useCallback(() => {
    syncDurationFromStart();
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
  }, [syncDurationFromStart]);

  const stopAudioStreamTracks = useCallback(() => {
    if (!mediaStreamRef.current) return;
    for (const track of mediaStreamRef.current.getTracks()) {
      track.stop();
    }
    mediaStreamRef.current = null;
  }, []);

  const stopAudioLevelMonitor = useCallback(() => {
    if (audioRafRef.current !== null) {
      cancelAnimationFrame(audioRafRef.current);
      audioRafRef.current = null;
    }
    // Disconnect the MediaStreamSourceNode before closing AudioContext
    mediaStreamSourceRef.current?.disconnect();
    mediaStreamSourceRef.current = null;
    analyserRef.current = null;
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    setAudioLevel(0);
  }, []);

  const stopRecorder = useCallback(
    async (mode: "cancel" | "confirm") => {
      const recorder = mediaRecorderRef.current;
      if (!recorder) return null;

      stopDurationTimer();
      return await new Promise<Blob | null>((resolve) => {
        recorder.onstop = async () => {
          // Skip processing if component unmounted
          if (isCancelledRef.current) {
            resolve(null);
            return;
          }

          const audioBlob = new Blob(audioChunksRef.current, {
            type: recorder.mimeType || "audio/webm",
          });
          audioChunksRef.current = [];
          mediaRecorderRef.current = null;
          stopAudioLevelMonitor();
          stopAudioStreamTracks();
          resolve(mode === "confirm" ? audioBlob : null);
        };
        if (recorder.state === "recording") {
          try {
            recorder.requestData();
          } catch {
            // Keep stop flow if browser does not support requestData while stopping.
          }
        }
        recorder.stop();
      });
    },
    [stopAudioLevelMonitor, stopAudioStreamTracks, stopDurationTimer],
  );

  const handleSilenceTimeout = useCallback(async () => {
    if (silenceStopInFlightRef.current || phaseRef.current !== "recording") {
      return;
    }
    silenceStopInFlightRef.current = true;
    activeRequestIdRef.current = null;
    setPhaseState("idle");
    await stopRecorder("cancel");
    resetVisualState();
    resetVoiceActivityState();
    toast.error(
      t(
        "chat.audioSilenceTimeout",
        "No speech detected for 60 seconds, recording stopped",
      ),
    );
  }, [
    resetVisualState,
    resetVoiceActivityState,
    setPhaseState,
    stopRecorder,
    t,
  ]);

  const cleanupUploadSession = useCallback(async (uploadId: string | null) => {
    if (!uploadId) return;
    try {
      await fetchWithAuth(`/api/ai/v1/upload?uploadId=${uploadId}`, {
        method: "DELETE",
      });
    } catch (error) {
      console.warn("[AudioRecording] Failed to cleanup upload session:", error);
    }
  }, []);

  const startAudioLevelMonitor = useCallback(
    (stream: MediaStream) => {
      if (typeof window === "undefined") return;
      stopAudioLevelMonitor();
      const AudioContextCtor =
        window.AudioContext ||
        (
          window as typeof window & {
            webkitAudioContext?: typeof AudioContext;
          }
        ).webkitAudioContext;
      if (!AudioContextCtor) return;

      const context = new AudioContextCtor();
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.75;
      const source = context.createMediaStreamSource(stream);
      source.connect(analyser);

      audioContextRef.current = context;
      analyserRef.current = analyser;
      mediaStreamSourceRef.current = source;

      const dataArray = new Uint8Array(analyser.fftSize);
      const tick = () => {
        const currentAnalyser = analyserRef.current;
        if (!currentAnalyser) return;
        currentAnalyser.getByteTimeDomainData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const normalized = (dataArray[i] - 128) / 128;
          sum += normalized * normalized;
        }
        const rms = Math.sqrt(sum / dataArray.length);
        const normalized = Math.min(rms * 3.5, 1);
        const now = Date.now();

        if (normalized >= VOICE_ACTIVITY_THRESHOLD) {
          voiceActivityFramesRef.current += 1;
          if (voiceActivityFramesRef.current >= MIN_VOICE_ACTIVITY_FRAMES) {
            hasDetectedSpeechRef.current = true;
            lastVoiceActivityAtRef.current = now;
          }
        } else {
          voiceActivityFramesRef.current = 0;
        }

        setAudioLevel((prev) => prev * 0.6 + normalized * 0.4);
        setWaveformSamples((prev) => {
          const next = [...prev, normalized];
          return next.length > MAX_WAVEFORM_SAMPLES
            ? next.slice(next.length - MAX_WAVEFORM_SAMPLES)
            : next;
        });

        if (
          phaseRef.current === "recording" &&
          !silenceStopInFlightRef.current &&
          lastVoiceActivityAtRef.current !== null &&
          now - lastVoiceActivityAtRef.current >= VOICE_SILENCE_TIMEOUT_MS
        ) {
          void handleSilenceTimeout();
          return;
        }

        audioRafRef.current = requestAnimationFrame(tick);
      };
      tick();
    },
    [handleSilenceTimeout, stopAudioLevelMonitor],
  );

  const isRequestCurrent = useCallback((requestId: string) => {
    return !isCancelledRef.current && activeRequestIdRef.current === requestId;
  }, []);

  const abortProcessingControllers = useCallback(() => {
    uploadAbortControllerRef.current?.abort();
    uploadAbortControllerRef.current = null;
    transcriptionAbortControllerRef.current?.abort();
    transcriptionAbortControllerRef.current = null;
  }, []);

  const isAbortError = useCallback((error: unknown) => {
    return error instanceof DOMException && error.name === "AbortError";
  }, []);

  const uploadAudioForTranscription = useCallback(
    async (audioBlob: Blob, requestId: string) => {
      if (!audioBlob.size) {
        toast.error(t("chat.audioEmpty", "No audio captured, please retry"));
        activeRequestIdRef.current = null;
        setPhaseState("idle");
        resetVisualState();
        resetVoiceActivityState();
        return;
      }
      if (audioBlob.size < MIN_VOICE_UPLOAD_BYTES) {
        toast.error(
          t(
            "chat.audioTooShort",
            "Recording too short or upload incomplete, please hold and speak again",
          ),
        );
        activeRequestIdRef.current = null;
        setPhaseState("idle");
        resetVisualState();
        resetVoiceActivityState();
        return;
      }
      if (audioBlob.size > MAX_VOICE_UPLOAD_BYTES) {
        toast.error(
          t(
            "chat.audioTooLarge",
            "Recording is too large. Please keep it under 50MB and try again.",
          ),
        );
        activeRequestIdRef.current = null;
        setPhaseState("idle");
        resetVisualState();
        resetVoiceActivityState();
        return;
      }

      if (!isRequestCurrent(requestId)) {
        return;
      }

      try {
        const audioType = audioBlob.type?.startsWith("audio/")
          ? audioBlob.type
          : "audio/webm";
        const extension = audioType.includes("mp4")
          ? "m4a"
          : audioType.includes("ogg")
            ? "ogg"
            : audioType.includes("wav")
              ? "wav"
              : "webm";
        const file = new File([audioBlob], `voice-input.${extension}`, {
          type: audioType,
        });

        let response: Response;

        if (isTauriEnv) {
          setPhaseState("transcribing");
          const controller = new AbortController();
          transcriptionAbortControllerRef.current = controller;
          const formData = new FormData();
          formData.append("file", file);
          formData.append("model", DEFAULT_AUDIO_TRANSCRIPTION_MODEL);
          formData.append("response_format", "json");

          response = await fetchWithAuth("/api/ai/v1/audio/transcriptions", {
            method: "POST",
            body: formData,
            signal: controller.signal,
          });
        } else {
          setPhaseState("uploading");
          const uploadController = new AbortController();
          uploadAbortControllerRef.current = uploadController;
          const audioUrl = await uploadImageTUS(file, {
            signal: uploadController.signal,
            onUploadCreated: (uploadId: string) => {
              currentUploadIdRef.current = uploadId;
            },
          });
          uploadAbortControllerRef.current = null;
          currentUploadIdRef.current = null;
          if (!isRequestCurrent(requestId)) {
            return;
          }
          if (!audioUrl) {
            throw new Error("Audio upload failed");
          }

          setPhaseState("transcribing");
          const controller = new AbortController();
          transcriptionAbortControllerRef.current = controller;
          response = await fetchWithAuth("/api/ai/v1/audio/transcriptions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              audio_url: audioUrl,
              model: DEFAULT_AUDIO_TRANSCRIPTION_MODEL,
              response_format: "json",
            }),
            signal: controller.signal,
          });
        }
        transcriptionAbortControllerRef.current = null;

        if (!response.ok) {
          let errorMessage = t(
            "chat.audioTranscriptionFailed",
            "Audio transcription failed, please retry",
          );
          try {
            const data = await response.json();
            errorMessage = data?.error?.message || errorMessage;
          } catch {
            // Keep fallback message when response is not JSON.
          }
          throw new Error(errorMessage);
        }

        if (!isRequestCurrent(requestId)) {
          return;
        }
        const data = await response.json();
        const transcribedText =
          typeof data?.text === "string" ? data.text.trim() : "";
        if (!transcribedText) {
          toast.error(
            t(
              "chat.audioTranscriptionEmpty",
              "No speech detected, please try again",
            ),
          );
          activeRequestIdRef.current = null;
          setPhaseState("idle");
          resetVisualState();
          resetVoiceActivityState();
          return;
        }

        const looksLikeMissingAudioPayload =
          /provide the audio|upload.*audio|link to the audio/i.test(
            transcribedText,
          );
        if (looksLikeMissingAudioPayload) {
          toast.error(
            t(
              "chat.audioPayloadRejected",
              "Audio was not accepted by the transcription service. Please try again or check your connection.",
            ),
          );
          activeRequestIdRef.current = null;
          setPhaseState("idle");
          resetVisualState();
          resetVoiceActivityState();
          return;
        }

        // Skip callback if component was unmounted during async work
        if (isRequestCurrent(requestId)) {
          onTranscriptionCompleteRef.current(transcribedText);
          activeRequestIdRef.current = null;
          setPhaseState("idle");
          resetVisualState();
          resetVoiceActivityState();
        }
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }
        if (!isCancelledRef.current && isRequestCurrent(requestId)) {
          const message =
            error instanceof Error
              ? error.message
              : t(
                  "chat.audioTranscriptionFailed",
                  "Audio transcription failed, please retry",
                );
          toast.error(message);
          activeRequestIdRef.current = null;
          setPhaseState("idle");
          resetVisualState();
          resetVoiceActivityState();
        }
      } finally {
        uploadAbortControllerRef.current = null;
        transcriptionAbortControllerRef.current = null;
        if (
          currentUploadIdRef.current &&
          activeRequestIdRef.current !== requestId
        ) {
          void cleanupUploadSession(currentUploadIdRef.current);
          currentUploadIdRef.current = null;
        }
      }
    },
    [
      cleanupUploadSession,
      isAbortError,
      isRequestCurrent,
      resetVisualState,
      resetVoiceActivityState,
      setPhaseState,
      t,
    ],
  );

  const confirmRecording = useCallback(async () => {
    if (phase !== "recording") return;
    const requestId = crypto.randomUUID();
    activeRequestIdRef.current = requestId;
    setPhaseState("preparing");
    const audioBlob = await stopRecorder("confirm");
    if (!audioBlob || !isRequestCurrent(requestId)) {
      return;
    }

    if (!hasDetectedSpeechRef.current) {
      activeRequestIdRef.current = null;
      setPhaseState("idle");
      resetVisualState();
      resetVoiceActivityState();
      toast.error(
        t(
          "chat.audioNoSpeechDetected",
          "No clear speech detected, please speak and try again",
        ),
      );
      return;
    }

    try {
      const wavBlob = await convertWebmToWav(audioBlob);
      if (!isRequestCurrent(requestId)) {
        return;
      }
      await uploadAudioForTranscription(wavBlob, requestId);
    } catch (convertError) {
      if (!isRequestCurrent(requestId)) {
        return;
      }
      console.error(
        "Audio conversion failed, falling back to original:",
        convertError,
      );
      await uploadAudioForTranscription(audioBlob, requestId);
    }
  }, [
    isRequestCurrent,
    phase,
    resetVisualState,
    resetVoiceActivityState,
    setPhaseState,
    stopRecorder,
    t,
    uploadAudioForTranscription,
  ]);

  const startRecording = useCallback(async () => {
    if (phase !== "idle") return;

    // Guard against rapid double-click
    if (isStartingRef.current) return;
    isStartingRef.current = true;

    if (
      typeof window === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      isStartingRef.current = false;
      toast.error(
        t(
          "chat.audioNotSupported",
          "Current environment does not support audio recording",
        ),
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      mediaStreamRef.current = stream;
      audioChunksRef.current = [];

      const mimeType = getSupportedAudioMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => {
        stopDurationTimer();
        setPhaseState("idle");
        audioChunksRef.current = [];
        stopAudioLevelMonitor();
        stopAudioStreamTracks();
        resetVisualState();
        resetVoiceActivityState();
        toast.error(
          t("chat.audioRecordFailed", "Audio recording failed, please retry"),
        );
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250);
      startAudioLevelMonitor(stream);
      resetVoiceActivityState();
      recordingStartedAtRef.current = Date.now();
      lastVoiceActivityAtRef.current = Date.now();
      setWaveformSamples([]);
      syncDurationFromStart();
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
      }
      durationIntervalRef.current = setInterval(() => {
        syncDurationFromStart();
      }, 250);
      setPhaseState("recording");
    } catch (error) {
      console.error("Failed to start audio recording:", error);
      stopAudioLevelMonitor();
      stopAudioStreamTracks();
      resetVoiceActivityState();
      toast.error(
        t(
          "chat.audioPermissionDenied",
          "Microphone permission denied, please enable and retry",
        ),
      );
    } finally {
      isStartingRef.current = false;
    }
  }, [
    phase,
    startAudioLevelMonitor,
    resetVisualState,
    resetVoiceActivityState,
    setPhaseState,
    syncDurationFromStart,
    stopAudioLevelMonitor,
    stopAudioStreamTracks,
    stopDurationTimer,
    t,
  ]);

  const cancelRecording = useCallback(async () => {
    if (phase !== "recording") return;
    setPhaseState("idle");
    await stopRecorder("cancel");
    resetVisualState();
    resetVoiceActivityState();
  }, [
    phase,
    resetVisualState,
    resetVoiceActivityState,
    setPhaseState,
    stopRecorder,
  ]);

  const cancelProcessing = useCallback(() => {
    if (!isVoiceProcessingPhase(phase)) return;
    const uploadId = currentUploadIdRef.current;
    activeRequestIdRef.current = null;
    currentUploadIdRef.current = null;
    abortProcessingControllers();
    stopDurationTimer();
    setPhaseState("idle");
    resetVisualState();
    resetVoiceActivityState();
    if (uploadId) {
      void cleanupUploadSession(uploadId);
    }
  }, [
    abortProcessingControllers,
    cleanupUploadSession,
    phase,
    resetVisualState,
    resetVoiceActivityState,
    setPhaseState,
    stopDurationTimer,
  ]);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // Keep cancellation state in sync with mount/unmount.
  // This avoids Strict Mode dev remounts leaving the hook permanently cancelled.
  useEffect(() => {
    isCancelledRef.current = false;
    return () => {
      isCancelledRef.current = true;
      activeRequestIdRef.current = null;
      phaseRef.current = "idle";
      resetVoiceActivityState();
      stopDurationTimer();
      abortProcessingControllers();
      if (currentUploadIdRef.current) {
        void cleanupUploadSession(currentUploadIdRef.current);
        currentUploadIdRef.current = null;
      }
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state !== "inactive"
      ) {
        mediaRecorderRef.current.stop();
      }
      stopAudioLevelMonitor();
      stopAudioStreamTracks();
    };
  }, [
    abortProcessingControllers,
    cleanupUploadSession,
    resetVoiceActivityState,
    stopAudioLevelMonitor,
    stopAudioStreamTracks,
    stopDurationTimer,
  ]);

  return {
    phase,
    isRecordingAudio: phase === "recording",
    isTranscribingAudio: phase === "transcribing",
    isProcessingAudio: isVoiceProcessingPhase(phase),
    audioLevel,
    waveformSamples,
    durationSeconds,
    durationText: formatVoiceDuration(durationSeconds),
    canCancel: phase === "recording" || isVoiceProcessingPhase(phase),
    canConfirm: phase === "recording",
    startRecording,
    confirmRecording,
    cancelRecording,
    cancelProcessing,
  };
}
