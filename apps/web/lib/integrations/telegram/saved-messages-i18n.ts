/**
 * Telegram Saved Messages server-side multilingual copy
 * Return localized "Message received, executing…" notification based on Telegram user's langCode
 */

import zhHans from "@/i18n/locales/zh-Hans";
import enUS from "@/i18n/locales/en-US";
import { UserLocale } from "@melandlabs/shared";

type LocaleDict = {
  telegram?: { savedMessages?: { receivedAndExecuting?: string } };
};

const resources: Record<string, LocaleDict> = {
  "zh-Hans": zhHans as LocaleDict,
  "en-US": enUS as LocaleDict,
};

// Decoupled from UserLocale.default() on purpose: Telegram bot copy should
// stay English-by-default even if the product-wide UserLocale.default()
// later changes for other surfaces.
const DEFAULT_LOCALE = "en-US" as const;

/**
 * Map Telegram's lang_code (e.g., en, zh-hans) to the project locale code.
 * Unsupported codes fall back to this module's `DEFAULT_LOCALE` constant
 * (intentionally decoupled from {@link UserLocale.default} — see above).
 */
function normalizeLocale(langCode?: string | null): string {
  if (typeof langCode !== "string") return DEFAULT_LOCALE;
  const code = langCode.replace("_", "-");
  return UserLocale.fromString(code)?.code ?? DEFAULT_LOCALE;
}

/**
 * Get localized copy for "Message received, executing…" notification
 * @param telegramLangCode - Telegram User's lang_code (from getMe(), etc.)
 */
export function getReceivedAndExecutingMessage(
  telegramLangCode?: string | null,
): string {
  const locale = normalizeLocale(telegramLangCode);
  const msg =
    resources[locale]?.telegram?.savedMessages?.receivedAndExecuting ??
    resources[DEFAULT_LOCALE]?.telegram?.savedMessages?.receivedAndExecuting;
  return msg ?? "Message received, thinking…";
}
