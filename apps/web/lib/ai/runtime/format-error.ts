/**
 * Format Agent error codes into user-friendly messages.
 *
 * This module is intentionally kept free of server-only imports so it can
 * be safely consumed by client components (e.g. chat-context.tsx).
 */

/** Convert Agent internal error codes to user-readable messages (without exposing local log paths to IM) */
export function formatAgentStreamErrorForUser(
  platform:
    | "telegram"
    | "whatsapp"
    | "imessage"
    | "gmail"
    | "feishu"
    | "dingtalk"
    | "qqbot"
    | "weixin"
    | "chat"
    | "scheduler",
  raw: string,
  _language?: string | null,
): string {
  const zh = ["feishu", "dingtalk", "qqbot", "weixin"].includes(platform);

  if (raw === "__API_KEY_ERROR__" || raw.startsWith("__API_KEY_ERROR__")) {
    return zh
      ? "云端鉴权失败，请在应用内重新登录后再试。"
      : "Authentication failed. Please sign in again in the app.";
  }
  if (raw.startsWith("__INTERNAL_ERROR__")) {
    return zh
      ? "模型服务暂时异常，请稍后再试。"
      : "The assistant hit an internal error. Please try again later.";
  }
  if (raw.startsWith("__TIMEOUT_ERROR__")) {
    return zh
      ? "请求超时，请稍后再试。"
      : "Request timed out. Please try again.";
  }
  if (raw.startsWith("__PROCESS_CRASH__")) {
    return zh
      ? "模型进程异常退出，请缩短任务后重试。"
      : "The assistant process exited unexpectedly. Please try a smaller task.";
  }
  if (raw.startsWith("__CUSTOM_API_ERROR__")) {
    return zh
      ? "当前 API 配置可能不兼容，请检查 baseUrl 与模型。"
      : "API configuration may be incompatible. Check base URL and model.";
  }
  // Provider-timeout interruption: the agent reached its wall-clock deadline
  // while still making progress. The marker carries a JSON payload so the
  // error card can offer a real Continue action instead of the misleading
  // "system will automatically retry" wording. We surface a clean message
  // here and let `ErrorMessageDisplay` decode the structured payload via
  // `parseCodexInterruptedError`.
  if (raw.startsWith("__CODEX_INTERRUPTED__")) {
    return zh
      ? "任务执行超过时长限制已自动停止。已完成的工作会保留在工作目录中，可以从断点继续。"
      : "The task was stopped because it reached the provider's time limit. Completed work is preserved in the workspace — continue from where it left off.";
  }

  const authHint =
    raw.includes("无效的令牌") ||
    raw.includes("new_api_error") ||
    /Failed to authenticate/i.test(raw);
  if (authHint) {
    return zh
      ? "令牌无效或已过期，请重新登录后再试。"
      : "Your session token is invalid or expired. Please sign in again.";
  }

  return zh ? `出错了：${raw}` : `Error: ${raw}`;
}

/**
 * Check if the agent's answer indicates it could not provide a sufficient response.
 * Returns an error environment string if the answer appears to be a failure to answer,
 * or null if the answer seems valid.
 */
export function classifyAgentError(
  answer: string,
  _options?: { strict?: boolean },
): string | null {
  if (!answer || typeof answer !== "string") return null;

  // Check for common error patterns
  const errorPatterns = [
    /^(Error|错误):/i,
    /^抱歉|对不起|抱歉/i,
    /I (can'?t|could not|don'?t know|have?n?t sufficient)/i,
    /don'?t have enough (information|context)/i,
    /unable to (answer|provide|give)/i,
  ];

  for (const pattern of errorPatterns) {
    if (pattern.test(answer.trim())) {
      return "INSUFFICIENT_CONTEXT";
    }
  }

  return null;
}

/**
 * Format a "catch-all" error message when an unexpected error occurs during agent processing.
 */
export function formatCatchAllErrorForUser(
  platform:
    | "telegram"
    | "whatsapp"
    | "imessage"
    | "gmail"
    | "feishu"
    | "dingtalk"
    | "qqbot"
    | "weixin",
  error: unknown,
  _language?: string | null,
): string {
  const zh = ["feishu", "dingtalk", "qqbot", "weixin"].includes(platform);
  const errorMessage = error instanceof Error ? error.message : String(error);

  if (zh) {
    return `处理消息时发生错误：${errorMessage}。请稍后再试。`;
  }
  return `An error occurred: ${errorMessage}. Please try again later.`;
}

/**
 * Format a message when the agent could not provide a sufficient answer.
 */
export function formatInsufficientAnswerForUser(
  platform:
    | "telegram"
    | "whatsapp"
    | "imessage"
    | "gmail"
    | "feishu"
    | "dingtalk"
    | "qqbot"
    | "weixin",
  _language?: string | null,
): string {
  const zh = ["feishu", "dingtalk", "qqbot", "weixin"].includes(platform);

  if (zh) {
    return "抱歉，我无法根据当前上下文提供满意的回答。请提供更多信息或换一种方式提问。";
  }
  return "Sorry, I couldn't provide a satisfactory answer based on the current context. Please provide more information or try a different approach.";
}
