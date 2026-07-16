"use client";

/**
 * Connector capability badge (#361) — surfaces the semantic state of an
 * integration in the connected-accounts UI so the user can tell
 * "Authorized" from "Loop monitored".
 *
 * The badge renders one of five states:
 *   - decision_capable → green, "Decision capable"
 *   - loop_monitored   → blue,  "Loop monitored"
 *   - needs_setup      → amber, "Needs setup" (chat-only integration)
 *   - unsupported      → muted, "Unsupported mapping"
 *   - (absent)         → the agent hasn't probed yet; render nothing so
 *                        we don't lie about monitoring coverage.
 *
 * The text is i18n-keyed so the connectors page stays locale-aware.
 * Reused by the PersonalizationLinkedAccounts list and the readiness
 * dashboard.
 */

import { useTranslation } from "react-i18next";
import { Badge } from "@openloomi/ui";

import type { ConnectorCapability } from "@/lib/loop/client";

export interface ConnectorCapabilityBadgeProps {
  capability?: ConnectorCapability;
  /**
   * When true, render in a compact pill (icon-only / shorter text) so
   * the badge fits inline next to a long platform label.
   */
  compact?: boolean;
}

const VARIANT: Record<
  ConnectorCapability,
  {
    classes: string;
    key:
      | "connectors.capabilityConnected"
      | "connectors.capabilityDecisionCapable"
      | "connectors.capabilityLoopMonitored"
      | "connectors.capabilityNeedsSetup"
      | "connectors.capabilityUnsupported";
  }
> = {
  // "connected" is the auth-only state (no Loop participation yet).
  // Currently unreachable from the connector list view (it's the
  // baseline before probing completes) but kept here for exhaustive
  // typing — callers may render this on the readiness surface.
  connected: {
    classes: "bg-slate-50 text-slate-700 border-slate-200",
    key: "connectors.capabilityConnected",
  },
  decision_capable: {
    classes: "bg-emerald-50 text-emerald-700 border-emerald-200",
    key: "connectors.capabilityDecisionCapable",
  },
  loop_monitored: {
    classes: "bg-sky-50 text-sky-700 border-sky-200",
    key: "connectors.capabilityLoopMonitored",
  },
  needs_setup: {
    classes: "bg-amber-50 text-amber-700 border-amber-200",
    key: "connectors.capabilityNeedsSetup",
  },
  unsupported: {
    classes: "bg-muted text-muted-foreground border-border",
    key: "connectors.capabilityUnsupported",
  },
};

export function ConnectorCapabilityBadge({
  capability,
  compact,
}: ConnectorCapabilityBadgeProps) {
  const { t } = useTranslation();
  if (!capability) return null;
  const v = VARIANT[capability];
  const label = t(v.key);
  return (
    <Badge
      className={v.classes}
      // `title` keeps the long form available on hover so a compact
      // pill never loses information.
      title={compact ? label : undefined}
    >
      {compact ? label.split(" ")[0] : label}
    </Badge>
  );
}
