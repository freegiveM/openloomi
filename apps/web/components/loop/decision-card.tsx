"use client";

/**
 * Loop decision card — one typed card the Loop surfaces to the pet / web UI.
 *
 * Restructured per #363 around a 5-layer information architecture so the
 * user sees only the facts needed to decide:
 *
 *   1. Header row          — type icon + RSVP-specific invitation label +
 *                            state pill + priority pill + diagnostic
 *                            `conf 0.NN` chip + a kebab menu for
 *                            card-level dismissal (separated from the
 *                            decision-action row).
 *   2. Decision prompt     — single-line ask ("Will you attend this
 *                            meeting?"). Title shown once below as an
 *                            <h3>.
 *   3. Decision context    — `<DecisionContextBlock>` renders the
 *                            user-facing facts (time, organizer,
 *                            attendance, location, conflict for RSVP).
 *                            Non-RSVP types render nothing here yet.
 *   4. Readiness callout   — plain-language information readiness plus
 *                            missing-field prompt. Subtle text when
 *                            `ready`, banner when `needs_context`.
 *   5. Provenance          — `<details>` (collapsed by default) containing
 *                            the source chain, why bullets, action params
 *                            JSON, and the dry-run preview when present.
 *
 * Action row (#6 below the layers):
 *   - RSVP ready/confirm  → Attend (primary) · Decline (outline) · View original (ghost)
 *   - RSVP needs_context  → same three buttons; the readiness banner tells
 *                            the user to review the original first
 *   - RSVP not_actionable → View original only
 *   - Other types         → existing Dry run / Edit / Run / Dismiss row
 *
 * Card-level dismissal (#7) lives in the header kebab so it never gets
 * confused with the decision-action group.
 *
 * Statuses:
 *   - pending   → 5-layer card + action row visible
 *   - done      → "Ran at <ts>" footer + execution badge
 *   - dismissed → "Dismissed" footer with optional reason
 *
 * Custom decision types: the user can register new `type` strings via
 * `PUT /api/loop/types`. Built-in `TYPE_ICON` / `TYPE_LABEL` are static
 * at module load; the per-user extensions are fetched once on mount and
 * merged at render time via the `customTypeMeta` lookup below.
 */

import { useEffect, useMemo, useRef, useState } from "react";
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
import { deriveDecisionContext } from "@/lib/loop/decision-context";
import { DecisionContextBlock } from "@/components/loop/decision-context-block";
import { DismissInput } from "@/components/loop/dismiss-input";
import type {
  DecisionReadiness,
  DecisionRelationship,
  LoopDecisionExecution,
} from "@/lib/loop/types";

import { LoopSourceChain, type SourceChainNode } from "./source-chain";

export type LoopActionKind =
  | "run"
  | "dry"
  | "dismiss"
  | "promote"
  | "rsvp_attend"
  | "rsvp_decline";

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
    dry_run?: string;
    /** #363 — when set, indicates this decision is still in `pending` but
     *  carries a previously-executed verdict (e.g. the user's first RSVP
     *  attempt was recorded as done and they chose again). Currently
     *  surfaced only through the technical details. */
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

/**
 * Header kebab — card-level dismissal, separated from the decision-action
 * row (#363). Opens a DismissInput reason-prompt inline so dismissing a
 * card without an RSVP response never gets confused with declining one.
 */
