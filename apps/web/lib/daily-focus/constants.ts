/**
 * Daily Focus Constants
 *
 * Regex patterns, word sets, and configuration constants used across the daily-focus module.
 */

export const DAILY_FOCUS_TITLE_MAX_LENGTH = 32;
export const DAILY_FOCUS_ACTION_TITLE_MAX_LENGTH = 30;
export const TITLE_ELLIPSIS = "...";

export const MAX_DAILY_FOCUS_CANDIDATES_PER_INSIGHT = 3;
export const DAILY_FOCUS_OVERVIEW_MAX_LENGTH = 220;
export const MAX_CANDIDATE_SOURCE_DETAILS = 2;

export const URL_RE = /https?:\/\/[^\s<>"')\[\]]+/giu;
export const HTML_ANCHOR_RE =
  /<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu;
export const NOISE_LINK_RE =
  /unsubscribe|privacy|tracking|track|pixel|beacon|mail-online\.nosdn\.127\.net|maas\.mail\.163\.com|proSignature/i;

export const SOURCE_TYPES = new Set([
  "email",
  "wechat",
  "file",
  "slack",
  "telegram",
  "whatsapp",
  "feishu",
  "dingtalk",
  "notion",
  "web",
  "google-drive",
  "linear",
  "jira",
  "unknown",
]);

export const URGENT_WORDS = new Set([
  "urgent",
  "high",
  "immediate",
  "asap",
  "critical",
  "紧急",
  "高",
]);

export const IMPORTANT_WORDS = new Set([
  "important",
  "high",
  "关键",
  "重要",
  "高",
]);

export const RECENT_SIGNAL_WINDOW_DAYS = 3;
export const CANDIDATE_ADMISSION_THRESHOLD = 35;
export const CANDIDATE_WEAK_SIGNAL_THRESHOLD = 24;

export const ACTIONABLE_SIGNAL_PATTERN =
  /请(尽快)?(回复|确认|审批|审阅|查看|处理|完成|提交|反馈)|需要你|麻烦|烦请|能否|是否方便|下班前|今天|明天|本周|截止|到期|有效期|报价|合同|附件|报告|发票|账单|付款|支付|社保|回滚|决策|urgent|asap|action required|please (reply|confirm|review)|need your|can you|could you|deadline|due|expires?|payment|billing|invoice|quote|proposal|attachment|review/i;
export const WAITING_EXTERNAL_SIGNAL_PATTERN =
  /等待|待.*(确认|回复|审批|反馈|交付)|还没收到|催促|跟进|follow up|waiting for|pending reply|awaiting|no response/i;
export const INFO_VALUE_SIGNAL_PATTERN =
  /fyi|供参考|不需要回复|无需回复|newsletter|weekly digest|digest|竞品|行业|发布|上线|更新|cloud|ai/i;
export const NOISE_SIGNAL_PATTERN =
  /验证码|verification code|unsubscribe|退订|入职培训|邀请你的团队加入|delivery status notification|mail delivery subsystem|boost productivity|利用表情符号快速回复/i;
