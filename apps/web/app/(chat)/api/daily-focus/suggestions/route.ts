import { auth } from "@/app/(auth)/auth";
import { AppError } from "@openloomi/shared/errors";
import { generateText } from "ai";
import { getModelProvider } from "@/lib/ai";
import { setAIUserContextFromRequest } from "@/lib/ai/request-context";
import { z } from "zod";
import {
  getBotsByUserId,
  getUserRoles,
  getLatestSurveyByUserId,
  getUserInsightSettings,
  getStoredInsightsByBotIds,
} from "@/lib/db/queries";
import {
  executeDailyFocusAnalysis,
  DAILY_FOCUS_SYSTEM_PROMPT,
  type DailyFocusInsightInput,
} from "@/lib/daily-focus";
import { isTauriMode } from "@/lib/env";

/**
 * Response structure for Daily Focus suggestions
 */
const DailyFocusSuggestionSchema = z.object({
  id: z.string(),
  title: z.string(),
  emoji: z.string(),
  type: z.enum([
    "urgent",
    "high_priority",
    "potential",
    "event_based",
    "pattern_based",
    "role_based",
  ]),
  priority: z.enum(["urgent", "high_priority", "potential"]).optional(),
  insightId: z.string().optional(),
  reasoning: z.string(),
  // Extended context fields
  platform: z.string().optional(),
  summary: z.string().optional(),
  people: z.array(z.string()).optional(),
  time: z.string().optional(),
  sourceLabel: z.string().optional(),
  // Category tags like RSVP, Meetings, Contacts, etc.
  categories: z.array(z.string()).optional(),
  related_insight_ids: z.array(z.string()),
});

const DailyFocusSuggestionsResponseSchema = z
  .object({
    suggested_prompts: z.array(DailyFocusSuggestionSchema).optional(),
    suggestions: z.array(DailyFocusSuggestionSchema).optional(),
    summary: z.string().optional(),
  })
  .transform((data) => ({
    suggested_prompts: data.suggested_prompts || data.suggestions || [],
    summary: data.summary,
  }));

