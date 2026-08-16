"use client";

import {
  Badge,
  Button,
  Label,
  Progress,
  ScrollArea,
  Textarea,
} from "@openloomi/ui";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { RemixIcon } from "@/components/remix-icon";
import {
  useAgentGoalCommands,
  useAgentGoalDetail,
  useAgentGoalSession,
} from "@/hooks/use-agent-goals";
import type {
  AgentGoalCommandResponse,
  AgentGoalDetailResponse,
  PublicAgentGoal,
} from "@/lib/ai/runtime-instructions/api";
import { AgentGoalApiError } from "@/lib/ai/runtime-instructions/api/client";
import {
  canCreateNewGoal,
  canResumeGoal,
  displayGoalStatus,
  formatDuration,
  goalStepsView,
} from "@/lib/ai/runtime-instructions/goal-ui-model";
import { cn } from "@/lib/utils";

import "../../i18n";

interface AgentGoalSidePanelProps {
  runtimeSessionId: string;
  onStartGoal: (objective: string) => Promise<AgentGoalCommandResponse>;
  onGoalPaused?: () => void | Promise<void>;
  chatBusy?: boolean;
  planningObjective?: string;
  focusRequest?: number;
  onClose?: () => void;
  className?: string;
}

export function AgentGoalSidePanel({
  runtimeSessionId,
  onStartGoal,
  onGoalPaused,
  chatBusy = false,
  planningObjective,
  focusRequest,
  onClose,
  className,
}: AgentGoalSidePanelProps) {
  const { t } = useTranslation();
  const session = useAgentGoalSession(runtimeSessionId);
  const commands = useAgentGoalCommands(runtimeSessionId);
  const [selectedGoalId, setSelectedGoalId] = useState<string>();
  const [composing, setComposing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: "error" | "info";
    message: string;
  }>();
  const panelRef = useRef<HTMLElement>(null);
  const handledFocusRequest = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!session.data) return;
    const stillExists = session.data.goals.some(
      ({ goal }) => goal.id === selectedGoalId,
    );
    if (!stillExists) {
      setSelectedGoalId(
        session.data.activeGoalId ?? session.data.goals[0]?.goal.id,
      );
    }
  }, [selectedGoalId, session.data]);

  useEffect(() => {
    if (!planningObjective) return;
    setComposing(false);
    setFeedback(undefined);
  }, [planningObjective]);

  useEffect(() => {
    if (
      focusRequest === undefined ||
      handledFocusRequest.current === focusRequest ||
      session.isLoading
    ) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      const target =
        panel?.querySelector<HTMLElement>("#goal-objective") ?? panel;
      target?.focus();
      handledFocusRequest.current = focusRequest;
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, session.isLoading]);

  const detail = useAgentGoalDetail(
    runtimeSessionId,
    selectedGoalId,
    Boolean(session.data),
  );
  const currentDetail =
    detail.data?.goal.id === selectedGoalId ? detail.data : undefined;
  const canCreate = Boolean(
    session.data?.goals.length && canCreateNewGoal(session.data.goals),
  );
  const missingSession =
    session.error instanceof AgentGoalApiError && session.error.status === 404;

  const runCommand = async (
    action: () => Promise<AgentGoalCommandResponse>,
  ) => {
    setBusy(true);
    setFeedback(undefined);
    try {
      const response = await action();
      setFeedback({ tone: "info", message: dispatchMessage(t, response) });
      return response;
    } catch (error) {
      setFeedback({ tone: "error", message: goalErrorMessage(t, error) });
      if (error instanceof AgentGoalApiError && error.status === 409) {
        await Promise.allSettled([session.mutate(), detail.mutate()]);
      }
      throw error;
    } finally {
      setBusy(false);
    }
  };

  let body: ReactNode;
  if (planningObjective) {
    body = (
      <div role="status" aria-live="polite">
        <PanelState
          icon="loader_icon"
          title={t("agentGoals.planning")}
          description={planningObjective}
          spin
        />
      </div>
    );
  } else if (session.isLoading) {
    body = (
      <PanelState icon="loader_icon" title={t("agentGoals.loading")} spin />
    );
  } else if (session.error && !missingSession) {
    body = (
      <PanelState
        icon="error_warning"
        title={t("agentGoals.loadFailed")}
        description={goalErrorMessage(t, session.error)}
        action={
          <Button size="sm" variant="outline" onClick={() => session.mutate()}>
            {t("common.retry", "Retry")}
          </Button>
        }
      />
    );
  } else if (missingSession || !session.data?.goals.length || composing) {
    body = (
      <GoalForm
        busy={busy}
        disabled={busy || chatBusy}
        onSubmit={async (objective) => {
          const response = await runCommand(() => onStartGoal(objective));
          setSelectedGoalId(response.goal.id);
          setComposing(false);
        }}
      />
    );
  } else if (detail.error) {
    body = (
      <PanelState
        icon="error_warning"
        title={t("agentGoals.detailFailed")}
        description={goalErrorMessage(t, detail.error)}
        action={
          <Button size="sm" variant="outline" onClick={() => detail.mutate()}>
            {t("common.retry", "Retry")}
          </Button>
        }
      />
    );
  } else if (!selectedGoalId || detail.isLoading || !currentDetail) {
    body = (
      <PanelState
        icon="loader_icon"
        title={t("agentGoals.loadingDetails")}
        spin
      />
    );
  } else {
    body = (
      <GoalDetail
        detail={currentDetail}
        busy={busy}
        chatBusy={chatBusy}
        onPause={async () => {
          await runCommand(() =>
            commands.pause(currentDetail.goal.id, currentDetail.goal.revision),
          );
          await onGoalPaused?.();
        }}
        onResume={() =>
          runCommand(() =>
            commands.resume(currentDetail.goal.id, currentDetail.goal.revision),
          ).then(() => undefined)
        }
      />
    );
  }

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      className={cn("flex h-full min-h-0 flex-col bg-background", className)}
    >
      <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
        <div className="flex min-w-0 items-center gap-2">
          <RemixIcon name="target" size="size-5" />
          <h2 className="truncate font-semibold">{t("agentGoals.title")}</h2>
          {session.data && (
            <span
              className={cn(
                "size-2 rounded-full",
                session.data.live ? "bg-emerald-500" : "bg-muted-foreground/40",
              )}
              title={
                session.data.live
                  ? t("agentGoals.live")
                  : t("agentGoals.offline")
              }
            />
          )}
        </div>
        <div className="flex items-center gap-1">
          {canCreate && !planningObjective && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setComposing((value) => !value)}
            >
              <RemixIcon name={composing ? "history" : "add"} size="size-4" />
              <span className="sr-only">
                {composing ? t("agentGoals.history") : t("agentGoals.newGoal")}
              </span>
            </Button>
          )}
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={onClose}
            >
              <RemixIcon name="close" size="size-4" />
              <span className="sr-only">{t("common.close", "Close")}</span>
            </Button>
          )}
        </div>
      </header>

      {!planningObjective && session.data && session.data.goals.length > 1 && (
        <div className="border-b px-4 py-3">
          <Label htmlFor="goal-history" className="sr-only">
            {t("agentGoals.history")}
          </Label>
          <select
            id="goal-history"
            value={selectedGoalId}
            onChange={(event) => {
              setSelectedGoalId(event.target.value);
              setComposing(false);
              setFeedback(undefined);
            }}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          >
            {session.data.goals.map(({ goal }) => (
              <option key={goal.id} value={goal.id}>
                {goal.objective}
              </option>
            ))}
          </select>
        </div>
      )}

      {feedback && !planningObjective && (
        <div
          role={feedback.tone === "error" ? "alert" : "status"}
          className={cn(
            "mx-4 mt-3 rounded-md border px-3 py-2 text-xs",
            feedback.tone === "error"
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : "border-blue-500/20 bg-blue-500/5 text-muted-foreground",
          )}
        >
          {feedback.message}
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4">{body}</div>
      </ScrollArea>
    </section>
  );
}

