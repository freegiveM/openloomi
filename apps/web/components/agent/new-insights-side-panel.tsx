"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@openloomi/ui";
import { RemixIcon } from "@/components/remix-icon";
import { getAuthToken } from "@/lib/auth/token-manager";
import { cn } from "@/lib/utils";

interface NewInsightsSidePanelProps {
  onInsightClick?: (insightId: string) => void;
  onSuggestionClick?: (suggestion: string) => void;
}

interface SuggestedPrompt {
  id: string;
  title: string;
  emoji: string;
  type:
    | "event_based"
    | "pattern_based"
    | "role_based"
    | "urgent"
    | "high_priority"
    | "potential";
  priority?: "urgent" | "high_priority" | "potential";
  reasoning: string;
  summary?: string;
  platform?: string;
  sourceLabel?: string;
  time?: string;
  categories?: string[];
  related_insight_ids: string[];
  insightId?: string;
}

/**
 * Side panel component showing AI-generated conversation starters (Suggestions)
 */
export function NewInsightsSidePanel({
  onInsightClick,
  onSuggestionClick,
}: NewInsightsSidePanelProps) {
  const { t } = useTranslation();
  const [suggestions, setSuggestions] = useState<SuggestedPrompt[]>([]);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);
  const lastSuggestionsFetchRef = useRef<number | null>(null);
  const SUGGESTIONS_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

  const fetchSuggestions = useCallback(async () => {
    setIsLoadingSuggestions(true);
    setSuggestionsError(null);
    try {
      const headers: HeadersInit = {};
      try {
        const cloudAuthToken = getAuthToken();
        if (cloudAuthToken) {
          headers.Authorization = `Bearer ${cloudAuthToken}`;
        }
      } catch (error) {
        console.error(
          "[NewInsightsSidePanel] Failed to read cloud_auth_token:",
          error,
        );
      }

      const response = await fetch("/api/daily-focus/suggestions", {
        method: "GET",
        headers,
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch suggestions: ${response.status}`);
      }

      const data = await response.json();
      setSuggestions(data.suggested_prompts || []);
      lastSuggestionsFetchRef.current = Date.now();
    } catch (error) {
      console.error(
        "[NewInsightsSidePanel] Failed to fetch suggestions:",
        error,
      );
      setSuggestionsError(
        error instanceof Error ? error.message : "Failed to load suggestions",
      );
    } finally {
      setIsLoadingSuggestions(false);
    }
  }, []);

  // Fetch suggestions on mount (with 5 min cache)
  useEffect(() => {
    const now = Date.now();
    const lastFetch = lastSuggestionsFetchRef.current;
    const shouldFetch =
      suggestions.length === 0 ||
      (lastFetch && now - lastFetch > SUGGESTIONS_CACHE_DURATION);
    if (shouldFetch) {
      fetchSuggestions();
    }
  }, [suggestions.length, fetchSuggestions]);

  // Build display suggestions - always add test RSVP at top
  const hasRsvp = suggestions.some(
    (s) => s.categories?.includes("RSVP") || s.categories?.includes("Meetings"),
  );

  // Fetch real insights for test RSVP insightId
  const [realInsightId, setRealInsightId] = useState<string | null>(null);
  useEffect(() => {
    const fetchRealInsightId = async () => {
      try {
        const headers: HeadersInit = {};
        const cloudAuthToken = getAuthToken();
        if (cloudAuthToken) {
          headers.Authorization = `Bearer ${cloudAuthToken}`;
        }
        const response = await fetch("/api/insights/all", {
          method: "GET",
          headers,
          credentials: "include",
        });
        if (response.ok) {
          const data = await response.json();
          const insights = data.newInsights || [];
          if (insights.length > 0) {
            setRealInsightId(insights[0].id);
          }
        }
      } catch (error) {
        console.error(
          "[NewInsightsSidePanel] Failed to fetch real insightId:",
          error,
        );
      }
    };
    fetchRealInsightId();
  }, []);

  const displaySuggestions: SuggestedPrompt[] = (() => {
    if (suggestions.length === 0) return [];

    // Only add test RSVP when we have a real insightId
    if (realInsightId) {
      const firstSuggestion = suggestions[0];
      const testRsvp: SuggestedPrompt = {
        id: "test_rsvp",
        title: "回复确认会议邀请",
        emoji: "📅",
        type: "event_based",
        priority: "high_priority",
        reasoning: "测试RSVP - 点击发送上下文到chat并打开insight",
        summary:
          firstSuggestion?.summary || firstSuggestion?.title || "会议邀请",
        platform: firstSuggestion?.platform || "Gmail",
        sourceLabel:
          firstSuggestion?.sourceLabel || firstSuggestion?.platform || "Gmail",
        time: firstSuggestion?.time || "最近",
        categories: ["RSVP"],
        related_insight_ids: firstSuggestion?.related_insight_ids || [],
        insightId: realInsightId,
      };
      return [testRsvp, ...suggestions];
    }

    return suggestions;
  })();

  const handleSuggestionClick = (suggestion: SuggestedPrompt) => {
    // Check if this is an RSVP suggestion
    const isRsvp =
      suggestion.categories?.includes("RSVP") ||
      suggestion.categories?.includes("Meetings");
    // Use insightId if available, otherwise fall back to related_insight_ids[0]
    const insightId =
      suggestion.insightId || suggestion.related_insight_ids?.[0];

    // Build comprehensive context for chat
    const parts: string[] = [];
    parts.push(suggestion.title);
    if (suggestion.sourceLabel) {
      parts.push(`来源: ${suggestion.sourceLabel}`);
    } else if (suggestion.platform && suggestion.platform !== "unknown") {
      parts.push(`平台: ${suggestion.platform}`);
    }
    if (suggestion.summary) {
      parts.push(`详情: ${suggestion.summary}`);
    }
    if (suggestion.time) {
      parts.push(`时间: ${suggestion.time}`);
    }
    const message = parts.join("\n");

    // RSVP/Meetings: only open insight, do NOT send message to chat
    if (isRsvp) {
      if (insightId?.trim()) {
        onInsightClick?.(insightId);
      }
      return;
    }

    // Non-RSVP: only send context to chat, do NOT open insight
    onSuggestionClick?.(message);
  };

  return (
    <div className="flex h-full min-w-[260px] max-w-[360px] w-[320px] flex-col overflow-hidden border-0 border-l border-border">
      {/* Header */}
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-lg">💡</span>
          <h3 className="flex-1 font-semibold text-sm">Suggestions</h3>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={fetchSuggestions}
            disabled={isLoadingSuggestions}
            aria-label={t("common.refresh", "Refresh")}
          >
            <RemixIcon
              name="refresh"
              size="size-4"
              className={isLoadingSuggestions ? "animate-spin" : ""}
            />
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto py-2">
        {suggestionsError ? (
          <div className="flex flex-col items-center justify-center py-8 text-center text-sm text-muted-foreground">
            <span className="text-2xl mb-2">⚠️</span>
            <p>{suggestionsError}</p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 text-xs"
              onClick={fetchSuggestions}
            >
              Retry
            </Button>
          </div>
        ) : displaySuggestions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center text-sm text-muted-foreground">
            {isLoadingSuggestions ? (
              <>
                <RemixIcon
                  name="loader_icon"
                  size="size-6"
                  className="animate-spin mb-2"
                />
                <p>Loading suggestions...</p>
              </>
            ) : (
              <>
                <span className="text-2xl mb-2">💡</span>
                <p>No suggestions available</p>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-2 px-3">
            {displaySuggestions.map((suggestion) => (
              <button
                type="button"
                key={suggestion.id}
                onClick={() => handleSuggestionClick(suggestion)}
                className="w-full flex items-start gap-3 px-3 py-2.5 rounded-lg hover:bg-muted transition-colors text-left"
              >
                <span className="text-xl shrink-0">{suggestion.emoji}</span>
                <div className="flex-1 min-w-0">
                  {/* Platform and Category tags */}
                  <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                    {suggestion.platform &&
                      suggestion.platform !== "unknown" && (
                        <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                          {suggestion.platform}
                        </span>
                      )}
                    {suggestion.categories &&
                      suggestion.categories.length > 0 &&
                      suggestion.categories.slice(0, 2).map((cat) => (
                        <span
                          key={cat}
                          className="text-[10px] text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded"
                        >
                          {cat}
                        </span>
                      ))}
                  </div>
                  {/* Title */}
                  <p className="text-sm font-medium text-foreground leading-tight">
                    {suggestion.title}
                  </p>
                  {/* Summary/Context */}
                  {suggestion.summary && (
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                      {suggestion.summary}
                    </p>
                  )}
                  {suggestion.reasoning && (
                    <p className="text-[10px] text-muted-foreground/70 mt-1 italic">
                      {suggestion.reasoning}
                    </p>
                  )}
                </div>
                <RemixIcon
                  name="arrow_right_s"
                  size="size-4"
                  className="text-muted-foreground shrink-0 mt-1"
                />
              </button>
            ))}
          </div>
        )}

        {/* Refresh suggestions button */}
        <div className="px-3 pt-2 border-t border-border mt-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-xs text-muted-foreground"
            onClick={fetchSuggestions}
            disabled={isLoadingSuggestions}
          >
            <RemixIcon
              name="refresh"
              size="size-3.5"
              className={cn("mr-1", isLoadingSuggestions && "animate-spin")}
            />
            Refresh Suggestions
          </Button>
        </div>
      </div>
    </div>
  );
}
