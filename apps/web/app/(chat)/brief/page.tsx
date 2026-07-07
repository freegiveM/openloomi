"use client";

/**
 * /brief — full morning-brief view.
 *
 * Reached from the pet card's "Open brief" button (which now fires
 * `pet:open-brief` → Rust → `openloomi:navigate-brief` → here) or by
 * direct URL. Reads the most recent `BriefSnapshot` persisted at
 * `~/.openloomi/loop/brief.json` via `GET /api/loop/brief/content` and
 * renders the items grouped by priority, plus the muted bucket so the
 * user can see why something they expected didn't surface.
 *
 * Empty state (no snapshot yet) shows a "Generate now" button that
 * calls `POST /api/loop/brief` and re-fetches on success.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@openloomi/ui";
import { PageSectionHeader } from "@openloomi/ui";
import { RemixIcon } from "@/components/remix-icon";
import { Spinner } from "@/components/spinner";
import { toast } from "@/components/toast";

interface BriefItem {
  kind: string;
  id: string;
  title: string;
  // Matches LoopAction in lib/loop/types — `{ kind, params }`. We only
  // surface `kind` here; params is opaque per-decision and would
  // clutter the row.
  action: { kind: string; params?: Record<string, unknown> };
  priority: number;
  reason: string;
}

interface BriefMuted {
  kind: string;
  title: string;
  reason: string;
}

interface BriefSnapshot {
  date: string;
  generatedAt: string;
  stats: { scanned: number; surfaced: number; muted: number };
  items: BriefItem[];
  muted?: BriefMuted[];
}

const PRIORITY_LABEL: Record<number, string> = {
  1: "P1 · must-do",
  2: "P2 · should-do",
  3: "P3 · nice-to-do",
};

export default function BriefPage() {
  const router = useRouter();
  const [brief, setBrief] = useState<BriefSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/loop/brief/content", {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as {
        ok: boolean;
        brief: BriefSnapshot | null;
      };
      setBrief(data.brief);
    } catch (e) {
      toast({
        type: "error",
        description: `Failed to load brief: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const generate = useCallback(async () => {
    setGenerating(true);
    try {
      const res = await fetch("/api/loop/brief", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ force: true }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      await reload();
    } catch (e) {
      toast({
        type: "error",
        description: `Generate failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setGenerating(false);
    }
  }, [reload]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageSectionHeader
        title="Morning brief"
        description={
          brief
            ? `${brief.date} · ${brief.stats.surfaced} surfaced of ${brief.stats.scanned} scanned`
            : "What's waiting for you today"
        }
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8"
          onClick={() => router.push("/")}
        >
          <RemixIcon name="arrow_left" size="size-4" />
          Back
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          className="h-8"
          onClick={generate}
          disabled={generating}
        >
          {generating ? (
            <Spinner size={16} />
          ) : (
            <RemixIcon name="refresh" size="size-4" />
          )}
          {brief ? "Regenerate" : "Generate now"}
        </Button>
      </PageSectionHeader>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-6 pt-4 sm:px-6">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner size={16} /> Loading brief…
          </div>
        ) : !brief ? (
          <EmptyBrief onGenerate={generate} generating={generating} />
        ) : (
          <BriefContent brief={brief} />
        )}
      </div>
    </div>
  );
}

function EmptyBrief({
  onGenerate,
  generating,
}: {
  onGenerate: () => void;
  generating: boolean;
}) {
  return (
    <div className="mx-auto mt-12 max-w-md rounded-lg border border-dashed border-border p-8 text-center">
      <div className="mb-2 text-2xl">☀</div>
      <h2 className="text-lg font-semibold">No brief yet</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Generate one and we'll surface the day's must-dos: RSVP, PR reviews,
        urgent mail, Slack mentions, and assigned Linear issues.
      </p>
      <Button
        type="button"
        className="mt-6"
        onClick={onGenerate}
        disabled={generating}
      >
        {generating ? <Spinner size={16} /> : null}
        Generate brief
      </Button>
    </div>
  );
}

function BriefContent({ brief }: { brief: BriefSnapshot }) {
  const items = [...brief.items].sort((a, b) => a.priority - b.priority);
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-sm font-medium text-muted-foreground">
              {brief.date}
            </div>
            <div className="text-2xl font-semibold">
              {brief.items.length === 0
                ? "All clear"
                : `${brief.items.length} item${brief.items.length === 1 ? "" : "s"} to look at`}
            </div>
          </div>
          <div className="flex gap-4 text-right text-xs text-muted-foreground">
            <Stat label="scanned" value={brief.stats.scanned} />
            <Stat label="surfaced" value={brief.stats.surfaced} />
            <Stat label="muted" value={brief.stats.muted} />
          </div>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          Nothing surfaced for today.
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((it) => (
            <li
              key={`${it.kind}-${it.id}`}
              className="rounded-lg border border-border bg-card p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">
                    {it.title}
                  </div>
                  <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {it.reason}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {PRIORITY_LABEL[it.priority] ?? `P${it.priority}`}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {it.kind} · {it.action.kind}
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {brief.muted && brief.muted.length > 0 && (
        <details className="rounded-lg border border-dashed border-border bg-card/50 p-4">
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
            Muted ({brief.muted.length}) — hidden by loop rules
          </summary>
          <ul className="mt-3 flex flex-col gap-2 text-xs">
            {brief.muted.map((m) => (
              <li
                key={`${m.kind}-${m.title}`}
                className="flex items-baseline gap-2"
              >
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                  {m.kind}
                </span>
                <span className="truncate">{m.title}</span>
                <span className="ml-auto text-muted-foreground">
                  — {m.reason}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col">
      <span className="text-base font-semibold tabular-nums">{value}</span>
      <span className="text-[10px] uppercase tracking-wide">{label}</span>
    </div>
  );
}