function GoalForm({
  busy,
  disabled,
  onSubmit,
}: {
  busy: boolean;
  disabled: boolean;
  onSubmit: (objective: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [objective, setObjective] = useState("");
  const [invalid, setInvalid] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = objective.trim();
    setInvalid(value.length === 0);
    if (!value) return;
    await onSubmit(value).catch(() => undefined);
  };

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div className="space-y-2">
        <Label htmlFor="goal-objective">{t("agentGoals.objective")}</Label>
        <Textarea
          id="goal-objective"
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
          placeholder={t("agentGoals.objectivePlaceholder")}
          rows={5}
          maxLength={8_000}
          disabled={disabled}
        />
        {invalid && (
          <FieldError>{t("agentGoals.objectiveRequired")}</FieldError>
        )}
        <p className="text-xs leading-5 text-muted-foreground">
          {t("agentGoals.planningHint")}
        </p>
      </div>

      <div className="flex justify-end border-t pt-4">
        <Button type="submit" disabled={disabled}>
          {busy && (
            <RemixIcon
              name="loader_icon"
              size="size-4"
              className="animate-spin"
            />
          )}
          {busy ? t("agentGoals.planning") : t("agentGoals.create")}
        </Button>
      </div>
    </form>
  );
}

function GoalDetail({
  detail,
  busy,
  chatBusy,
  onPause,
  onResume,
}: {
  detail: AgentGoalDetailResponse;
  busy: boolean;
  chatBusy: boolean;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { goal, progress } = detail;
  const stepView = goalStepsView(detail);
  const resumable = canResumeGoal(goal.status);

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap gap-2">
              <StatusBadge status={goal.status} />
            </div>
            <h3 className="break-words text-base font-semibold">
              {goal.objective}
            </h3>
          </div>
          {goal.status === "active" ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void onPause().catch(() => undefined)}
            >
              {busy && (
                <RemixIcon
                  name="loader_icon"
                  size="size-4"
                  className="animate-spin"
                />
              )}
              {!busy && <RemixIcon name="pause_circle" size="size-4" />}
              {t("agentGoals.pause")}
            </Button>
          ) : resumable ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || chatBusy}
              onClick={() => void onResume().catch(() => undefined)}
            >
              {busy && (
                <RemixIcon
                  name="loader_icon"
                  size="size-4"
                  className="animate-spin"
                />
              )}
              {!busy && <RemixIcon name="play_circle" size="size-4" />}
              {t("agentGoals.resume")}
            </Button>
          ) : null}
        </div>

        <Progress value={stepView.percent} className="h-2" />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>
            {t("agentGoals.stepsProgress", {
              done: stepView.completed,
              total: stepView.total,
            })}
          </span>
          <span>{stepView.percent}%</span>
        </div>
      </div>

      <Section title={t("agentGoals.steps")}>
        <ol className="space-y-2">
          {stepView.steps.map((step) => {
            const complete = step.state === "completed";
            const current = step.state === "current";
            return (
              <li
                key={step.id}
                className={cn(
                  "flex gap-3 rounded-md border border-transparent px-3 py-2 text-sm",
                  current && "border-primary/20 bg-primary/5",
                  complete && "text-emerald-700 dark:text-emerald-400",
                )}
              >
                <span className="flex size-5 shrink-0 items-center justify-center">
                  {complete ? (
                    <RemixIcon name="checkbox_circle" size="size-4" />
                  ) : (
                    <span
                      className={cn(
                        "flex size-5 items-center justify-center rounded-full border text-[11px]",
                        current
                          ? "border-primary text-primary"
                          : "border-muted-foreground/40 text-muted-foreground",
                      )}
                    >
                      {step.number}
                    </span>
                  )}
                </span>
                <span className={cn("leading-5", complete && "line-through")}>
                  {step.description}
                </span>
              </li>
            );
          })}
        </ol>
      </Section>

      <Section title={t("agentGoals.usage")}>
        <div className="grid grid-cols-3 gap-2 text-xs">
          <Metric
            label={t("agentGoals.turns")}
            value={String(progress.turnsUsed)}
          />
          <Metric
            label={t("agentGoals.tokens")}
            value={progress.tokensUsed.toLocaleString()}
          />
          <Metric
            label={t("agentGoals.elapsed")}
            value={formatDuration(progress.timeUsedSeconds)}
          />
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t pt-4">
      <h4 className="mb-3 text-sm font-semibold">{title}</h4>
      {children}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-muted/50 p-2">
      <div className="text-muted-foreground">{label}</div>
      <div className="mt-1 truncate font-medium" title={value}>
        {value}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: PublicAgentGoal["status"] }) {
  const { t } = useTranslation();
  const displayStatus = displayGoalStatus(status);

  return (
    <Badge
      variant={
        displayStatus === "completed"
          ? "default"
          : displayStatus === "failed"
            ? "destructive"
            : "secondary"
      }
      className="capitalize"
    >
      {goalValueLabel(t, "states", displayStatus)}
    </Badge>
  );
}

