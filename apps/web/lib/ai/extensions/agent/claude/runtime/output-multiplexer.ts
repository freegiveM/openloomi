import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  GOAL_STEP_COMPLETION_MARKER_OPEN,
  stripGoalStepCompletionMarkers,
} from "@openloomi/ai/agent/runtime-instructions";
import type { AgentMessage } from "@openloomi/ai/agent/types";

import { convertClaudeSdkMessage } from "../message-converter";

/** Maintains the per-session state required to map Claude SDK output once. */
export class ClaudeOutputMultiplexer {
  private readonly sentTextHashes = new Set<string>();
  private readonly sentToolIds = new Set<string>();
  private hasStreamedText = false;
  private readonly stepMarkerFilter = new StreamingStepMarkerFilter();

  constructor(private readonly createMessageId: () => string) {}

  *convert(message: SDKMessage): Generator<AgentMessage> {
    let emittedStreamedText = false;
    for (const converted of convertClaudeSdkMessage({
      message,
      sentTextHashes: this.sentTextHashes,
      sentToolIds: this.sentToolIds,
      hasStreamedText: this.hasStreamedText,
      createMessageId: this.createMessageId,
    })) {
      if (message.type === "stream_event" && converted.type === "text") {
        emittedStreamedText = true;
        const content = this.stepMarkerFilter.push(converted.content ?? "");
        if (content) yield { ...converted, content };
        continue;
      }
      yield converted;
    }

    if (message.type === "assistant" || message.type === "result") {
      const content = this.stepMarkerFilter.finish();
      if (content) {
        yield { type: "text", content, messageId: this.createMessageId() };
      }
    }

    if (emittedStreamedText) {
      this.hasStreamedText = true;
    } else if (message.type === "assistant") {
      this.hasStreamedText = false;
    }
  }
}

/** Buffers only the possible first marker line; ordinary streamed text passes immediately. */
class StreamingStepMarkerFilter {
  private pending = "";
  private decided = false;
  private dropLeadingNewline = false;

  push(text: string): string | undefined {
    if (this.decided) return this.afterMarker(text);
    this.pending += text;

    if (GOAL_STEP_COMPLETION_MARKER_OPEN.startsWith(this.pending)) {
      return undefined;
    }
    if (!this.pending.startsWith(GOAL_STEP_COMPLETION_MARKER_OPEN)) {
      this.decided = true;
      return this.takePending();
    }

    const markerEnd = this.pending.indexOf("-->");
    if (markerEnd < 0 && this.pending.length <= 1_024) return undefined;
    if (markerEnd < 0) {
      this.decided = true;
      return this.takePending();
    }

    const before = this.pending;
    const stripped = stripGoalStepCompletionMarkers(before);
    this.decided = true;
    this.pending = "";
    if (stripped === before) return before;
    this.dropLeadingNewline = stripped.length === 0 && !/[\r\n]/.test(before);
    return stripped || undefined;
  }

  finish(): string | undefined {
    const content = this.takePending();
    this.reset();
    return content;
  }

  private afterMarker(text: string): string | undefined {
    if (!this.dropLeadingNewline) return text || undefined;
    this.dropLeadingNewline = false;
    const content = text.replace(/^\r?\n/, "");
    return content || undefined;
  }

  private takePending(): string | undefined {
    const content = this.pending;
    this.pending = "";
    return content || undefined;
  }

  private reset(): void {
    this.pending = "";
    this.decided = false;
    this.dropLeadingNewline = false;
  }
}
