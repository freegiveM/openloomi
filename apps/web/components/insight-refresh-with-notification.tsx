"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";
import { useInsightRefresh } from "@/hooks/use-insight-refresh";
import {
  InsightsNewCountDialog,
  type InsightNewItem,
} from "./insights-new-count-dialog";
import { toast } from "@/components/toast";

interface InsightRefreshWithNotificationProps {
  assistantName?: string;
  isFirstLanding?: boolean;
  initialRefresh?: boolean;
  enabled?: boolean;
}

/**
 * Wrapper component that combines useInsightRefresh with InsightsNewCountDialog.
 * Automatically shows a notification dialog when any new insights are detected.
 */
export function InsightRefreshWithNotification({
  assistantName,
  isFirstLanding,
  initialRefresh = true,
  enabled = true,
}: InsightRefreshWithNotificationProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);

  const { newInsights, newInsightsCount, clearNewInsights } = useInsightRefresh(
    assistantName,
    isFirstLanding,
    initialRefresh,
    {
      enabled,
      interval: 600000, // 10 minutes
      retryInterval: 60000,
    },
  );

  // Show dialog when any new insights are detected
  useEffect(() => {
    if (newInsightsCount > 0) {
      setDialogOpen(true);
    }
  }, [newInsightsCount]);

  const handleViewDetails = () => {
    // Navigate to insights page
    router.push("/insights");
  };

  const handleCreateTask = (insight: InsightNewItem) => {
    // The actual task creation would be handled by the parent component
    // or by passing a custom handler. For now, we show a toast and navigate.
    toast({
      type: "info",
      description: t(
        "insight.newCountDialog.taskCreationHint",
        "Task creation from notification will be available soon",
      ),
    });

    // TODO: Once backend supports creating tasks from new insights,
    // implement the actual task creation flow here using useTaskOperations
  };

  const handleDismiss = () => {
    setDialogOpen(false);
    clearNewInsights();
  };

  // Convert newInsights to the format expected by the dialog
  const dialogInsights: InsightNewItem[] = newInsights.map((insight) => ({
    id: insight.id,
    title: insight.title,
    summary: insight.summary,
  }));

  return (
    <InsightsNewCountDialog
      open={dialogOpen}
      onOpenChange={setDialogOpen}
      newInsights={dialogInsights}
      newInsightsCount={newInsightsCount}
      onViewDetails={handleViewDetails}
      onCreateTask={handleCreateTask}
    />
  );
}
