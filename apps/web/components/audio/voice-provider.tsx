"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useMemo,
} from "react";
import { KokoroPlugin } from "@melandlabs/voice-kokoro";
import { WhisperPlugin } from "@melandlabs/voice-whisper";

interface VoiceContextValue {
  kokoro: KokoroPlugin;
  whisper: WhisperPlugin;
  setKokoroEnabled: (enabled: boolean) => void;
  setWhisperEnabled: (enabled: boolean) => void;
}

const VoiceContext = createContext<VoiceContextValue | undefined>(undefined);
const DISABLED_ENV_VALUES = new Set(["0", "false", "off", "no", "disabled"]);

function isEnabledByEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return true;
  return !DISABLED_ENV_VALUES.has(normalized);
}

const isKokoroEnabledByEnv = isEnabledByEnv(
  process.env.NEXT_PUBLIC_ENABLE_KOKORO,
);
const isWhisperEnabledByEnv = isEnabledByEnv(
  process.env.NEXT_PUBLIC_ENABLE_WHISPER,
);

export function VoiceProvider({ children }: { children: React.ReactNode }) {
  // We initialize the plugins and allow toggling them dynamically via state
  const [kokoro] = useState(
    () => new KokoroPlugin({ enabled: isKokoroEnabledByEnv }),
  );
  const [whisper] = useState(
    () => new WhisperPlugin({ enabled: isWhisperEnabledByEnv }),
  );

  // Bump this when runtime toggles change so effects can react.
  const [voiceVersion, setVoiceVersion] = useState(0);

  useEffect(() => {
    if (!kokoro.enabled) return;

    void kokoro.warmup().catch((error) => {
      console.warn("[VoiceProvider] Kokoro warmup failed:", error);
    });
  }, [kokoro, voiceVersion]);

  const contextValue = useMemo(
    () => ({
      kokoro,
      whisper,
      setKokoroEnabled: (enabled: boolean) => {
        kokoro.enabled = isKokoroEnabledByEnv && enabled;
        setVoiceVersion((version) => version + 1);
      },
      setWhisperEnabled: (enabled: boolean) => {
        whisper.enabled = isWhisperEnabledByEnv && enabled;
        setVoiceVersion((version) => version + 1);
      },
    }),
    [kokoro, whisper],
  );

  return (
    <VoiceContext.Provider value={contextValue}>
      {children}
    </VoiceContext.Provider>
  );
}

export function useVoice() {
  const context = useContext(VoiceContext);
  if (!context) {
    throw new Error("useVoice must be used within a VoiceProvider");
  }
  return context;
}
