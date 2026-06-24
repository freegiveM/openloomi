"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@openloomi/ui";
import { toast } from "@/components/toast";
import { useNewInsightsContext } from "@/components/insights-new-context";
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
  type: "event_based" | "pattern_based" | "role_based" | "urgent" | "high_priority" | "potential";
  priority?: "urgent" | "high_priority" | "potential";
  reasoning: string;
  summary?: string;
  platform?: string;
  sourceLabel?: string;
  time?: string;
  categories?: string[];
  related_insight_ids: string[];
}

type TabType = "insights" | "suggestions";

/**
 * Side panel component with two tabs:
 * - "Need to Know": new insights from refresh
 * - "Suggestions": AI-generated conversation starters
 */
export function NewInsightsSidePanel({
  onInsightClick,
  onSuggestionClick,
}: NewInsightsSidePanelProps) {
  const { t } = useTranslation();
  const {
    newInsights,
    newInsightsCount,
    clearNewInsights,
    setNewInsights,
  } = useNewInsightsContext();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>("insights");

  // Suggestions state
  const [suggestions, setSuggestions] = useState<SuggestedPrompt[]>([]);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);
  const lastSuggestionsFetchRef = useRef<number | null>(null);
  const SUGGESTIONS_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

  const handleRefresh = useCallback(async () => {
    if (isRefreshing) return;

    setIsRefreshing(true);
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

      const response = await fetch("/api/insights/all", {
        method: "GET",
        headers,
        credentials: "include",
        signal: AbortSignal.timeout(5 * 60 * 1000),
      });

      if (!response.ok) {
        toast({
          type: "error",
          description: t("insight.refreshError.default", "Refresh failed"),
        });
        return;
      }

      const result = await response.json();

      if (result.newInsights && Array.isArray(result.newInsights)) {
        const insights = result.newInsights.map((item: any) => ({
          id: item.id,
          title: item.title,
          summary: item.summary || item.description || "",
          platform: item.platform,
          categories: item.categories,
        }));
        setNewInsights(insights, result.newInsightsCount ?? insights.length);
      }

      toast({
        type: "success",
        description: t("insight.refreshSuccess", "Refreshed successfully"),
      });
    } catch (error) {
      console.error("[NewInsightsSidePanel] Refresh error:", error);
      toast({
        type: "error",
        description: t("insight.refreshError.default", "Refresh failed"),
      });
    } finally {
      setIsRefreshing(false);
    }
  }, [isRefreshing, setNewInsights, t]);

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
      console.error("[NewInsightsSidePanel] Failed to fetch suggestions:", error);
      setSuggestionsError(
        error instanceof Error ? error.message : "Failed to load suggestions",
      );
    } finally {
      setIsLoadingSuggestions(false);
    }
  }, []);

  // Fetch suggestions when switching to suggestions tab (with 5 min cache)
  useEffect(() => {
    if (activeTab === "suggestions") {
      const now = Date.now();
      const lastFetch = lastSuggestionsFetchRef.current;
      const shouldFetch = suggestions.length === 0 ||
        (lastFetch && now - lastFetch > SUGGESTIONS_CACHE_DURATION);
      if (shouldFetch) {
        fetchSuggestions();
      }
    }
  }, [activeTab, suggestions.length, fetchSuggestions]);

  const handleSuggestionClick = (suggestion: SuggestedPrompt) => {
    onSuggestionClick?.(suggestion.title);
  };

  // Display up to 10 insights
  const displayedInsights = newInsights.slice(0, 10);
  const remainingCount = newInsightsCount - displayedInsights.length;

  /** Get platform display name */
  const getPlatformName = (platform: string | undefined): string => {
    if (!platform) return "Unknown";
    const platformMap: Record<string, string> = {
      gmail: "Gmail",
      slack: "Slack",
      discord: "Discord",
      telegram: "Telegram",
      whatsapp: "WhatsApp",
      feishu: "Feishu",
      dingtalk: "DingTalk",
    };
    return platformMap[platform.toLowerCase()] || platform;
  };

  return (
    <div className="flex h-full min-w-[260px] max-w-[360px] w-[320px] flex-col overflow-hidden border-0 border-l border-border">
      {/* Header with Tabs */}
      <div className="border-b border-border px-4 py-3">
        {/* Tabs */}
        <div className="flex items-center gap-1 mb-3">
          <button
            type="button"
            onClick={() => setActiveTab("insights")}
            className={cn(
              "flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
              activeTab === "insights"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {t("insight.needYouToKnow", "Need to Know")}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("suggestions")}
            className={cn(
              "flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
              activeTab === "suggestions"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            Suggestions
          </button>
        </div>

        {/* Tab-specific header actions */}
        {activeTab === "insights" && (
          <div className="flex items-center gap-2">
            <span className="text-lg">✨</span>
            <h3 className="flex-1 font-semibold text-sm">
              {t("insight.needYouToKnow", "Need to Know")}
            </h3>
            {newInsightsCount > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
                {newInsightsCount > 99 ? "99+" : newInsightsCount}
              </span>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleRefresh}
              disabled={isRefreshing}
              aria-label={t("common.refresh", "Refresh")}
            >
              <RemixIcon
                name="refresh"
                size="size-4"
                className={isRefreshing ? "animate-spin" : ""}
              />
            </Button>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Need to Know Tab */}
        {activeTab === "insights" && (
          <>
            {newInsightsCount === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center text-sm text-muted-foreground">
                <span className="text-2xl mb-2">💤</span>
                <p>{t("insight.noNewInsights", "No new insights")}</p>
              </div>
            ) : (
              <div className="py-1">
                {displayedInsights.map((insight) => (
                  <button
                    type="button"
                    key={insight.id}
                    className="w-full text-left relative flex items-start gap-3 px-4 py-2.5 cursor-pointer hover:bg-primary-50 transition-colors"
                    onClick={() => onInsightClick?.(insight.id)}
                  >
                    {/* Left: Platform icon */}
                    {getPlatformName(insight.platform) !== "Unknown" && (
                      <div className="shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center mt-0.5">
                        {insight.platform ? (
                          <RemixIcon
                            name={insight.platform.toLowerCase()}
                            size="size-4"
                            className="text-muted-foreground"
                          />
                        ) : (
                          <RemixIcon
                            name="mail"
                            size="size-4"
                            className="text-muted-foreground"
                          />
                        )}
                      </div>
                    )}

                    {/* Content area */}
                    <div className="flex-1 min-w-0 flex flex-col gap-1">
                      {/* Title row with platform badge */}
                      <div className="flex items-center gap-2 min-w-0">
                        {getPlatformName(insight.platform) !== "Unknown" && (
                          <span className="text-xs font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                            {getPlatformName(insight.platform)}
                          </span>
                        )}
                        {insight.categories &&
                          insight.categories.length > 0 && (
                            <span className="text-xs text-primary bg-primary/10 px-1.5 py-0.5 rounded truncate max-w-[80px]">
                              {insight.categories[0]}
                            </span>
                          )}
                      </div>

                      {/* Title */}
                      <p className="text-sm font-medium leading-tight line-clamp-2 text-foreground">
                        {insight.title}
                      </p>

                      {/* Summary */}
                      {insight.summary && (
                        <p className="text-xs text-muted-foreground line-clamp-1">
                          {insight.summary}
                        </p>
                      )}
                    </div>
                  </button>
                ))}
                {remainingCount > 0 && (
                  <p className="text-xs text-muted-foreground text-center py-2">
                    {t("insight.newCountDialog.more", "and {{count}} more...", {
                      count: remainingCount,
                    })}
                  </p>
                )}
              </div>
            )}

            {/* Clear button when there are insights */}
            {newInsightsCount > 0 && (
              <div className="border-t border-border p-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full text-xs text-muted-foreground"
                  onClick={clearNewInsights}
                >
                  {t("insight.newCountDialog.dismiss", "Clear")}
                </Button>
              </div>
            )}
          </>
        )}

        {/* Suggestions Tab */}
        {activeTab === "suggestions" && (
          <div className="py-2">
            {isLoadingSuggestions ? (
              <div className="flex flex-col items-center justify-center py-8 text-center text-sm text-muted-foreground">
                <RemixIcon name="loader_icon" size="size-6" className="animate-spin mb-2" />
                <p>Loading suggestions...</p>
              </div>
            ) : suggestionsError ? (
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
            ) : suggestions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center text-sm text-muted-foreground">
                <span className="text-2xl mb-2">💡</span>
                <p>No suggestions available</p>
              </div>
            ) : (
              <div className="space-y-2 px-3">
                {suggestions.map((suggestion) => (
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
                        {suggestion.platform && suggestion.platform !== "unknown" && (
                          <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                            {suggestion.platform}
                          </span>
                        )}
                        {suggestion.categories && suggestion.categories.length > 0 && suggestion.categories.slice(0, 2).map((cat) => (
                          <span key={cat} className="text-[10px] text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded">
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
        )}
      </div>
    </div>
  );
}
