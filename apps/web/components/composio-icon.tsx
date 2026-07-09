"use client";

import { cn } from "@/lib/utils";

/**
 * Composio brand mark — a stylized "C" inside a hexagonal frame.
 *
 * Implemented as a single `<path>` with `fill-rule="evenodd"` so the inner
 * "C" reads as a negative-space cutout. This avoids depending on the page
 * background color and works on any container the icon is dropped into.
 * The whole mark inherits color via `currentColor`.
 */
export function ComposioIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Composio"
      className={cn(
        "inline-flex items-center justify-center shrink-0 leading-none",
        className,
      )}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        fill="currentColor"
        d="M16 2.5 4 9.25v13.5L16 29.5l12-6.75V9.25L16 2.5ZM20 11.5h-8a3.5 3.5 0 0 0-3.5 3.5v2a3.5 3.5 0 0 0 3.5 3.5h8v-2.6h-8a.9.9 0 0 1-.9-.9v-2a.9.9 0 0 1 .9-.9h8v-2.6Z"
      />
    </svg>
  );
}
