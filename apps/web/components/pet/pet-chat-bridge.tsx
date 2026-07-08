"use client";

/**
 * Bridge between Tauri DOM events (dispatched by the Rust host on the
 * main webview) and the chat composer. The Rust
 * `pet:guide-connect-more` listener in main.rs evaluates JS in the
 * main webview that calls `window.__petChatBridgeSend(text)` directly.
 * We register that global function on mount and forward the text into
 * the chat composer via useChatContext().sendMessage(...).
 *
 * Why a global function (and not a CustomEvent + addEventListener):
 *   The previous CustomEvent approach was silent — the Rust eval
 *   reported Ok but the bridge's addEventListener handler never
 *   fired. Root cause was timing: in dev mode the eval can land
 *   before React has finished mounting the bridge component, and a
 *   dispatched event with no listener is simply lost (no replay).
 *   A global function survives that race because the eval can retry
 *   via setInterval until the bridge mounts and the function appears.
 *
 * Why this lives in the (chat) layout (and not in Home):
 *   LoopNavBridge is mounted at the layout level for the same reason —
 *   the event can fire while the user is on /chat, /connectors, /brief,
 *   etc. Mounting the bridge here keeps the wiring working from any
 *   (chat) route.
 */
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useChatContext } from "@/components/chat-context";

const TAG = "[PetChatBridge]";
const GLOBAL_KEY = "__petChatBridgeSend";

declare global {
  interface Window {
    [GLOBAL_KEY]?: (text: string) => void;
  }
}

export function PetChatBridge() {
  const router = useRouter();
  const { sendMessage, switchChatId } = useChatContext();
  // Refs so the global function (registered once on mount) always
  // sees the latest sendMessage / switchChatId without tearing down
  // and re-registering on every context update (isAgentRunning
  // flips on every agent turn).
  const sendRef = useRef(sendMessage);
  const switchRef = useRef(switchChatId);
  const routerRef = useRef(router);
  sendRef.current = sendMessage;
  switchRef.current = switchChatId;
  routerRef.current = router;

  useEffect(() => {
    console.log(`${TAG} mounted, registering window.${GLOBAL_KEY}`);
    window[GLOBAL_KEY] = (text: string) => {
      const trimmed = text?.trim();
      console.log(`${TAG} called, text length:`, trimmed?.length);
      if (!trimmed) return;
      // Always navigate to the chat page so the AgentChatPanel
      // composer is mounted. If the user is already on /?page=chat
      // the URL might be /?page=chat&chatId=<old> — we explicitly
      // strip the chatId so effectiveChatId falls back to the
      // localActiveChatId (which we then reset to a new UUID via
      // switchChatId(null)). Without stripping chatId the page
      // would keep showing the old chat while sendMessage writes
      // to the new one.
      console.log(`${TAG} navigating to /?page=chat`);
      routerRef.current.push("/?page=chat");
      // Start a fresh chat so the prompt doesn't get injected into
      // an unrelated in-flight conversation. Mirrors the pattern
      // used by AgentChatPanel's initialMessageToSend effect.
      console.log(`${TAG} switchChatId(null)`);
      void switchRef.current(null);
      // 1000ms delay so the chat switch propagates AND (if we
      // navigated) the new page mounts before we send. 350ms (the
      // delay AgentChatPanel uses for its own initial send) wasn't
      // enough in practice — the navigation + remount takes longer
      // and the send would race the mount.
      setTimeout(() => {
        console.log(`${TAG} firing sendMessage`);
        sendRef
          .current({ parts: [{ type: "text", text: trimmed }] })
          .then(() => console.log(`${TAG} sendMessage resolved`))
          .catch((err) => console.error(`${TAG} sendMessage rejected:`, err));
      }, 1000);
    };
    return () => {
      console.log(`${TAG} unmounting, removing window.${GLOBAL_KEY}`);
      delete window[GLOBAL_KEY];
    };
  }, []);
  return null;
}
