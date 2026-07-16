"use client";

/**
 * Loop decision card — one typed card the Loop surfaces to the pet / web UI.
 *
 * Renders:
 *  - Type-specific icon + title row + confidence badge
 *  - "Dialogue" — the natural-language ask the Loop is making of the user
 *  - Source chain (signal → contact → project → memory refs)
 *  - "Why" bullets the enrich stage produced
 *  - Action buttons (Dry Run / Edit / Run / Dismiss) — the B3 wiring will
 *    move these to a dedicated route; for now they call the action API
 *    directly so the card is interactive on its own.
 *
 * Statuses:
 *  - pending  → 4 action buttons visible
 *  - done     → "Ran at <ts>" footer, action buttons hidden
 *  - dismissed → "Dismissed" footer with optional reason, action buttons hidden
 *
 * Custom decision types: the user can register new `type` strings via
 * `PUT /api/loop/types`. Built-in `TYPE_ICON` / `TYPE_LABEL` are static
 * at module load; the per-user extensions are fetched once on mount and
 * merged at render time via the `customTypeMeta` lookup below. When the
 * fetch fails or is empty, the card falls back to the built-ins
 * (`ri-question-line` / raw type id) so unknown types still render.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";

import { Button } from "@openloomi/ui";
import { cn } from "@/lib/utils";
import { RemixIcon } from "@/components/remix-icon";
import { Spinner } from "@/components/spinner";
import { toast } from "@/components/toast";
import {
  canExecute,
  deriveReadiness,
  derivePriority,
  readinessState,
  stateLabel,
  type DecisionState,
  type LoopPriority,
} from "@/lib/loop/readiness";
import type {
  DecisionReadiness,
  DecisionRelationship,
  LoopDecisionExecution,
} from "@/lib/loop/types";

import { LoopSourceChain, type SourceChainNode } from "./source-chain";

export type LoopActionKind = "run" | "dry" | "dismiss" | "promote";

export interface LoopDecisionCardData {
  id: string;
  type: string;
  title: string;
  status: "pending" | "done" | "dismissed";
  confidence?: number;
  /** #359 — decision readiness (gates execution). Derived when absent. */
  readiness?: DecisionReadiness;
  /** #359 — relationship context (optional colour). */
  relationship?: DecisionRelationship;
  ts: string;
  completed_at?: string;
  result?: unknown;
  /** #358 — structured execution verdict from the runner. Drives the
   *  footer / re-run UX so the card doesn't claim "done / Ran at" when
   *  the agent actually refused. */
  execution?: LoopDecisionExecution;
  /** Pre-built card fields (set when the card is built via /api/loop/card/[id]). */
  why?: string[];
  dialogue?: string;
  nextStep?: string;
  /** Optional pre-rendered chain. Falls back to source_signal when missing. */
  source_chain?: Array<SourceChainNode | string>;
  context?: {
    why?: string[];
    memory_refs?: string[];
    person?: string | null;
    project_ref?: string | null;
    last_error?: string;
    [key: string]: unknown;
  };
  source_signal?: {
    source: string;
    type: string;
    ts?: string;
    payload?: Record<string, unknown>;
  };
  action?: { kind: string; params: Record<string, unknown> };
}

interface DecisionCardProps {
  decision: LoopDecisionCardData;
  onChange?: () => void;
  className?: string;
  /** When true, render in compact form (no body, no actions). */
  compact?: boolean;
}

const TYPE_ICON: Record<string, string> = {
  rsvp: "ri-calendar-check-line",
  draft_reply: "ri-mail-send-line",
  review_pr: "ri-git-pull-request-line",
  todo: "ri-checkbox-circle-line",
  slack_reply: "ri-slack-line",
  deadline_reminder: "ri-time-line",
  release_plan: "ri-rocket-line",
  requirement_synthesis: "ri-file-list-3-line",
  linear_review: "ri-list-check-2",
  contact_update: "ri-user-settings-line",
  doc_update: "ri-file-edit-line",
  brief: "ri-sun-line",
  wrap: "ri-moon-line",
  unknown: "ri-question-line",
};

const TYPE_LABEL: Record<string, string> = {
  rsvp: "RSVP",
  draft_reply: "Draft reply",
  review_pr: "Review PR",
  todo: "Todo",
  slack_reply: "Slack reply",
  deadline_reminder: "Deadline",
  release_plan: "Release plan",
  requirement_synthesis: "Requirement",
  linear_review: "Linear review",
  contact_update: "Contact update",
  doc_update: "Doc update",
  brief: "Morning brief",
  wrap: "Evening wrap",
};

interface CustomTypeMeta {
  icon: string;
  label: string;
}

