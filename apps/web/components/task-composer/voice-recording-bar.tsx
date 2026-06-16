"use client";

import { memo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { VoiceInputPhase, WaveformSample } from "@/lib/audio/voice-input";
import { RemixIcon } from "@/components/remix-icon";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { VoiceWaveform } from "./voice-waveform";

interface VoiceRecordingBarProps {
  phase: VoiceInputPhase;
  durationText: string;
  waveformSamples: WaveformSample[];
  onCancel: () => void;
  onConfirm: () => void;
  disableCancel?: boolean;
  disableConfirm?: boolean;
}

function PureVoiceRecordingBar({
  phase,
  durationText,
  waveformSamples,
  onCancel,
  onConfirm,
  disableCancel = false,
  disableConfirm = false,
}: VoiceRecordingBarProps) {
  const { t } = useTranslation();
  const isProcessing =
    phase === "preparing" || phase === "uploading" || phase === "transcribing";
  const cancelLabel = isProcessing
    ? t("chat.audioCancel", "Cancel recording")
    : t("chat.audioCancel", "Cancel recording");
  const confirmLabel = isProcessing
    ? t("chat.audioProcessing", "Processing audio")
    : t("chat.audioConfirm", "Confirm recording");

  return (
    <div className="flex min-h-[32px] items-center">
      <div className="min-w-0 flex-1">
        <div className="flex items-center">
          <VoiceWaveform
            samples={waveformSamples}
            phase={phase}
            className="min-w-0 flex-1"
          />
          <span className="ml-4 min-w-[52px] shrink-0 text-right text-[15px] font-normal tabular-nums text-[#5F5F5F]">
            {durationText}
          </span>
        </div>
      </div>

      <div className="ml-4 flex shrink-0 items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-full bg-[#E7E7E7] text-[#222222] transition-colors hover:bg-[#DCDCDC] disabled:cursor-not-allowed disabled:opacity-50",
              )}
              onClick={onCancel}
              disabled={disableCancel}
              aria-label={cancelLabel}
            >
              <RemixIcon name="close" size="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <span className="text-xs">{cancelLabel}</span>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-full bg-[#E7E7E7] text-[#222222] transition-colors hover:bg-[#DCDCDC] disabled:cursor-not-allowed disabled:opacity-60",
              )}
              onClick={onConfirm}
              disabled={disableConfirm}
              aria-label={confirmLabel}
            >
              {isProcessing ? (
                <span className="size-4 animate-spin rounded-full border-2 border-[#7A7A7A]/70 border-t-[#222222]" />
              ) : (
                <RemixIcon name="check" size="size-4" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <span className="text-xs">{confirmLabel}</span>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

export const VoiceRecordingBar = memo(PureVoiceRecordingBar);
