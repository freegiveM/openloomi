"use client";

import type { ReactNode } from "react";
import { RemixIcon } from "@/components/remix-icon";
import { getUploadFileIconSrc } from "@/components/file/file-icon-src";
import { cn, formatBytes, getFileTypeLabel } from "@/lib/utils";

type ComposerAttachmentCardProps = {
  name: string;
  mediaType?: string;
  sizeBytes?: number;
  onRemove?: () => void;
  removeAriaLabel?: string;
  actionsSlot?: ReactNode;
  isBusy?: boolean;
  statusLabel?: string;
  dataTestId?: string;
};

function getAttachmentIconSrc(
  mediaType: string | undefined,
  name: string,
): string {
  const trimmedName = name.trim();
  if (trimmedName.includes(".")) {
    const extension = trimmedName.split(".").pop() ?? "";
    return getUploadFileIconSrc(extension);
  }

  const trimmedMediaType = mediaType?.trim() ?? "";
  if (trimmedMediaType) {
    return getUploadFileIconSrc(trimmedMediaType);
  }

  return getUploadFileIconSrc("");
}

function getAttachmentTypeLabel(
  mediaType: string | undefined,
  name: string,
): string {
  if (name.includes(".")) {
    return getFileTypeLabel(name);
  }

  if (mediaType?.includes("/")) {
    const subtype = mediaType.split("/").pop()?.split(";")[0]?.trim();
    if (subtype) {
      return getFileTypeLabel(`file.${subtype}`);
    }
  }

  return getFileTypeLabel(name);
}

export function ComposerAttachmentCard({
  name,
  mediaType,
  sizeBytes,
  onRemove,
  removeAriaLabel,
  actionsSlot,
  isBusy = false,
  statusLabel = "Uploading...",
  dataTestId,
}: ComposerAttachmentCardProps) {
  const fileTypeLabel = getAttachmentTypeLabel(mediaType, name);
  const metaText = isBusy
    ? statusLabel
    : Number.isFinite(sizeBytes)
      ? `${fileTypeLabel} · ${formatBytes(sizeBytes ?? 0, 2)}`
      : fileTypeLabel;
  const iconSrc = getAttachmentIconSrc(mediaType, name);
  const showTitleActions = Boolean(actionsSlot) || Boolean(onRemove);

  return (
    <div
      className={cn(
        "group relative flex h-[54px] w-[240px] shrink-0 items-center gap-2 overflow-hidden rounded-[8px] border p-2 transition-colors",
        isBusy ? "border-[#D9D9D9] bg-[#F7F7F7]" : "border-[#E9E9E9] bg-white",
      )}
      style={{ fontFamily: "PingFang SC, PingFang SC" }}
      data-testid={dataTestId}
      data-uploading={isBusy ? "true" : undefined}
      aria-busy={isBusy}
    >
      <div className="relative flex h-8 w-8 shrink-0 items-center justify-center">
        <img
          src={iconSrc}
          alt=""
          draggable={false}
          className={cn(
            "h-8 w-8 object-contain transition-opacity",
            isBusy && "opacity-60",
          )}
          aria-hidden
        />
        {isBusy ? (
          <span className="absolute -right-1 -bottom-1 inline-flex size-4 items-center justify-center rounded-full border border-white bg-white text-[#595959] shadow-sm">
            <span className="inline-flex size-3 animate-spin items-center justify-center">
              <RemixIcon name="loader_4" size="size-3" className="text-xs" />
            </span>
          </span>
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative flex h-5 max-w-full items-center">
          <div
            title={name}
            className={cn(
              "min-w-0 flex-1 truncate pr-5 text-left text-[14px] leading-5 font-normal",
              isBusy ? "text-[#595959]" : "text-[#000000]",
            )}
          >
            {name}
          </div>
          {showTitleActions ? (
            <div className="absolute top-1/2 right-0 flex -translate-y-1/2 items-center gap-1">
              {actionsSlot}
              {onRemove ? (
                <button
                  type="button"
                  onClick={onRemove}
                  className="pointer-events-none invisible inline-flex size-4 items-center justify-center rounded-full bg-[#8C8C8C] text-white opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:visible group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:visible group-focus-within:opacity-100 hover:bg-[#595959] focus-visible:pointer-events-auto focus-visible:visible focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={isBusy}
                  aria-label={removeAriaLabel}
                >
                  {isBusy ? (
                    <span className="inline-flex size-3 animate-spin items-center justify-center">
                      <RemixIcon
                        name="loader_4"
                        size="size-3"
                        className="text-xs"
                      />
                    </span>
                  ) : (
                    <RemixIcon name="close" size="size-3" />
                  )}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <div
          title={metaText}
          className={cn(
            "h-[18px] w-[161px] max-w-full truncate text-left text-[12px] leading-[18px] font-normal",
            isBusy ? "text-[#737373]" : "text-[#000000]",
          )}
        >
          {metaText}
        </div>
      </div>
      {isBusy ? (
        <div className="absolute inset-x-0 bottom-0 h-[2px] overflow-hidden bg-[#E9E9E9]">
          <div className="h-full w-full animate-[shimmer_1.2s_linear_infinite] bg-[linear-gradient(90deg,transparent,#8C8C8C,transparent)] bg-[length:200%_100%]" />
        </div>
      ) : null}
    </div>
  );
}
