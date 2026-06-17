"use client";

import React, { createContext, useContext, useState, useMemo } from "react";
import { KokoroPlugin } from "@openloomi/voice-kokoro";
import { WhisperPlugin } from "@openloomi/voice-whisper";

interface VoiceContextValue {
  kokoro: KokoroPlugin;
  whisper: WhisperPlugin;
  setKokoroEnabled: (enabled: boolean) => void;
  setWhisperEnabled: (enabled: boolean) => void;
}

const VoiceContext = createContext<VoiceContextValue | undefined>(undefined);

export function VoiceProvider({ children }: { children: React.ReactNode }) {
  // We initialize the plugins and allow toggling them dynamically via state
  const [kokoro] = useState(() => new KokoroPlugin({ enabled: true }));
  const [whisper] = useState(() => new WhisperPlugin({ enabled: true }));

  // Dummy state updates to force re-renders if enabled flags change
  const [, setTick] = useState(0);

  const contextValue = useMemo(() => ({
    kokoro,
    whisper,
    setKokoroEnabled: (enabled: boolean) => {
      kokoro.enabled = enabled;
      setTick((t) => t + 1);
    },
    setWhisperEnabled: (enabled: boolean) => {
      whisper.enabled = enabled;
      setTick((t) => t + 1);
    }
  }), [kokoro, whisper]);

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
