"use client";

import { useState, useMemo } from "react";
import { RemixIcon } from "@/components/remix-icon";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { MarkdownWithCitations } from "./markdown-with-citations";
import type { Insight } from "@/lib/db/schema";
import { Button } from "./ui/button";

interface PlanStep {
  step: number;
  action: string;
  tool?: string | null;
}

interface AgentPlanMessageProps {
  thought: string;
  plan: PlanStep[];
  currentStep?: number;
  isRunning?: boolean;
  insights?: Insight[];
  approvalStatus?: "pending_approval" | "approved" | "rejected" | "executing";
  planId?: string;
  onApprove?: (planId: string) => void;
  onReject?: (planId: string) => void;
  requiresApproval?: boolean;
}

type StepStatus = "pending" | "running" | "completed";

export function AgentPlanMessage({
  thought,
  plan,
  currentStep,
  isRunning = false,
  insights,
  approvalStatus = "approved",
  planId,
  onApprove,
  onReject,
  requiresApproval = false,
}: AgentPlanMessageProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(true);

  // Determine if approval buttons should show
  const showApprovalButtons =
    requiresApproval && approvalStatus === "pending_approval" && !isRunning;

  // Calculate status for each step
  const stepsWithStatus = useMemo(() => {
    const result = plan.map((step) => {
      let status: StepStatus = "pending";
      if (currentStep) {
        if (step.step < currentStep) {
          status = "completed";
        } else if (step.step === currentStep) {
          // If this is the current step but Agent is not running, mark as completed
          status = isRunning ? "running" : "completed";
        }
      } else if (!isRunning) {
        // If not running, mark all steps as completed
        status = "completed";
      }
      return { ...step, status };
    });

    return result;
  }, [plan, currentStep, isRunning]);

  const completedCount = stepsWithStatus.filter(
    (step) => step.status === "completed",
  ).length;
  const totalCount = stepsWithStatus.length;

  return (
    <div className="my-6">
      <div
        className="border-primary/30 bg-accent/30 space-y-4 rounded-xl border p-4"
        style={{ height: "fit-content" }}
      >
        {/* Main content area */}
        <div className="space-y-4">
          {/* Header: thought content + expand/collapse button */}
          <div
            className="flex items-start gap-3 w-full text-left cursor-pointer"
            onClick={() => setIsExpanded(!isExpanded)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setIsExpanded(!isExpanded);
              }
            }}
            role="button"
            tabIndex={0}
          >
            {/* AI icon */}
            <div className="flex-shrink-0 mt-0.5">
              {isRunning ? (
                <div className="relative">
                  <RemixIcon
                    name="loader_2"
                    size="size-5"
                    className="text-primary animate-spin"
                  />
                  <div className="bg-primary/20 absolute inset-0 h-5 w-5 animate-ping rounded-full" />
                </div>
              ) : (
                <span className="bg-primary size-2 animate-pulse rounded-full" />
              )}
            </div>

            {/* Thought content + status badge */}
            <div className="flex-1 min-w-0">
              {thought && (
                <div className="text-foreground text-sm leading-relaxed">
                  <MarkdownWithCitations>
                    {thought}
                  </MarkdownWithCitations>
                </div>
              )}

              {approvalStatus === "pending_approval" && (
                <span className="text-muted-foreground bg-muted mt-2 inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium">
                  <RemixIcon name="clock" size="size-3" />
                  <span>{t("common.agentStatus.pendingApproval")}</span>
                </span>
              )}

              {/* Running status indicator */}
              {approvalStatus !== "pending_approval" && isRunning && (
                <div className="text-muted-foreground mt-2 flex items-center gap-2 text-xs">
                  <div className="relative">
                    <div className="bg-primary h-2 w-2 rounded-full" />
                    <div className="bg-primary/20 absolute inset-0 h-2 w-2 animate-ping rounded-full" />
                  </div>
                  <span>{t("common.agentStatus.executing")}</span>
                </div>
              )}
            </div>

            {/* Expand/collapse button */}
            <button
              type="button"
              className="hover:bg-muted flex-shrink-0 rounded p-1 transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                setIsExpanded(!isExpanded);
              }}
            >
              {isExpanded ? (
                <RemixIcon
                  name="chevron_up"
                  size="size-4"
                  className="text-muted-foreground"
                />
              ) : (
                <RemixIcon
                  name="chevron_down"
                  size="size-4"
                  className="text-muted-foreground"
                />
              )}
            </button>
          </div>

          {/* Expandable plan steps */}
          {isExpanded && plan.length > 0 && (
            <div className="mt-4 mb-0 pt-4">
              <div className="text-muted-foreground mb-3 flex items-center justify-between text-xs font-medium uppercase tracking-wide">
                <span>{t("common.agentStatus.executionPlan")}</span>
                <span>
                  {completedCount} / {totalCount}
                </span>
              </div>

              <div className="space-y-2">
                {stepsWithStatus.map((step) => (
                  <div
                    key={step.step}
                    className="flex items-start gap-3 rounded-lg border border-border/60 bg-background px-3 py-2 text-left text-foreground transition-all hover:border-primary/50 hover:bg-accent/50"
                  >
                    {/* Step status icon */}
                    <div className="mt-0.5 flex shrink-0 items-center justify-center">
                      {step.status === "running" ? (
                        <div className="relative">
                          <RemixIcon
                            name="loader_2"
                            size="size-5"
                            className="text-primary animate-spin"
                          />
                          <div className="bg-primary/20 absolute inset-0 h-5 w-5 animate-ping rounded-full" />
                        </div>
                      ) : step.status === "completed" ? (
                        <div className="flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-primary bg-primary">
                          <RemixIcon
                            name="check"
                            size="size-3"
                            className="text-primary-foreground"
                          />
                        </div>
                      ) : (
                        <div className="h-5 w-5 shrink-0 rounded-full border-2 border-muted-foreground/40" />
                      )}
                    </div>

                    {/* Step content */}
                    <div className="flex min-w-0 flex-1 items-start justify-start gap-2">
                      <div
                        className={cn(
                          "min-w-0 flex-1 text-sm",
                          step.status === "running"
                            ? "text-foreground font-medium"
                            : "text-muted-foreground",
                        )}
                      >
                        <MarkdownWithCitations>
                          {step.action}
                        </MarkdownWithCitations>
                      </div>
                      {step.tool && (
                        <span className="bg-primary/10 text-primary shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium">
                          {step.tool}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Approval buttons */}
              {showApprovalButtons && (
                <div className="mt-4">
                  <div className="flex items-center justify-end gap-3">
                    <Button
                      onClick={() => onReject?.(planId || "")}
                      variant="outline"
                      size="sm"
                    >
                      <RemixIcon
                        name="refresh"
                        size="size-4"
                        className="mr-2"
                      />
                      {t("common.agentStatus.replan")}
                    </Button>
                    <Button onClick={() => onApprove?.(planId || "")} size="sm">
                      <RemixIcon name="check" size="size-4" className="mr-2" />
                      {t("common.agentStatus.approveExecution")}
                    </Button>
                  </div>
                  <p className="text-muted-foreground mt-2 text-right text-xs">
                    {t("common.agentStatus.approvalHint")}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
