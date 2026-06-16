"use client";

import { memo } from "react";
import { cn } from "@/lib/utils";
import type { VoiceInputPhase, WaveformSample } from "@/lib/audio/voice-input";

interface VoiceWaveformProps {
  samples: WaveformSample[];
  phase: VoiceInputPhase;
  className?: string;
}

const WAVEFORM_SLOT_COUNT = 48;

function PureVoiceWaveform({ samples, phase, className }: VoiceWaveformProps) {
  const visibleSamples = (
    samples.length > WAVEFORM_SLOT_COUNT
      ? samples.slice(samples.length - WAVEFORM_SLOT_COUNT)
      : samples
  )
    .slice()
    .reverse();
  const slots = Array.from({ length: WAVEFORM_SLOT_COUNT }, (_, slotIndex) => {
    const sample = visibleSamples[slotIndex] ?? null;
    return {
      key:
        sample == null
          ? `empty-slot-${slotIndex + 1}`
          : `sample-slot-${slotIndex + 1}-${sample.toFixed(3)}`,
      sample,
    };
  });
  const isProcessing =
    phase === "preparing" || phase === "uploading" || phase === "transcribing";

  return (
    <div
      className={cn("relative h-8 overflow-hidden", className)}
      aria-hidden="true"
    >
      <div
        className="grid h-8 items-center gap-[2px]"
        style={{
          gridTemplateColumns: `repeat(${WAVEFORM_SLOT_COUNT}, minmax(0, 1fr))`,
        }}
      >
        {slots.map(({ key, sample }) => {
          const normalized =
            sample == null ? 0 : Math.max(0, Math.min(sample, 1));
          const hasVoice = normalized > 0.08;
          const height = hasVoice ? 2 + Math.round(normalized * 22) : 2;
          return (
            <span key={key} className="flex h-full items-center justify-center">
              <span
                className={cn(
                  "w-[2px] rounded-full transition-[height,background-color,opacity] duration-150",
                  hasVoice ? "bg-[#1D1D1D]" : "bg-[#B8B8B8]",
                  isProcessing ? "opacity-65" : "opacity-100",
                )}
                style={{
                  height: `${height}px`,
                }}
              />
            </span>
          );
        })}
      </div>
    </div>
  );
}

export const VoiceWaveform = memo(PureVoiceWaveform);
