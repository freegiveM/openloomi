"use client";

/**
 * /wrap — full evening-wrap view. Mirrors /brief in structure but
 * renders a WrapSnapshot (stats + highlights). Reached from the pet
 * card's "Open wrap" button via
 * `pet:open-wrap` → Rust → `openloomi:navigate-wrap`.
 *
 * WrapSnapshot shape (from `lib/loop/wrap.ts`):
 *   {
 *     date, generatedAt,
 *     stats: { done, dismissed, stillPending },
 *     highlights: [{ id, title, type, completedAt, resultKind }]
 *   }
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, PageSectionHeader } from "@openloomi/ui";
import { RemixIcon } from "@/components/remix-icon";
import { Spinner } from "@/components/spinner";
import { toast } from "@/components/toast";

interface WrapHighlight {
  id: string;
  title: string;
  type: string;
  completedAt: string;
  resultKind: string;
}

interface WrapSnapshot {
  date: string;
  generatedAt: string;
  stats: { done: number; dismissed: number; stillPending: number };
  highlights: WrapHighlight[];
}

export default function WrapPage() {
  const router = useRouter();
  const [wrap, setWrap] = useState<WrapSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/loop/wrap/content", {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as {
        ok: boolean;
        wrap: WrapSnapshot | null;
      };
      setWrap(data.wrap);
    } catch (e) {
      toast({
        type: "error",
        description: `Failed to load wrap: ${e instanceof Error ? e.message : String(e)}`,
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
      const res = await fetch("/api/loop/wrap", {
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
        title="Evening wrap"
        description={
          wrap
            ? `${wrap.date} · ${wrap.stats.done} done · ${wrap.stats.dismissed} dismissed · ${wrap.stats.stillPending} carried`
            : "Today's resolution + tomorrow's stage"
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
          {wrap ? "Regenerate" : "Generate now"}
        </Button>
      </PageSectionHeader>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-6 pt-4 sm:px-6">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner size={16} /> Loading wrap…
          </div>
        ) : !wrap ? (
          <EmptyWrap onGenerate={generate} generating={generating} />
        ) : (
          <WrapContent wrap={wrap} />
        )}
      </div>
    </div>
  );
}

function EmptyWrap({
  onGenerate,
  generating,
}: {
  onGenerate: () => void;
  generating: boolean;
}) {
  return (
    <div className="mx-auto mt-12 max-w-md rounded-lg border border-dashed border-border p-8 text-center">
      <div className="mb-2 text-2xl">☾</div>
      <h2 className="text-lg font-semibold">No wrap yet</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Generate one to close out the day: what's done, what was dismissed, and
        what's still pending.
      </p>
      <Button
        type="button"
        className="mt-6"
        onClick={onGenerate}
        disabled={generating}
      >
        {generating ? <Spinner size={16} /> : null}
        Generate wrap
      </Button>
    </div>
  );
}

function WrapContent({ wrap }: { wrap: WrapSnapshot }) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-sm font-medium text-muted-foreground">
              {wrap.date}
            </div>
            <div className="text-2xl font-semibold">
              {wrap.highlights.length === 0
                ? "Quiet day"
                : `${wrap.highlights.length} highlight${wrap.highlights.length === 1 ? "" : "s"}`}
            </div>
          </div>
          <div className="flex gap-4 text-right text-xs text-muted-foreground">
            <Stat label="done" value={wrap.stats.done} />
            <Stat label="dismissed" value={wrap.stats.dismissed} />
            <Stat label="pending" value={wrap.stats.stillPending} />
          </div>
        </div>
      </div>

      {wrap.highlights.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          Nothing notable today.
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {wrap.highlights.map((h) => (
            <li
              key={h.id}
              className="rounded-lg border border-border bg-card p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">
                    {h.title}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    completed {formatTs(h.completedAt)}
                  </div>
                </div>
                <div className="shrink-0 text-right text-xs text-muted-foreground">
                  <div className="font-mono uppercase tracking-wide">
                    {h.resultKind}
                  </div>
                  <div className="mt-0.5">{h.type}</div>
                </div>
              </div>
            </li>
          ))}
        </ul>
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

function formatTs(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