function CardKebab({ decision }: { decision: LoopDecisionCardData }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Esc so the kebab mirrors normal menu UX.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={t("loop.card.kebab", "More actions")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      >
        <RemixIcon name="ri-more-2-fill" className="size-4" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-64 rounded-md border bg-card p-3 shadow-lg"
        >
          <DismissInput
            decisionId={decision.id}
            onDismissed={() => setOpen(false)}
            className="!w-full"
          />
        </div>
      )}
    </div>
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
  const isRsvp = decision.type === "rsvp";
  // #363 — RSVP gets a single-line decision prompt + the dedicated context
  // block. Other types keep the legacy dialogue bubble verbatim.
  const decidePrompt = isRsvp
    ? t("loop.rsvp.decidePrompt", "Will you attend this meeting?")
    : null;
  const dialogue =
    decision.dialogue ??
    (decision.type === "draft_reply"
      ? t(
          "loop.dialogue.draftReply",
          "This email looks like it's waiting on you — should I draft a reply?",
        )
      : decision.type === "rsvp"
        ? t(
            "loop.dialogue.rsvp",
            "This calendar invite needs your call.",
          )
        : `New ${typeLabel.toLowerCase()} decision`);
  const nextStep =
    decision.nextStep ??
    t("loop.nextStep.tapRun", "Tap Run to let the agent handle this decision.");

  // #363 — pre-resolve the decision context. RSVP renders the
  // time/organizer/attendance/location/conflict block; other types return
  // `null` and the block renders nothing.
  const decisionContext = useMemo(
    () =>
      deriveDecisionContext({
        type: decision.type,
        action: decision.action ?? null,
      }),
    [decision.type, decision.action],
  );
  const rsvpActionParamsHtmlLink = useMemo(() => {
    if (!isRsvp) return null;
    const p = decision.action?.params;
    if (!p || typeof p !== "object") return null;
    const link = (p as Record<string, unknown>).htmlLink;
    return typeof link === "string" && link.trim().length > 0
      ? link.trim()
      : null;
  }, [isRsvp, decision.action]);

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
          rsvp_attend: t("loop.rsvp.attended", "Attending"),
          rsvp_decline: t("loop.rsvp.declined", "Declined"),
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

  function openOriginal() {
    if (rsvpActionParamsHtmlLink) {
      window.open(rsvpActionParamsHtmlLink, "_blank", "noopener,noreferrer");
      return;
    }
    router.push(`/loop/${decision.id}`);
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
            {decidePrompt ?? dialogue}
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
  const showRunControls = isPending && !isRsvp;
  const showRsvpControls = isPending && isRsvp;

  return (
    <article
      className={cn(
        "flex flex-col gap-4 rounded-lg border bg-card p-5 shadow-sm",
        decision.status === "dismissed" && "opacity-60",
        className,
      )}
    >
      {/* ── Layer 1: Header row ─────────────────────────────────────── */}
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
            {/* RSVP gets a friendlier label than the raw `RSVP` type id. */}
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {isRsvp
                ? t("loop.rsvp.invitationLabel", "Calendar invitation")
                : typeLabel}
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
            {/* #363 — card-level dismissal lives here so it never gets
                confused with the decision-action row below. */}
            {isPending && <CardKebab decision={decision} />}
          </div>
          <h3 className="mt-1 text-base font-semibold leading-snug">
            {decision.title}
          </h3>
        </div>
      </header>

      {/* ── Layer 2: Decision prompt ────────────────────────────────── */}
      {decidePrompt ? (
        <p className="text-sm leading-snug text-foreground/90">
          {decidePrompt}
        </p>
      ) : (
        <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-foreground/90">
          {dialogue}
        </div>
      )}

      {/* ── Layer 3: Decision context ───────────────────────────────── */}
      {isPending && decisionContext && (
        <DecisionContextBlock context={decisionContext} />
      )}

      {/* ── Layer 4: Readiness callout ───────────────────────────────── */}
      {isPending && readiness.status === "needs_context" && (
        <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
          {t(
            "loop.rsvp.readinessIncomplete",
            "Information incomplete: {{fields}}. Review the original event before responding.",
            {
              fields: (readiness.missing ?? []).join(", "),
            },
          )}
        </div>
      )}
      {isPending && readiness.status === "ready" && (
        <p className="text-[11px] text-muted-foreground">
          {t(
            "loop.rsvp.readinessSufficient",
            "Information is sufficient to decide.",
          )}
        </p>
      )}

      {/* ── Layer 5: Provenance (collapsed) ──────────────────────────── */}
      {isPending && (chain.length > 0 || whyBullets.length > 0 || decision.action) && (
        <details className="rounded-md border bg-muted/10 px-3 py-2 text-xs">
          <summary className="cursor-pointer select-none font-medium text-muted-foreground">
            {t("loop.rsvp.technicalDetails", "Technical details")}
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            {chain.length > 0 && (
              <section>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("loop.sourceChain", "Source chain")}
                </div>
                <LoopSourceChain nodes={chain} />
              </section>
            )}
            {whyBullets.length > 0 && (
              <section>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("loop.why", "Why this surfaced")}
                </div>
                <ul className="space-y-1 text-[11px] text-muted-foreground">
                  {whyBullets.slice(0, 6).map((w) => (
                    <li key={w} className="flex items-start gap-1.5">
                      <span className="mt-1 inline-block size-1.5 shrink-0 rounded-full bg-primary/60" />
                      <span>{w}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {decision.action && (
              <section>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("loop.detail.actionLabel", "Action")}
                </div>
                <pre className="max-h-48 overflow-auto rounded-md border bg-background/60 p-2 text-[11px] leading-relaxed">
                  <code>
                    {JSON.stringify(
                      {
                        kind: decision.action.kind,
                        params: decision.action.params,
                      },
                      null,
                      2,
                    )}
                  </code>
                </pre>
              </section>
            )}
          </div>
        </details>
      )}

      {/* ── Layer 6: Actions ────────────────────────────────────────── */}
      {isPending && showRsvpControls && (
        <footer className="flex flex-col gap-2 border-t pt-3">
          {/* #358 — when a previous run was blocked/failed, surface the
              structured reason from `execution`. The RSVP control row
              below stays so a retry is one tap. */}
          {(decision.execution?.outcome === "blocked" ||
            decision.execution?.outcome === "failed" ||
            decision.context?.last_error) && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <RemixIcon
                name="ri-error-warning-line"
                className="mt-0.5 size-3.5 shrink-0"
              />
              <span className="break-words">
                {t(
                  "loop.lastAttemptFailed",
                  "Last attempt failed: {{reason}} — retry Run below.",
                  {
                    reason:
                      decision.execution?.reason ??
                      (typeof decision.context?.last_error === "string"
                        ? decision.context.last_error
                        : decision.execution?.outcome),
                  },
                )}
              </span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {/* #363 — when readiness is not_actionable the only sensible
                action is to look at the source event. The Attend/Decline
                row would otherwise let the user trigger an external write
                that the runner would refuse anyway. */}
            {state !== "not_actionable" ? (
              <>
                <ActionButton
                  icon="ri-check-line"
                  label={t("loop.rsvp.attend", "Attend")}
                  variant="default"
                  onClick={() => act("rsvp_attend")}
                  pending={pendingAction === "rsvp_attend"}
                />
                <ActionButton
                  icon="ri-close-line"
                  label={t("loop.rsvp.decline", "Decline")}
                  variant="outline"
                  onClick={() => act("rsvp_decline")}
                  pending={pendingAction === "rsvp_decline"}
                />
              </>
            ) : null}
            <ActionButton
              icon="ri-external-link-line"
              label={t("loop.rsvp.viewOriginal", "View original")}
              variant="ghost"
              onClick={openOriginal}
            />
            {executable && !isRsvp && (
              <ActionButton
                icon="ri-flask-line"
                label={t("loop.dryRun", "Dry run")}
                variant="outline"
                onClick={() => act("dry")}
                pending={pendingAction === "dry"}
              />
            )}
          </div>
        </footer>
      )}

      {isPending && showRunControls && (
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
            {/* Legacy Dismiss stays inline for non-RSVP types since the
                card-level kebab is RSVP-only (#363 scope). */}
            <ActionButton
              icon="ri-eye-off-line"
              label={t("loop.dismiss", "Dismiss")}
              variant="ghost"
              onClick={() => act("dismiss")}
              pending={pendingAction === "dismiss"}
            />
          </div>
        </footer>
      )}

      {/* Status footer (done/dismissed) — unchanged. */}
      {!isPending && (
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