/**
 * GET /api/daily-focus/suggestions
 * Generate Daily Focus suggestions based on recent insights
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return new AppError("unauthorized:insight").toResponse();
  }

  try {
    // Set AI user context for proper billing in proxy mode
    await setAIUserContextFromRequest({
      userId: session.user.id,
      email: session.user.email || "",
      name: session.user.name || null,
      userType: session.user.type,
      request,
    });

    const userId = session.user.id;
    const currentDate = new Date().toISOString().split("T")[0];

    // 1. Get user role information
    const roles = await getUserRoles(userId);
    const userRoles = roles.map((role) => ({
      role: role.roleKey,
      source: role.source,
      confidence: role.confidence,
    }));

    // 2. Get user identity information
    const latestSurvey = await getLatestSurveyByUserId(userId);
    const industries = latestSurvey?.industry
      ? latestSurvey.industry
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : [];
    const workDescription = latestSurvey?.workDescription ?? null;

    // 3. Get user focus topics and language settings
    const settings = await getUserInsightSettings(userId);
    const focusTopics = settings?.focusTopics ?? [];
    const userLanguage = settings?.language || "zh-Hans";

    // 4. Get insights from the past 24 hours
    const bots = await getBotsByUserId({
      id: userId,
      limit: null,
      startingAfter: null,
      endingBefore: null,
      onlyEnable: false,
    });

    if (bots.bots.length === 0) {
      return Response.json({
        suggested_prompts: [],
        summary: "No data",
      });
    }

    const botIds = bots.bots.map((bot) => bot.id);
    const { insights } = await getStoredInsightsByBotIds({
      ids: botIds,
      days: 1,
    });

    // 5. Convert insights to Daily Focus input format
    const insightInputs: DailyFocusInsightInput[] = insights.map((insight) => ({
      id: insight.id,
      title: insight.title,
      description: insight.description || null,
      importance: insight.importance,
      urgency: insight.urgency,
      platform: insight.platform ?? null,
      groups: insight.groups ?? null,
      people: insight.people ?? null,
      sources: insight.sources ?? null,
      details: insight.details ?? null,
      timeline: insight.timeline ?? null,
      dueDate: insight.dueDate ?? null,
      waitingForMe: insight.waitingForMe ?? null,
      waitingForOthers: insight.waitingForOthers ?? null,
      nextActions: insight.nextActions ?? null,
      actionRequired: insight.actionRequired ?? null,
      categories: insight.categories ?? null,
      time:
        insight.time instanceof Date
          ? insight.time.toISOString()
          : insight.time,
      isArchived: insight.isArchived ?? null,
    }));

    // 6. Run Daily Focus analysis
    const { snapshot, candidates } = executeDailyFocusAnalysis(insightInputs);

    // 7. Generate suggestions from the snapshot
    const isChinese =
      userLanguage.includes("zh") ||
      userLanguage === "zh-Hans" ||
      userLanguage === "zh-CN";

    // Build user prompt for generating suggestions
    const userPrompt = isChinese
      ? `Based on the Daily Focus analysis results, generate 3 personalized action suggestions from the USER's perspective.

分析结果摘要: ${snapshot.summary}
事件总数: ${snapshot.totalCount}

重要事件（包含完整信息）:
${snapshot.events
  .slice(0, 5)
  .map(
    (event, idx) => `
${idx + 1}. [${event.priority}] ${event.summary}
   - 详情: ${event.overview || "无"}
   - 来源: ${event.sources.map((s) => s.label).join(", ") || "未知"}
   - 相关人: ${
     event.sources
       .flatMap((s) => s.label)
       .slice(0, 3)
       .join(", ") || "无"
   }
   - 时间: ${event.sources[0]?.type || "未知"}`,
  )
  .join("\n")}

用户角色: ${userRoles.map((r) => r.role).join(", ") || "未设置"}
行业: ${industries.join(", ") || "未设置"}
关注话题: ${focusTopics.join(", ") || "未设置"}
当前日期: ${currentDate}

## 核心要求

**标题（title）必须满足：**
- 从用户第一人称视角出发，如"我应该..."、"回复..."、"确认..."、"处理..."
- 直接可发送到对话中执行的动作或问题
- 长度控制在15个字符以内
- 避免抽象描述，要具体可操作

**示例（好的标题）：**
- "回复确认参加会议"
- "催促项目进度"
- "查看财报要点"

**示例（不好的标题）：**
- "会议邀请收到"（被动描述）
- "团队动态更新"（不知道要做什么）
- "John发来的邮件"（缺少行动）

**摘要（summary）要提供足够上下文：**
- 告诉用户这个建议是关于什么的
- 包含关键人物、事件、截止时间等信息
- 让用户一看就明白为什么需要关注

返回JSON格式，使用字段名 "suggested_prompts"（不是"suggestions"）:
{
  "suggested_prompts": [
    {
      "id": "suggest_001",
      "title": "用户视角的可执行动作（≤15字符）",
      "emoji": "💡",
      "type": "event_based",
      "priority": "urgent/high_priority/potential",
      "insightId": "相关insight_id",
      "summary": "补充上下文信息，帮助用户理解这个建议的背景（≤50字符）",
      "platform": "来源平台如 Gmail/Slack",
      "time": "时间描述如 2小时前/昨天",
      "categories": ["RSVP", "Meetings", "Contacts", "Marketing", "Actions", "Facts", "Patterns", "Knowledge", "Observation"],
      "reasoning": "为什么生成这个建议",
      "related_insight_ids": ["insight_id"]
    }
  ]
}`
      : `Based on the Daily Focus analysis results, generate 3 personalized action suggestions from the USER's perspective.

Summary: ${snapshot.summary}
Total Events: ${snapshot.totalCount}

Top Events (with full details):
${snapshot.events
  .slice(0, 5)
  .map(
    (event, idx) => `
${idx + 1}. [${event.priority}] ${event.summary}
   - Details: ${event.overview || "None"}
   - Source: ${event.sources.map((s) => s.label).join(", ") || "Unknown"}
   - Time: ${event.sources[0]?.type || "Unknown"}`,
  )
  .join("\n")}

User Roles: ${userRoles.map((r) => r.role).join(", ") || "Not set"}
Industries: ${industries.join(", ") || "Not set"}
Focus Topics: ${focusTopics.join(", ") || "Not set"}
Current Date: ${currentDate}

## Core Requirements

**Title (title) MUST be:**
- From user's first-person perspective: "I should...", "Reply to...", "Confirm...", "Handle..."
- Direct actions that can be sent to chat and executed
- Max 15 characters
- Avoid abstract descriptions - be specific and actionable

**Good title examples:**
- "Reply confirm meeting"
- "Follow up project"
- "Check report highlights"

**Bad title examples:**
- "Meeting invitation received" (passive)
- "Team update" (unclear action)
- "Email from John" (lacks action)

**Summary should provide enough context:**
- Tell user what this suggestion is about
- Include key people, events, deadlines
- Help user understand why they need to act

Return JSON format with field "suggested_prompts" (NOT "suggestions"):
{
  "suggested_prompts": [
    {
      "id": "suggest_001",
      "title": "Action from user perspective (≤15 chars)",
      "emoji": "💡",
      "type": "event_based",
      "priority": "urgent/high_priority/potential",
      "insightId": "related_insight_id",
      "summary": "Context to help user understand this suggestion (≤50 chars)",
      "platform": "Source platform like Gmail/Slack",
      "time": "Time description like 2h ago/yesterday",
      "categories": ["RSVP", "Meetings", "Contacts", "Marketing", "Actions", "Facts", "Patterns", "Knowledge", "Observation"],
      "reasoning": "Why this suggestion was generated",
      "related_insight_ids": ["insight_id"]
    }
  ]
}`;

    // 8. Call LLM to generate suggestions
    const modelProvider = getModelProvider(isTauriMode());
    const result = await generateText({
      model: modelProvider.languageModel("chat-model"),
      system: DAILY_FOCUS_SYSTEM_PROMPT,
      prompt: userPrompt,
      temperature: 0.7,
      maxRetries: 3,
    });

    // 9. Parse response
    let responseText = result.text.trim();
    responseText = responseText.replace(/^```json\s*/i, "");
    responseText = responseText.replace(/^```\s*/i, "");
    responseText = responseText.replace(/\s*```$/i, "");

    let parsedResponse: z.infer<typeof DailyFocusSuggestionsResponseSchema>;
    try {
      const jsonData = JSON.parse(responseText);
      parsedResponse = DailyFocusSuggestionsResponseSchema.parse(jsonData);
    } catch (error) {
      console.error(
        "[Daily Focus Suggestions] Failed to parse LLM response:",
        error,
        "Response:",
        responseText,
      );
      // Fallback suggestions based on analysis
      const fallbackSuggestions = generateFallbackSuggestions(
        snapshot,
        isChinese,
      );
      return Response.json({
        suggested_prompts: fallbackSuggestions,
        summary: snapshot.summary,
      });
    }

    return Response.json({
      ...parsedResponse,
      summary: snapshot.summary,
    });
  } catch (error) {
    console.error(
      "[Daily Focus Suggestions] Failed to generate suggestions:",
      error,
    );
    if (error instanceof AppError) {
      return error.toResponse();
    }
    return new AppError(
      "bad_request:insight",
      `Failed to generate suggestions: ${error instanceof Error ? error.message : String(error)}`,
    ).toResponse();
  }
}