/**
 * Per-card hook that fetches the user's custom decision types once on
 * mount and exposes a `lookup(type) → {icon,label}` helper. Returns
 * `null` for types the user has not registered, so callers can fall
 * back to the built-in `TYPE_ICON` / `TYPE_LABEL` constants. Never
 * throws — a failed fetch is treated as "no custom types".
 */
function useCustomTypeMeta(): {
  lookup: (type: string) => CustomTypeMeta | null;
} {
  const [customTypes, setCustomTypes] = useState<
    Record<string, CustomTypeMeta>
  >({});
  useEffect(() => {
    let cancelled = false;
    const apiBase =
      typeof window !== "undefined" &&
      (window as unknown as { __OPENLOOMI_API__?: string }).__OPENLOOMI_API__
        ? (window as unknown as { __OPENLOOMI_API__: string }).__OPENLOOMI_API__
        : "";
    fetch(`${apiBase}/api/loop/types`, {
      credentials: "include",
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: unknown) => {
        if (cancelled || !data || typeof data !== "object") return;
        const list = (data as { types?: unknown }).types;
        if (!Array.isArray(list)) return;
        const out: Record<string, CustomTypeMeta> = {};
        for (const item of list) {
          if (!item || typeof item !== "object") continue;
          const t = item as {
            id?: unknown;
            label?: unknown;
            icon?: unknown;
          };
          if (typeof t.id !== "string" || !t.id) continue;
          const icon =
            typeof t.icon === "string" && t.icon.length > 0
              ? t.icon
              : "ri-question-line";
          const label =
            typeof t.label === "string" && t.label.length > 0 ? t.label : t.id;
          out[t.id] = { icon, label };
        }
        if (!cancelled) setCustomTypes(out);
      })
      .catch(() => {
        /* best-effort — built-in dispatch tables still apply */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const lookup = useMemo(
    () => (type: string) => customTypes[type] ?? null,
    [customTypes],
  );
  return { lookup };
}

function priorityTone(priority: LoopPriority): string {
  if (priority === "P0") return "bg-red-100 text-red-700";
  if (priority === "P1") return "bg-amber-100 text-amber-700";
  return "bg-muted text-muted-foreground";
}

/** Tone for the plain-language decision-state pill — the primary surface. */
function stateTone(state: DecisionState): string {
  switch (state) {
    case "ready":
      return "bg-emerald-100 text-emerald-700";
    case "confirm":
      return "bg-amber-100 text-amber-700";
    case "needs_context":
      return "bg-sky-100 text-sky-700";
    case "not_actionable":
      return "bg-muted text-muted-foreground";
  }
}

function ActionButton({
  icon,
  label,
  variant,
  onClick,
  pending,
}: {
  icon: string;
  label: string;
  variant?: "default" | "outline" | "ghost" | "destructive" | "secondary";
  onClick: () => void;
  pending?: boolean;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={variant ?? "outline"}
      onClick={onClick}
      disabled={pending}
      className="gap-1.5"
    >
      {pending ? (
        <Spinner size={14} label="" className="!size-3.5" />
      ) : (
        <RemixIcon name={icon} className="size-3.5" />
      )}
      {label}
    </Button>
  );
}

export function DecisionCard({
  decision,
  onChange,
  className,
  compact,
}: DecisionCardProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const [pendingAction, setPendingAction] = useState<LoopActionKind | null>(
    null,
  );
  const { lookup: lookupCustomType } = useCustomTypeMeta();

  // User-defined types win when present; built-ins are the fallback so
  // the card never renders an undefined icon for an unknown id.
  const custom = lookupCustomType(decision.type);
  const typeIcon =
    custom?.icon ?? TYPE_ICON[decision.type] ?? TYPE_ICON.unknown;
  const typeLabel = custom?.label ?? TYPE_LABEL[decision.type] ?? decision.type;
  // #359 — priority is derived from urgency × impact (via readiness), NOT
  // from classification confidence. The plain-language `state` is the
  // primary decision surface; `confidence` is demoted to diagnostics.
  const priority = derivePriority(decision);
  const readiness = deriveReadiness(decision);
  const state = readinessState(decision);
  const stateMeta = stateLabel(state);
  const executable = canExecute(readiness);
  const priorityCls = priorityTone(priority);

  const whyBullets = decision.why ?? decision.context?.why ?? [];
  const dialogue =
    decision.dialogue ??
    (decision.type === "draft_reply"
      ? t(
          "loop.dialogue.draftReply",
          "This email looks like it's waiting on you — should I draft a reply?",
        )
      : `New ${typeLabel.toLowerCase()} decision`);
  const nextStep =
    decision.nextStep ??
    t("loop.nextStep.tapRun", "Tap Run to let the agent handle this decision.");

  async function act(action: LoopActionKind) {
    if (decision.status !== "pending") return;
    setPendingAction(action);
    try {
      const res = await fetch(`/api/loop/decision/${decision.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        toast({
          type: "error",
          description: t("loop.actionFailed", "Action failed: {{msg}}", {
            msg: data?.error ?? res.statusText,
          }),
        });
      } else {
        const labels: Record<LoopActionKind, string> = {
          dry: t("loop.dryRan", "Dry run completed"),
          run: t("loop.ran", "Decision executed"),
          dismiss: t("loop.dismissed", "Dismissed"),
          promote: t("loop.promoted", "Promoted"),
        };
        toast({ type: "success", description: labels[action] });
        onChange?.();
      }
    } catch (e) {
      toast({
        type: "error",
        description: t("loop.actionFailed", "Action failed: {{msg}}", {
          msg: e instanceof Error ? e.message : "unknown",
        }),
      });
    } finally {
      setPendingAction(null);
    }
  }

  if (compact) {
    return (
      <button
        type="button"
        onClick={() => router.push(`/loop/${decision.id}`)}
        className={cn(
          "flex w-full items-start gap-3 rounded-md border bg-card p-3 text-left transition hover:border-primary/40 hover:bg-accent/30",
          className,
        )}
      >
        <RemixIcon name={typeIcon} className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-1 text-sm font-medium">
            {decision.title}
          </div>
          <div className="line-clamp-1 text-xs text-muted-foreground">
            {dialogue}
          </div>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold",
            stateTone(state),
          )}
        >
          {t(stateMeta.key, stateMeta.fallback)}
        </span>
      </button>
    );
  }

  const isPending = decision.status === "pending";
  const chain = buildChain(decision);

  return (
    <article
      className={cn(
        "flex flex-col gap-4 rounded-lg border bg-card p-5 shadow-sm",
        decision.status === "dismissed" && "opacity-60",
        className,
      )}
    >
      {/* Title row */}
      <header className="flex items-start gap-3">
        <div
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-md",
            priorityCls,
          )}
        >
          <RemixIcon name={typeIcon} className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {typeLabel}
            </span>
            {/* Primary decision surface — plain-language readiness state. */}
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-semibold",
                stateTone(state),
              )}
            >
              {t(stateMeta.key, stateMeta.fallback)}
            </span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-semibold",
                priorityCls,
              )}
            >
              {priority}
            </span>
            {/* Classification confidence — diagnostic, kept muted + secondary. */}
            {decision.confidence != null && (
              <span
                className="ml-auto text-[10px] font-medium text-muted-foreground"
                title={t(
                  "loop.confidenceDiagnostic",
                  "Classification confidence (diagnostic — not urgency)",
                )}
              >
                {t("loop.confidenceShort", "conf {{n}}", {
                  n: decision.confidence.toFixed(2),
                })}
              </span>
            )}
          </div>
          <h3 className="mt-1 text-base font-semibold leading-snug">
            {decision.title}
          </h3>
          {/* Missing decision-critical fields (#359). */}
          {readiness.status === "needs_context" &&
            readiness.missing &&
            readiness.missing.length > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t("loop.readiness.missing", "Missing: {{fields}}", {
                  fields: readiness.missing.join(", "),
                })}
              </p>
            )}
        </div>
      </header>

      {/* Dialogue bubble */}
      <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-foreground/90">
        {dialogue}
      </div>

      {/* Source chain */}
      {chain.length > 0 && (
        <section>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("loop.sourceChain", "Source chain")}
          </div>
          <LoopSourceChain nodes={chain} />
        </section>
      )}

      {/* Why bullets */}
      {whyBullets.length > 0 && (
        <section>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("loop.why", "Why this surfaced")}
          </div>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {whyBullets.slice(0, 6).map((w) => (
              <li key={w} className="flex items-start gap-1.5">
                <span className="mt-1 inline-block size-1.5 shrink-0 rounded-full bg-primary/60" />
                <span>{w}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Footer: actions or status */}
      {isPending ? (
        <footer className="flex flex-col gap-2 border-t pt-3">
          {/* #358 — when a previous run was blocked/failed, surface the
              structured reason from `execution` (falls back to the legacy
              `context.last_error` for rows that predate the verdict field).
              Action buttons remain so a retry is one tap. */}
          {(decision.execution?.outcome === "blocked" ||
            decision.execution?.outcome === "failed" ||
            decision.context?.last_error) && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <RemixIcon
                name="ri-error-warning-line"
                className="mt-0.5 size-3.5 shrink-0"
              />
              <span className="break-words">
                {decision.execution?.outcome === "blocked" ||
                decision.execution?.outcome === "failed"
                  ? t(
                      "loop.lastAttemptFailed",
                      "Last attempt failed: {{reason}} — retry Run below.",
                      {
                        reason:
                          decision.execution?.reason ??
                          (typeof decision.context?.last_error === "string"
                            ? decision.context.last_error
                            : decision.execution?.outcome),
                      },
                    )
                  : typeof decision.context?.last_error === "string"
                    ? decision.context.last_error
                    : ""}
              </span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton
              icon="ri-flask-line"
              label={t("loop.dryRun", "Dry run")}
              variant="outline"
              onClick={() => act("dry")}
              pending={pendingAction === "dry"}
            />
            <ActionButton
              icon="ri-pencil-line"
              label={t("loop.edit", "Edit")}
              variant="ghost"
              onClick={() => router.push(`/loop/${decision.id}?edit=1`)}
            />
            {/* #359 — a non-actionable decision must not expose a default Run.
                For ready/needs_context we still show Run, but demote it from
                the default CTA when the card isn't cleanly "ready". */}
            {executable && (
              <ActionButton
                icon="ri-play-line"
                label={
                  state === "confirm"
                    ? t("loop.confirmRun", "Confirm & run")
                    : t("loop.run", "Run")
                }
                variant={state === "ready" ? "default" : "outline"}
                onClick={() => act("run")}
                pending={pendingAction === "run"}
              />
            )}
            <ActionButton
              icon="ri-close-line"
              label={t("loop.dismiss", "Dismiss")}
              variant="ghost"
              onClick={() => act("dismiss")}
              pending={pendingAction === "dismiss"}
            />
          </div>
        </footer>
      ) : (
        <footer className="flex flex-col gap-2 border-t pt-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <RemixIcon
              name={
                decision.status === "done"
                  ? decision.execution?.outcome === "skipped"
                    ? "ri-checkbox-circle-line"
                    : "ri-check-double-line"
                  : "ri-eye-off-line"
              }
              className="size-3.5"
            />
            {decision.status === "done" ? (
              decision.execution?.outcome === "skipped" ? (
                <span>
                  {t("loop.outcome.skipped", "Skipped")} —{" "}
                  {decision.execution?.reason ??
                    t("loop.outcome.reason", "Reason: {{reason}}", {
                      reason: t("loop.outcome.skipped", "Skipped"),
                    })}
                </span>
              ) : (
                <span>
                  {t("loop.ranAt", "Ran at {{ts}}", {
                    ts: decision.completed_at ?? decision.ts,
                  })}
                </span>
              )
            ) : (
              <span>{t("loop.dismissedAt", "Dismissed")}</span>
            )}
            {/* #358 — small "Executed" badge so the done footer is
                unambiguous about what kind of done it was. */}
            {decision.status === "done" &&
              decision.execution?.outcome === "executed" && (
                <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                  {t("loop.detail.executedBadge", "Executed")}
                </span>
              )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => router.push(`/loop/${decision.id}`)}
              className="ml-auto"
            >
              {t("loop.viewDetails", "View details")}
              <RemixIcon name="ri-arrow-right-line" className="ml-1 size-3.5" />
            </Button>
          </div>
        </footer>
      )}
    </article>
  );
}

function buildChain(decision: LoopDecisionCardData): SourceChainNode[] {
  const fromCard = decision.source_chain;
  if (Array.isArray(fromCard) && fromCard.length > 0) {
    return fromCard
      .filter((n): n is SourceChainNode => typeof n !== "string")
      .map((n) => ({
        icon: n.icon ?? "ri-link",
        label: n.label,
        sublabel: n.sublabel,
        tone: n.tone,
      }));
  }
  const sig = decision.source_signal;
  if (!sig) return [];
  const nodes: SourceChainNode[] = [];
  nodes.push({
    icon: sourceIcon(sig.source),
    label: sig.source,
    sublabel: sig.type,
  });
  const person = decision.context?.person;
  if (typeof person === "string" && person) {
    nodes.push({
      icon: "ri-user-line",
      label: person,
      tone: "muted",
    });
  }
  const proj = decision.context?.project_ref;
  if (typeof proj === "string" && proj) {
    nodes.push({
      icon: "ri-folder-line",
      label: proj,
      tone: "muted",
    });
  }
  const mem = decision.context?.memory_refs ?? [];
  for (const m of mem.slice(0, 2)) {
    nodes.push({
      icon: "ri-brain-line",
      label: m,
      tone: "muted",
    });
  }
  return nodes;
}

function sourceIcon(source: string): string {
  switch (source) {
    case "gmail":
      return "ri-mail-line";
    case "slack":
      return "ri-slack-line";
    case "github":
      return "ri-github-line";
    case "linear":
      return "ri-list-check-2";
    case "calendar":
    case "google_calendar":
      return "ri-calendar-line";
    case "obsidian":
      return "ri-file-2-line";
    default:
      return "ri-pulse-line";
  }
}
