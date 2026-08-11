import { AI_SETTINGS_CHANGED_EVENT } from "./conversation-api-configuration";

/** Notify listeners in this webview and the other Tauri webviews. */
export function notifyAiSettingsChanged(): void {
  if (typeof window === "undefined") return;

  window.dispatchEvent(new Event(AI_SETTINGS_CHANGED_EVENT));
  const tauriEvent = (
    window as unknown as {
      __TAURI__?: { event?: { emit?: (name: string) => unknown } };
    }
  ).__TAURI__;
  tauriEvent?.event?.emit?.(AI_SETTINGS_CHANGED_EVENT);
}
