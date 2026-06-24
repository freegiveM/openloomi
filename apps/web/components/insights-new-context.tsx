"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import type { InsightNewItem } from "./insights-new-count-dialog";

interface NewInsightsContextValue {
  newInsights: InsightNewItem[];
  newInsightsCount: number;
  setNewInsights: (insights: InsightNewItem[], count: number) => void;
  clearNewInsights: () => void;
}

const NewInsightsContext = createContext<NewInsightsContextValue | null>(null);

export function NewInsightsProvider({ children }: { children: ReactNode }) {
  const [newInsights, setNewInsightsState] = useState<InsightNewItem[]>([]);
  const [newInsightsCount, setNewInsightsCount] = useState(0);

  const setNewInsights = useCallback((insights: InsightNewItem[], count: number) => {
    setNewInsightsState(insights);
    setNewInsightsCount(count);
  }, []);

  const clearNewInsights = useCallback(() => {
    setNewInsightsState([]);
    setNewInsightsCount(0);
  }, []);

  return (
    <NewInsightsContext.Provider
      value={{
        newInsights,
        newInsightsCount,
        setNewInsights,
        clearNewInsights,
      }}
    >
      {children}
    </NewInsightsContext.Provider>
  );
}

export function useNewInsightsContext() {
  const context = useContext(NewInsightsContext);
  // Return default values if used outside provider (e.g., during static generation)
  if (!context) {
    return {
      newInsights: [],
      newInsightsCount: 0,
      setNewInsights: () => {},
      clearNewInsights: () => {},
    };
  }
  return context;
}
