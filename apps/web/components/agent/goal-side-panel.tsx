"use client";

import {
  Badge,
  Button,
  Input,
  Label,
  Progress,
  ScrollArea,
  Textarea,
} from "@openloomi/ui";
import {
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
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
  blankGoalDraft,
  formatDuration,
  goalDraft,
  goalInputFromDraft,
  goalProgressPercent,
  goalUpdateFromDraft,
  validateGoalDraft,
  type GoalDraft,
  type GoalDraftItem,
} from "@/lib/ai/runtime-instructions/goal-ui-model";
import { cn } from "@/lib/utils";

import "../../i18n";

interface AgentGoalSidePanelProps {
  runtimeSessionId: string;
  onClose?: () => void;
  className?: string;
}

export function AgentGoalSidePanel({
  runtimeSessionId,
  onClose,
  className,
}: AgentGoalSidePanelProps) {
  const { t } = useTranslation();
  const session = useAgentGoalSession(runtimeSessionId);
  const commands = useAgentGoalCommands(runtimeSessionId);
  const [selectedGoalId, setSelectedGoalId] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [editingRevision, setEditingRevision] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: "error" | "info";
    message: string;
  }>();

  useEffect(() => {
    if (!session.data) return;
    const stillExists = session.data.goals.some(
      ({ goal }) => goal.id === selectedGoalId,
    );
    if (!stillExists) {
      setSelectedGoalId(
        session.data.activeGoalId ?? session.data.goals[0]?.goal.id,
      );
      setEditing(false);
      setEditingRevision(undefined);
    }
  }, [selectedGoalId, session.data]);

  const detail = useAgentGoalDetail(
    runtimeSessionId,
    selectedGoalId,
    Boolean(session.data),
  );
  const currentDetail =
    detail.data?.goal.id === selectedGoalId ? detail.data : undefined;

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
        setEditing(false);
        setEditingRevision(undefined);
        await Promise.allSettled([session.mutate(), detail.mutate()]);
      }
      throw error;
    } finally {
      setBusy(false);
    }
  };

  let body: ReactNode;
  if (session.isLoading) {
    body = <PanelState icon="loader_icon" title={t("agentGoals.loading")} spin />;
  } else if (session.error) {
    const unsaved =
      session.error instanceof AgentGoalApiError && session.error.status === 404;
    body = (
      <PanelState
        icon={unsaved ? "message" : "error_warning"}
        title={
          unsaved
            ? t("agentGoals.unsavedTitle")
            : t("agentGoals.loadFailed")
        }
        description={
          unsaved
            ? t("agentGoals.unsavedDescription")
            : goalErrorMessage(t, session.error)
        }
        action={
          <Button size="sm" variant="outline" onClick={() => session.mutate()}>
            {t("common.retry", "Retry")}
          </Button>
        }
      />
    );
  } else if (!session.data?.goals.length) {
    body = (
      <GoalForm
        busy={busy}
        submitLabel={t("agentGoals.create")}
        onSubmit={async (draft) => {
          const response = await runCommand(() =>
            commands.activate(goalInputFromDraft(draft)),
          );
          setSelectedGoalId(response.goal.id);
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
  } else if (
    !selectedGoalId ||
    detail.isLoading ||
    !currentDetail
  ) {
    body = <PanelState icon="loader_icon" title={t("agentGoals.loadingDetails")} spin />;
  } else if (editing) {
    body = (
      <GoalForm
        initial={currentDetail.goal}
        busy={busy}
        submitLabel={t("common.save", "Save")}
        onCancel={() => {
          setEditing(false);
          setEditingRevision(undefined);
        }}
        onSubmit={async (draft) => {
          await runCommand(() =>
            commands.update(
              currentDetail.goal.id,
              editingRevision ?? currentDetail.goal.revision,
              goalUpdateFromDraft(draft),
            ),
          );
          setEditing(false);
          setEditingRevision(undefined);
        }}
      />
    );
  } else {
    body = (
      <GoalDetail
        detail={currentDetail}
        busy={busy}
        onEdit={() => {
          setEditingRevision(currentDetail.goal.revision);
          setEditing(true);
        }}
        onUpsertContext={(contextRef, expectedRevision) =>
          runCommand(() =>
            commands.upsertContext(
              currentDetail.goal.id,
              expectedRevision,
              contextRef,
            ),
          ).then(() => undefined)
        }
        onRemoveContext={(contextRefId) =>
          runCommand(() =>
            commands.removeContext(
              currentDetail.goal.id,
              currentDetail.goal.revision,
              contextRefId,
            ),
          ).then(() => undefined)
        }
      />
    );
  }

  return (
    <section className={cn("flex h-full min-h-0 flex-col bg-background", className)}>
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
              title={session.data.live ? t("agentGoals.live") : t("agentGoals.offline")}
            />
          )}
        </div>
        {onClose && (
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
            <RemixIcon name="close" size="size-4" />
            <span className="sr-only">{t("common.close", "Close")}</span>
          </Button>
        )}
      </header>

      {session.data && session.data.goals.length > 1 && (
        <div className="border-b px-4 py-3">
          <Label htmlFor="goal-history" className="sr-only">
            {t("agentGoals.history")}
          </Label>
          <select
            id="goal-history"
            value={selectedGoalId}
            onChange={(event) => {
              setSelectedGoalId(event.target.value);
              setEditing(false);
              setEditingRevision(undefined);
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

      {feedback && (
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
  initial,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: PublicAgentGoal;
  busy: boolean;
  submitLabel: string;
  onSubmit: (draft: GoalDraft) => Promise<void>;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() =>
    initial ? goalDraft(initial) : blankGoalDraft(),
  );
  const [validation, setValidation] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const invalid = validateGoalDraft(draft, !initial);
    setValidation(invalid ?? undefined);
    if (invalid) return;
    await onSubmit(draft).catch(() => undefined);
  };

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div className="space-y-2">
        <Label htmlFor="goal-objective">{t("agentGoals.objective")}</Label>
        <Textarea
          id="goal-objective"
          value={draft.objective}
          onChange={(event) => setDraft({ ...draft, objective: event.target.value })}
          placeholder={t("agentGoals.objectivePlaceholder")}
          rows={3}
          maxLength={8_000}
          disabled={busy}
        />
        {validation === "objective" && <FieldError>{t("agentGoals.objectiveRequired")}</FieldError>}
      </div>

      {!initial && (
        <>
          <DraftList
            label={t("agentGoals.criteria")}
            addLabel={t("agentGoals.addCriterion")}
            items={draft.criteria}
            required
            busy={busy}
            placeholder={t("agentGoals.criterionPlaceholder")}
            onChange={(criteria) => setDraft({ ...draft, criteria })}
          />
          {validation === "criteria" && <FieldError>{t("agentGoals.criteriaRequired")}</FieldError>}

          <DraftList
            label={t("agentGoals.constraints")}
            addLabel={t("agentGoals.addConstraint")}
            items={draft.constraints}
            busy={busy}
            placeholder={t("agentGoals.constraintPlaceholder")}
            onChange={(constraints) => setDraft({ ...draft, constraints })}
          />
          {validation === "constraints" && <FieldError>{t("agentGoals.constraintsIncomplete")}</FieldError>}
        </>
      )}

      <div className="grid grid-cols-2 gap-3">
        <NumberField
          id="goal-priority"
          label={t("agentGoals.priorityRange")}
          value={draft.priority}
          min={0}
          max={100}
          disabled={busy}
          onChange={(priority) => setDraft({ ...draft, priority })}
        />
        <NumberField
          id="goal-turns"
          label={t("agentGoals.maxTurns")}
          value={draft.maxTurns}
          min={1}
          max={10_000}
          optional={Boolean(initial)}
          disabled={busy}
          onChange={(maxTurns) => setDraft({ ...draft, maxTurns })}
        />
        <NumberField
          id="goal-tokens"
          label={t("agentGoals.maxTokens")}
          value={draft.maxTokens}
          min={1}
          max={100_000_000}
          optional
          disabled={busy}
          onChange={(maxTokens) => setDraft({ ...draft, maxTokens })}
        />
        <NumberField
          id="goal-duration"
          label={t("agentGoals.maxDuration")}
          value={draft.maxDurationSeconds}
          min={1}
          max={30 * 24 * 60 * 60}
          optional
          disabled={busy}
          onChange={(maxDurationSeconds) =>
            setDraft({ ...draft, maxDurationSeconds })
          }
        />
      </div>
      {(validation === "priority" || validation === "budget") && (
        <FieldError>{t("agentGoals.invalidBudget")}</FieldError>
      )}

      <div className="space-y-2">
        <Label htmlFor="goal-deadline">{t("agentGoals.deadline")}</Label>
        <Input
          id="goal-deadline"
          type="datetime-local"
          value={draft.deadline}
          disabled={busy}
          onChange={(event) => setDraft({ ...draft, deadline: event.target.value })}
        />
        {validation === "deadline" && <FieldError>{t("agentGoals.invalidDeadline")}</FieldError>}
      </div>

      <div className="flex justify-end gap-2 border-t pt-4">
        {onCancel && (
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            {t("common.cancel", "Cancel")}
          </Button>
        )}
        <Button type="submit" disabled={busy}>
          {busy && <RemixIcon name="loader_icon" size="size-4" className="animate-spin" />}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function GoalDetail({
  detail,
  busy,
  onEdit,
  onUpsertContext,
  onRemoveContext,
}: {
  detail: AgentGoalDetailResponse;
  busy: boolean;
  onEdit: () => void;
  onUpsertContext: (
    context: ContextInput,
    expectedRevision: number,
  ) => Promise<void>;
  onRemoveContext: (contextRefId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { goal, latestRun, latestDelivery, progress, evidence } = detail;
  const satisfied = useMemo(() => {
    const ids = new Set(latestRun?.lastEvaluation?.satisfiedCriteria ?? []);
    for (const item of evidence) {
      if (item.success && item.criterionId) ids.add(item.criterionId);
    }
    return ids;
  }, [evidence, latestRun?.lastEvaluation?.satisfiedCriteria]);
  const editable = goal.status === "active";

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap gap-2">
              <StatusBadge status={goal.status} />
              <Badge variant="outline">{detail.live ? t("agentGoals.live") : t("agentGoals.waiting")}</Badge>
            </div>
            <h3 className="break-words text-base font-semibold">{goal.objective}</h3>
          </div>
          {editable && (
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onEdit}>
              <RemixIcon name="edit" size="size-4" />
              <span className="sr-only">{t("agentGoals.edit")}</span>
            </Button>
          )}
        </div>
        <Progress value={goalProgressPercent(detail)} className="h-2" />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{t("agentGoals.criteriaProgress", { done: progress.completedCriteria, total: progress.totalCriteria })}</span>
          <span>{goalProgressPercent(detail)}%</span>
        </div>
      </div>

      <Section title={t("agentGoals.execution")}>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <Metric label={t("agentGoals.runStatus")} value={latestRun ? goalValueLabel(t, "states", latestRun.status) : t("agentGoals.notStarted")} />
          <Metric label={t("agentGoals.delivery")} value={latestDelivery ? goalValueLabel(t, "states", latestDelivery.state) : t("agentGoals.notQueued")} />
          <Metric label={t("agentGoals.turns")} value={`${progress.turnsUsed}${goal.maxTurns ? ` / ${goal.maxTurns}` : ""}`} />
          <Metric label={t("agentGoals.tokens")} value={`${progress.tokensUsed.toLocaleString()}${goal.maxTokens ? ` / ${goal.maxTokens.toLocaleString()}` : ""}`} />
          <Metric label={t("agentGoals.elapsed")} value={`${formatDuration(progress.timeUsedSeconds)}${goal.maxDurationSeconds ? ` / ${formatDuration(goal.maxDurationSeconds)}` : ""}`} />
          <Metric label={t("agentGoals.priority")} value={String(goal.priority)} />
        </div>
        {latestDelivery && (
          <p className="mt-2 text-xs text-muted-foreground">
            {t(
              "agentGoals.deliveryDetail",
              {
                kind: goalValueLabel(t, "instructionKinds", latestDelivery.kind),
                sequence: latestDelivery.sequence,
                attempt: latestDelivery.attempt,
              },
            )}
          </p>
        )}
        {goal.deadline && <p className="mt-2 text-xs text-muted-foreground">{t("agentGoals.deadlineValue", { date: new Date(goal.deadline).toLocaleString() })}</p>}
        {progress.lastReason && <p className="mt-3 rounded-md bg-muted/50 p-3 text-xs leading-5">{progress.lastReason}</p>}
      </Section>

      <Section title={t("agentGoals.criteria")}>
        <ul className="space-y-2">
          {goal.successCriteria.map((criterion) => {
            const complete = satisfied.has(criterion.id);
            return (
              <li key={criterion.id} className="flex gap-2 text-sm">
                <RemixIcon name={complete ? "checkbox_circle" : "checkbox_blank"} size="size-4" className={complete ? "text-emerald-500" : "mt-0.5 text-muted-foreground"} />
                <span className={complete ? "text-muted-foreground line-through" : undefined}>{criterion.description}</span>
              </li>
            );
          })}
        </ul>
      </Section>

      {goal.constraints.length > 0 && (
        <Section title={t("agentGoals.constraints")}>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {goal.constraints.map((constraint) => <li key={constraint.id}>{constraint.description}</li>)}
          </ul>
        </Section>
      )}

      <GoalContextSection
        key={goal.id}
        goal={goal}
        busy={busy}
        editable={editable}
        onUpsert={onUpsertContext}
        onRemove={onRemoveContext}
      />

      <Section title={t("agentGoals.evidence")}>
        {evidence.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("agentGoals.noEvidence")}</p>
        ) : (
          <ol className="space-y-3">
            {evidence.map((item) => (
              <li key={item.id} className="border-l-2 pl-3 text-sm">
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>{goalValueLabel(t, "evidenceTypes", item.type)}</span>
                  <time dateTime={item.observedAt}>{new Date(item.observedAt).toLocaleTimeString()}</time>
                </div>
                <p className="mt-1 break-words">{item.summary}</p>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </div>
  );
}

type ContextInput = {
  id: string;
  kind: PublicAgentGoal["contextRefs"][number]["kind"];
  refId: string;
  label?: string;
  summary?: string;
};

type ContextDraft = ContextInput & { expectedRevision: number };

function GoalContextSection({
  goal,
  busy,
  editable,
  onUpsert,
  onRemove,
}: {
  goal: PublicAgentGoal;
  busy: boolean;
  editable: boolean;
  onUpsert: (context: ContextInput, expectedRevision: number) => Promise<void>;
  onRemove: (contextRefId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ContextDraft>();
  const [invalid, setInvalid] = useState(false);

  const edit = (context?: PublicAgentGoal["contextRefs"][number]) => {
    setInvalid(false);
    setDraft(
      context
        ? {
            id: context.id,
            kind: context.kind,
            refId: context.refId,
            label: context.label,
            summary: context.summary,
            expectedRevision: goal.revision,
          }
        : {
            id: `context-${crypto.randomUUID()}`,
            kind: "custom",
            refId: "",
            label: "",
            summary: "",
            expectedRevision: goal.revision,
          },
    );
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft?.refId.trim()) {
      setInvalid(true);
      return;
    }
    const { expectedRevision, ...context } = draft;
    await onUpsert(
      {
        ...context,
        refId: context.refId.trim(),
        ...(context.label?.trim()
          ? { label: context.label.trim() }
          : { label: undefined }),
        ...(context.summary?.trim()
          ? { summary: context.summary.trim() }
          : { summary: undefined }),
      },
      expectedRevision,
    )
      .then(() => setDraft(undefined))
      .catch(() => undefined);
  };

  return (
    <Section
      title={t("agentGoals.context")}
      action={
        editable && !draft ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => edit()}>
            <RemixIcon name="add" size="size-4" />
            {t("common.add", "Add")}
          </Button>
        ) : undefined
      }
    >
      {goal.contextRefs.length === 0 && !draft && (
        <p className="text-sm text-muted-foreground">{t("agentGoals.noContext")}</p>
      )}
      <ul className="space-y-2">
        {goal.contextRefs.map((context) => (
          <li key={context.id} className="rounded-md border p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{context.label ?? context.refId}</p>
                <p className="text-xs text-muted-foreground">{goalValueLabel(t, "contextKinds", context.kind)}</p>
              </div>
              {editable && (
                <div className="flex shrink-0">
                  <Button variant="ghost" size="icon" className="h-7 w-7" disabled={busy} onClick={() => edit(context)}>
                    <RemixIcon name="edit" size="size-3.5" />
                    <span className="sr-only">{t("common.edit", "Edit")}</span>
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" disabled={busy} onClick={() => onRemove(context.id).catch(() => undefined)}>
                    <RemixIcon name="delete_bin" size="size-3.5" />
                    <span className="sr-only">{t("common.delete", "Delete")}</span>
                  </Button>
                </div>
              )}
            </div>
            {context.summary && <p className="mt-2 text-xs leading-5 text-muted-foreground">{context.summary}</p>}
          </li>
        ))}
      </ul>

      {draft && (
        <form className="mt-3 space-y-3 rounded-md border p-3" onSubmit={submit}>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="goal-context-kind">{t("agentGoals.contextKind")}</Label>
              <select
                id="goal-context-kind"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={draft.kind}
                disabled={busy}
                onChange={(event) => setDraft({ ...draft, kind: event.target.value as ContextInput["kind"] })}
              >
                {["custom", "project", "task", "decision", "document", "event", "entity", "insight", "connector_record"].map((kind) => (
                  <option key={kind} value={kind}>{goalValueLabel(t, "contextKinds", kind)}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="goal-context-ref">{t("agentGoals.reference")}</Label>
              <Input id="goal-context-ref" value={draft.refId} maxLength={256} disabled={busy} onChange={(event) => setDraft({ ...draft, refId: event.target.value })} />
            </div>
          </div>
          <Input aria-label={t("agentGoals.contextLabel")} placeholder={t("agentGoals.contextLabelPlaceholder")} value={draft.label ?? ""} maxLength={512} disabled={busy} onChange={(event) => setDraft({ ...draft, label: event.target.value })} />
          <Textarea aria-label={t("agentGoals.contextSummary")} placeholder={t("agentGoals.contextSummaryPlaceholder")} value={draft.summary ?? ""} rows={2} maxLength={8_000} disabled={busy} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} />
          {invalid && <FieldError>{t("agentGoals.referenceRequired")}</FieldError>}
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(undefined)}>{t("common.cancel", "Cancel")}</Button>
            <Button type="submit" size="sm" disabled={busy}>{t("common.save", "Save")}</Button>
          </div>
        </form>
      )}
    </Section>
  );
}

function DraftList({
  label,
  addLabel,
  items,
  placeholder,
  required,
  busy,
  onChange,
}: {
  label: string;
  addLabel: string;
  items: GoalDraftItem[];
  placeholder: string;
  required?: boolean;
  busy: boolean;
  onChange: (items: GoalDraftItem[]) => void;
}) {
  const { t } = useTranslation();

  return (
    <fieldset className="space-y-2">
      <div className="flex items-center justify-between">
        <legend className="text-sm font-medium">{label}</legend>
        <Button type="button" variant="ghost" size="sm" disabled={busy || items.length >= 64} onClick={() => onChange([...items, { id: crypto.randomUUID(), description: "" }])}>
          <RemixIcon name="add" size="size-4" />
          {addLabel}
        </Button>
      </div>
      {items.map((item, index) => (
        <div key={item.id} className="flex gap-2">
          <Input aria-label={`${label} ${index + 1}`} value={item.description} placeholder={placeholder} maxLength={2_000} disabled={busy} onChange={(event) => onChange(items.map((entry) => entry.id === item.id ? { ...entry, description: event.target.value } : entry))} />
          <Button type="button" variant="ghost" size="icon" className="h-9 w-9 shrink-0" disabled={busy || (required && items.length === 1)} onClick={() => onChange(items.filter((entry) => entry.id !== item.id))}>
            <RemixIcon name="close" size="size-4" />
            <span className="sr-only">{t("agentGoals.removeItem", { index: index + 1 })}</span>
          </Button>
        </div>
      ))}
    </fieldset>
  );
}

function NumberField({ id, label, value, onChange, optional, ...props }: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  optional?: boolean;
} & Pick<ComponentProps<typeof Input>, "min" | "max" | "disabled">) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="number" value={value} required={!optional} onChange={(event) => onChange(event.target.value)} {...props} />
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t pt-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{title}</h4>
        {action}
      </div>
      {children}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/50 p-2">
      <div className="text-muted-foreground">{label}</div>
      <div className="mt-1 truncate font-medium capitalize" title={value}>{value.replaceAll("_", " ")}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: PublicAgentGoal["status"] }) {
  const { t } = useTranslation();

  return (
    <Badge variant={status === "completed" ? "default" : status === "failed" || status === "blocked" ? "destructive" : "secondary"} className="capitalize">
      {goalValueLabel(t, "states", status)}
    </Badge>
  );
}

function FieldError({ children }: { children: ReactNode }) {
  return <p className="text-xs text-destructive">{children}</p>;
}

function PanelState({ icon, title, description, action, spin }: { icon: string; title: string; description?: string; action?: ReactNode; spin?: boolean }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center px-4 text-center">
      <RemixIcon name={icon} size="size-8" className={cn("mb-3 text-muted-foreground", spin && "animate-spin")} />
      <h3 className="font-medium">{title}</h3>
      {description && <p className="mt-2 max-w-xs text-sm leading-5 text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

type GoalValueTranslationGroup =
  | "states"
  | "instructionKinds"
  | "evidenceTypes"
  | "contextKinds";

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
