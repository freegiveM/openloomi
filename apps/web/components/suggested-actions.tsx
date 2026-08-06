"use client";

/**
 * Data structure for suggested conversation prompts.
 */
export interface SuggestedPrompt {
  id: string;
  title: string;
  emoji: string;
  type: "event_based" | "pattern_based" | "role_based";
  reasoning: string;
}

/**
 * Get all default suggested options.
 */
export function getAllDefaultSuggestions(
  t: (key: string) => string,
): SuggestedPrompt[] {
  return [
    {
      id: "presentation",
      title: t("common.suggestedCards.presentation.title"),
      emoji: "📊",
      type: "role_based" as const,
      reasoning: "Create presentation",
    },
    {
      id: "frontendDesign",
      title: t("common.suggestedCards.frontendDesign.title"),
      emoji: "🖥️",
      type: "role_based" as const,
      reasoning: "Frontend design for openloomi website introduction page",
    },
    {
      id: "linkedinPost",
      title: t("common.suggestedCards.linkedinPost.title"),
      emoji: "📈",
      type: "role_based" as const,
      reasoning: "Event tracking creation",
    },
    {
      id: "productCopy",
      title: t("common.suggestedCards.productCopy.title"),
      emoji: "✍️",
      type: "role_based" as const,
      reasoning: "Product copy optimization",
    },
    {
      id: "algorithmicArt",
      title: t("common.suggestedCards.algorithmicArt.title"),
      emoji: "🎨",
      type: "role_based" as const,
      reasoning: "Algorithmic art creation",
    },
    {
      id: "aiNews",
      title: t("common.suggestedCards.aiNews.title"),
      emoji: "📰",
      type: "role_based" as const,
      reasoning: "AI industry news research",
    },
  ];
}