/**
 * Generate fallback suggestions based on Daily Focus snapshot
 */
function generateFallbackSuggestions(
  snapshot: {
    events: Array<{
      id: string;
      priority: string;
      summary: string;
      overview?: string;
      insightId?: string;
      sources?: Array<{ type: string; label: string }>;
      categories?: string[];
    }>;
  },
  isChinese: boolean,
): z.infer<typeof DailyFocusSuggestionSchema>[] {
  const suggestions: z.infer<typeof DailyFocusSuggestionSchema>[] = [];

  // Get urgent and high priority events
  const urgentEvents = snapshot.events.filter((e) => e.priority === "urgent");
  const highPriorityEvents = snapshot.events.filter(
    (e) => e.priority === "high_priority",
  );
  const otherEvents = snapshot.events.filter((e) => e.priority === "potential");

  const priorityEvents = [
    ...urgentEvents,
    ...highPriorityEvents,
    ...otherEvents,
  ].slice(0, 3);

  for (let i = 0; i < priorityEvents.length; i++) {
    const event = priorityEvents[i];
    const emoji =
      event.priority === "urgent"
        ? "🚨"
        : event.priority === "high_priority"
          ? "💡"
          : "📌";
    const platform = event.sources?.[0]?.type || "unknown";
    const sourceLabel = event.sources?.[0]?.label || "未知来源";
    const categories = event.categories || [];

    // Check if this is an informational/newsletter type event
    const isInformational =
      categories.includes("Marketing") ||
      categories.includes("Updates") ||
      categories.includes("News") ||
      event.summary.toLowerCase().includes("email") ||
      event.summary.toLowerCase().includes("newsletter") ||
      event.summary.toLowerCase().includes("digest");

    // Generate actionable title based on event type
    let actionableTitle: string;
    if (isInformational) {
      // For newsletters/informational, suggest cleanup or review
      actionableTitle = isChinese ? "查看或标记已读" : "Review or mark as read";
    } else if (event.priority === "urgent") {
      // For urgent events, suggest immediate action
      actionableTitle = isChinese ? "处理紧急事项" : "Handle urgent matter";
    } else if (event.priority === "high_priority") {
      // For high priority, suggest follow up
      actionableTitle = isChinese ? "跟进重要事项" : "Follow up on priority";
    } else {
      // For potential, suggest checking
      actionableTitle = isChinese ? "查看详情" : "Check details";
    }

    if (isChinese) {
      suggestions.push({
        id: `suggest_${String(i + 1).padStart(3, "0")}`,
        title: actionableTitle,
        emoji,
        type: event.priority as "urgent" | "high_priority" | "potential",
        priority: event.priority as "urgent" | "high_priority" | "potential",
        insightId: event.insightId,
        summary: event.overview?.slice(0, 50) || event.summary.slice(0, 50),
        platform,
        sourceLabel,
        categories,
        reasoning: `从${event.priority === "urgent" ? "紧急" : event.priority === "high_priority" ? "重要" : "一般"}事件生成`,
        related_insight_ids: event.insightId ? [event.insightId] : [],
      });
    } else {
      suggestions.push({
        id: `suggest_${String(i + 1).padStart(3, "0")}`,
        title: actionableTitle,
        emoji,
        type: event.priority as "urgent" | "high_priority" | "potential",
        priority: event.priority as "urgent" | "high_priority" | "potential",
        insightId: event.insightId,
        summary: event.overview?.slice(0, 50) || event.summary.slice(0, 50),
        platform,
        sourceLabel,
        categories,
        reasoning: `Generated from ${event.priority} event`,
        related_insight_ids: event.insightId ? [event.insightId] : [],
      });
    }
  }

  // If no events, provide default suggestions
  if (suggestions.length === 0) {
    if (isChinese) {
      suggestions.push(
        {
          id: "suggest_001",
          title: "今日有什么重要消息？",
          emoji: "📬",
          type: "role_based",
          reasoning: "默认建议：通用探索问题",
          related_insight_ids: [],
        },
        {
          id: "suggest_002",
          title: "团队讨论的主要话题是什么？",
          emoji: "💬",
          type: "role_based",
          reasoning: "默认建议：团队动态",
          related_insight_ids: [],
        },
        {
          id: "suggest_003",
          title: "有什么潜在机会？",
          emoji: "💰",
          type: "role_based",
          reasoning: "默认建议：业务增长",
          related_insight_ids: [],
        },
      );
    } else {
      suggestions.push(
        {
          id: "suggest_001",
          title: "What important messages today?",
          emoji: "📬",
          type: "role_based",
          reasoning: "Default: general exploration",
          related_insight_ids: [],
        },
        {
          id: "suggest_002",
          title: "Main team topics today?",
          emoji: "💬",
          type: "role_based",
          reasoning: "Default: team dynamics",
          related_insight_ids: [],
        },
        {
          id: "suggest_003",
          title: "Any potential opportunities?",
          emoji: "💰",
          type: "role_based",
          reasoning: "Default: business growth",
          related_insight_ids: [],
        },
      );
    }
  }

  return suggestions;
}
