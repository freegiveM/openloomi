/**
 * App Providers component
 * Unified management of all Providers, reduces nesting depth
 * Uses lazy initialization to defer loading of non-critical Providers
 */

"use client";

import { Suspense, memo } from "react";
import { SessionProvider } from "next-auth/react";
import { MobileLayoutWrapper } from "@/components/mobile-layout-wrapper";
import { MobileBackButton } from "@/components/mobile-back-button";
import { TelegramSelfListenerInit } from "@/components/telegram-self-listener-init";
import { WhatsAppSelfListenerInit } from "@/components/whatsapp-self-listener-init";
import { IMessageSelfListenerInit } from "@/components/imessage-self-listener-init";
import { TokenSync } from "@/components/auth/token-sync";
import {
  FeishuListenerInit,
  DingTalkListenerInit,
  QQBotListenerInit,
  WeixinListenerInit,
} from "@/components/feishu-listener-init";
import { CloudSyncInit } from "@/components/cloud-sync-init";
import { RawMessagesMigrationInit } from "@/components/raw-messages-migration-init";
import { InsightRefreshInit } from "@/components/insight-refresh-init";
import { TelegramTokenFormProvider } from "@/components/platform-integrations";

// Lazy load initialization components - use Suspense boundaries to avoid blocking initial render
const IntegrationInitComponents = memo(() => (
  <Suspense fallback={null}>
    <TokenSync />
    <TelegramSelfListenerInit />
    <WhatsAppSelfListenerInit />
    <IMessageSelfListenerInit />
    <FeishuListenerInit />
    <DingTalkListenerInit />
    <QQBotListenerInit />
    <WeixinListenerInit />
    <CloudSyncInit />
    <RawMessagesMigrationInit />
    <InsightRefreshInit />
  </Suspense>
));

IntegrationInitComponents.displayName = "IntegrationInitComponents";

// Lazy load mobile components
const MobileComponents = memo(() => (
  <Suspense fallback={null}>
    <MobileBackButton />
  </Suspense>
));

MobileComponents.displayName = "MobileComponents";

/**
 * Complete app Provider tree
 */
export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      {/* Lazy load integration initialization components */}
      <IntegrationInitComponents />
      <TelegramTokenFormProvider>
          <MobileLayoutWrapper>
            {children}
            <MobileComponents />
          </MobileLayoutWrapper>
      </TelegramTokenFormProvider>
    </SessionProvider>
  );
}
