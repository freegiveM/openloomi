"use client";

/**
 * Loop decision detail page — wraps the existing LoopDetailWorkspace
 * component with route-level data fetching so the pet card's
 * "Open brief / Open wrap / Open plan / ↗ Edit" buttons can land here
 * via `router.push('/loop/<id>')`.
 *
 * Data source: GET /api/loop/card/[id] returns the card-shaped JSON the
 * component expects (LoopDecisionCardData). 404s on the API surface as a
 * "decision not found" placeholder so the user gets feedback instead of
 * a blank page.
 *
 * Why this lives at /(chat)/loop/[id] rather than /(chat)/loop/decisions/[id]:
 *   - the LoopDetailWorkspace component, the DecisionCard onclick handlers,
 *     and the card's existing buildActionPrompt all reference the
 *     singular `/loop/<id>` form — keeping the route consistent avoids a
 *     follow-up redirect + URL-canonicalization pass.
 *   - scheduled-jobs/[id] uses the same `(chat)` group so it picks up
 *     the sidebar/header layout for free.
 */

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useTranslation } from "react-i18next";

import { LoopDetailWorkspace } from "@/components/loop/loop-detail-workspace";
import type { LoopDecisionCardData } from "@/components/loop/decision-card";
import { PageSectionHeader } from "@openloomi/ui";
import { RemixIcon } from "@/components/remix-icon";

export default function LoopDecisionDetailPage() {
  const params = useParams<{ id: string }>();
  const { t } = useTranslation();
  const id = params?.id;
  const [data, setData] = useState<LoopDecisionCardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/loop/card/${encodeURIComponent(id)}`, {
        credentials: "include",
      });
      if (res.status === 404) {
        setError("not_found");
        setData(null);
        return;
      }
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const card = (await res.json()) as LoopDecisionCardData;
      setData(card);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  if (!id) return null;

  if (loading && !data) {
    return (
      <div className="flex h-full items-center justify-center p-12 text-sm text-muted-foreground">
        <RemixIcon name="ri-loader-4-line" className="mr-2 animate-spin" />
        {t("loop.detail.loading", "Loading decision…")}
      </div>
    );
  }

  if (error === "not_found" || !data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-12 text-center">
        <RemixIcon
          name="ri-ghost-line"
          className="text-4xl text-muted-foreground"
        />
        <PageSectionHeader
          title={t("loop.detail.notFoundTitle", "Decision not found")}
          description={t(
            "loop.detail.notFoundDesc",
            "This decision may have been dismissed, executed, or never existed. Check the Loop page for the latest.",
          )}
        />
      </div>
    );
  }

  return <LoopDetailWorkspace decision={data} onRefresh={refetch} />;
}
