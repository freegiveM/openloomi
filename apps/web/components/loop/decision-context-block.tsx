"use client";

/**
 * Decision context block (#363) — renders the user-facing facts a person
 * needs to decide on a card (time, organizer, attendance, location,
 * conflict for RSVP). Pure renderer: the heavy lifting (date formatting,
 * label selection, link extraction) happens in `lib/loop/decision-context.ts`
 * so this component stays a thin presentation layer.
 *
 * The block is type-dispatched: today only RSVP has a registered variant,
 * but the shape is intentionally open so `draft_reply` / `review_pr` /
 * `deadline_reminder` can adopt the same architecture without changing
 * this file's contract. Unknown types render nothing — the parent card
 * keeps its existing layout.
 */

import { useTranslation } from "react-i18next";

import { RemixIcon } from "@/components/remix-icon";
import { cn } from "@/lib/utils";

import type {
  DecisionContext,
  DecisionContextField,
} from "@/lib/loop/decision-context";

interface DecisionContextBlockProps {
  /**
   * The pre-resolved context from `deriveDecisionContext`. When `null`
   * (or omitted) the block renders nothing — the parent decides whether
   * to wrap it in a section heading.
   */
  context: DecisionContext | null;
  /**
   * Optional `now` for client-side relative labels. The helper already
   * formatted them so this is currently unused; reserved for a follow-up
   * that re-renders the block on a clock tick.
   */
  className?: string;
}

export function DecisionContextBlock({
  context,
  className,
}: DecisionContextBlockProps) {
  const { t } = useTranslation();
  if (!context || context.fields.length === 0) return null;
  return (
    <section
      aria-label={t("loop.rsvp.technicalDetails", "Decision context")}
      className={cn("rounded-md border bg-muted/20 px-3 py-2.5", className)}
    >
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5 text-xs">
        {context.fields.map((field) => (
          <ContextRow key={field.label} field={field} />
        ))}
      </dl>
    </section>
  );
}

function ContextRow({ field }: { field: DecisionContextField }) {
  const { t } = useTranslation();
  // `value` may already be an i18n key (e.g. "loop.rsvp.conflictNone") when
  // the helper wants the renderer to localize the placeholder. Resolve via
  // `t(key, fallback)` so a missing key still renders sensibly.
  const rendered =
    field.value.startsWith("loop.") && !field.value.includes(" ")
      ? t(field.value, field.value)
      : field.value;
  return (
    <>
      <dt className="flex items-center gap-1.5 text-muted-foreground">
        <RemixIcon name={field.icon} className="size-3.5 shrink-0" />
        <span className="font-medium">{t(field.label, field.label)}</span>
      </dt>
      <dd className="min-w-0 break-words text-foreground/90">
        {field.href ? (
          <a
            href={field.href}
            target="_blank"
            rel="noreferrer"
            className="underline-offset-2 hover:underline"
          >
            {rendered}
          </a>
        ) : (
          rendered
        )}
      </dd>
    </>
  );
}