function FieldError({ children }: { children: ReactNode }) {
  return <p className="text-xs text-destructive">{children}</p>;
}

function PanelState({
  icon,
  title,
  description,
  action,
  spin,
}: {
  icon: string;
  title: string;
  description?: string;
  action?: ReactNode;
  spin?: boolean;
}) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center px-4 text-center">
      <RemixIcon
        name={icon}
        size="size-8"
        className={cn("mb-3 text-muted-foreground", spin && "animate-spin")}
      />
      <h3 className="font-medium">{title}</h3>
      {description && (
        <p className="mt-2 max-w-xs text-sm leading-5 text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

type GoalValueTranslationGroup = "states";

function goalValueLabel(
  t: TFunction,
  group: GoalValueTranslationGroup,
  value: string,
): string {
  const key = value.replaceAll(".", "_");
  const words = value.replaceAll(/[._]/g, " ").replace(/\bsdk\b/gi, "SDK");
  const fallback = words.charAt(0).toUpperCase() + words.slice(1);
  return t(`agentGoals.${group}.${key}`, fallback);
}

const DISPATCH_MESSAGE_KEYS: Record<string, string> = {
  accepted: "agentGoals.dispatch.sent",
  superseded: "agentGoals.dispatch.sent",
  unavailable: "agentGoals.dispatch.unavailable",
  deferred: "agentGoals.dispatch.deferred",
};

function dispatchMessage(t: TFunction, response: AgentGoalCommandResponse) {
  return t(
    DISPATCH_MESSAGE_KEYS[response.dispatch.status] ??
      "agentGoals.dispatch.retry",
  );
}

const GOAL_ERROR_MESSAGE_KEYS: Record<string, string> = {
  revision_conflict: "agentGoals.errors.revisionConflict",
  goal_not_active: "agentGoals.errors.goalNotActive",
  no_change: "agentGoals.errors.noChange",
  unauthorized: "agentGoals.errors.unauthorized",
  goal_runtime_unavailable: "agentGoals.errors.runtimeUnavailable",
  runtime_session_recovery_required: "agentGoals.errors.recoveryRequired",
  goal_planning_failed: "agentGoals.errors.planningFailed",
};

function goalErrorMessage(t: TFunction, error: unknown): string {
  if (!(error instanceof AgentGoalApiError)) {
    return t("agentGoals.errors.generic");
  }
  const messageKey = GOAL_ERROR_MESSAGE_KEYS[error.code];
  return messageKey
    ? t(messageKey)
    : (error.details ?? t("agentGoals.errors.requestFailed"));
}
