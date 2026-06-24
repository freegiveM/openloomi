"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@openloomi/ui";
import { toast } from "@/components/toast";

export interface InsightNewItem {
  id: string;
  title: string;
  summary?: string;
  detail?: string;
  platform?: string;
  categories?: string[];
}

interface InsightsNewCountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  newInsights: InsightNewItem[];
  newInsightsCount: number;
  onViewDetails?: () => void;
  onCreateTask?: (insight: InsightNewItem) => void;
}

async function createTaskFromInsight(
  insightId: string,
  title: string,
): Promise<boolean> {
  try {
    const response = await fetch(`/api/insights/${insightId}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title,
        bucket: "myTasks",
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(
        error.message || `Failed to create task: ${response.status}`,
      );
    }

    return true;
  } catch (error) {
    console.error("[InsightsNewCountDialog] Failed to create task:", error);
    return false;
  }
}

/**
 * Dialog that notifies users when new insights are detected during refresh.
 * Allows users to view details or convert insights to tasks.
 */
export function InsightsNewCountDialog({
  open,
  onOpenChange,
  newInsights,
  newInsightsCount,
  onViewDetails,
  onCreateTask,
}: InsightsNewCountDialogProps) {
  const { t } = useTranslation();
  const [creatingTaskId, setCreatingTaskId] = useState<string | null>(null);

  const handleCreateTask = async (insight: InsightNewItem) => {
    if (creatingTaskId) return; // Prevent double-click

    setCreatingTaskId(insight.id);
    try {
      const success = await createTaskFromInsight(insight.id, insight.title);
      if (success) {
        toast({
          type: "success",
          description: t("insight.newCountDialog.taskCreated", "Task created"),
        });
        // Call optional callback if provided
        onCreateTask?.(insight);
      } else {
        toast({
          type: "error",
          description: t(
            "insight.newCountDialog.taskCreateFailed",
            "Failed to create task",
          ),
        });
      }
    } finally {
      setCreatingTaskId(null);
    }
  };

  const handleDismiss = () => {
    onOpenChange(false);
  };

  // Display up to 5 insights in the dialog
  const displayedInsights = newInsights.slice(0, 5);
  const remainingCount = newInsightsCount - displayedInsights.length;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="z-[1050] max-w-md">
        <AlertDialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
              <span className="text-xl">✨</span>
            </div>
            <AlertDialogTitle>
              {t(
                "insight.newCountDialog.title",
                "Detected {{count}} new insights",
                { count: newInsightsCount },
              )}
            </AlertDialogTitle>
          </div>
          <AlertDialogDescription className="text-left">
            {t(
              "insight.newCountDialog.description",
              "New insights have been generated from your channels. You can view them or convert them to tasks.",
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* List of new insights */}
        <div className="max-h-60 overflow-y-auto space-y-2 py-2">
          {displayedInsights.map((insight) => (
            <div
              key={insight.id}
              className="flex items-start justify-between gap-2 rounded-lg border p-3 text-sm"
            >
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{insight.title}</p>
                {insight.summary && (
                  <p className="text-muted-foreground text-xs mt-1 line-clamp-2">
                    {insight.summary}
                  </p>
                )}
              </div>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 h-7 text-xs"
                onClick={() => handleCreateTask(insight)}
                disabled={creatingTaskId === insight.id}
              >
                {creatingTaskId === insight.id
                  ? t("insight.newCountDialog.creating", "...")
                  : t("insight.newCountDialog.createTask", "Take Action")}
              </Button>
            </div>
          ))}
          {remainingCount > 0 && (
            <p className="text-xs text-muted-foreground text-center">
              {t("insight.newCountDialog.more", "and {{count}} more...", {
                count: remainingCount,
              })}
            </p>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel onClick={handleDismiss}>
            {t("insight.newCountDialog.dismiss", "Got it")}
          </AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
