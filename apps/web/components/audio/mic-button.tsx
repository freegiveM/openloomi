"use client";

import React, { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Mic, Square, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useVoice } from "./voice-provider";
import { useAudioRecording } from "@/hooks/use-audio-recording";

interface MicButtonProps {
  onTranscriptionComplete: (text: string) => void;
  disabled?: boolean;
}

export function MicButton({ onTranscriptionComplete, disabled }: MicButtonProps) {
  const { whisper } = useVoice();
  const { t } = useTranslation();

  const {
    phase,
    startRecording,
    confirmRecording,
    cancelRecording,
    audioLevel,
  } = useAudioRecording({
    onTranscriptionComplete,
  });

  // Whisper STT is disabled, hide the Mic UI
  if (!whisper.enabled) {
    return null;
  }

  const isRecording = phase === "recording";
  const isTranscribing = phase === "transcribing" || phase === "uploading";

  if (isTranscribing) {
    return (
      <Button variant="ghost" size="icon" disabled className="h-8 w-8 shrink-0">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </Button>
    );
  }

  if (isRecording) {
    // Dynamic scale based on audio level
    const scale = 1 + Math.min(audioLevel, 1) * 0.5;
    return (
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => confirmRecording()}
          className="h-8 w-8 shrink-0 relative text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/50"
          title={t("chat.stopRecording", "Stop recording")}
        >
          <div 
            className="absolute inset-0 rounded-full bg-red-500/20"
            style={{ transform: `scale(${scale})`, transition: 'transform 0.05s ease-out' }}
          />
          <Square className="h-4 w-4 fill-current z-10" />
        </Button>
      </div>
    );
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
      disabled={disabled}
      onClick={() => startRecording()}
      title={t("chat.startRecording", "Start recording")}
    >
      <Mic className="h-5 w-5" />
    </Button>
  );
}
