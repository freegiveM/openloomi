/**
 * #360 — `probeConnectorState` must parse the agent's per-account
 * `accounts` array into the connector snapshot so a multi-account toolkit
 * (e.g. two Google Calendar accounts) is transparent to the UI, and so a
 * failed account is flagged rather than dropped. These tests also pin the
 * non-secret contract: token-like fields the agent might accidentally
 * include must never survive into the persisted snapshot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorEntry } from "@/lib/loop/types";

const invokeAgentPrompt = vi.fn();
const writeConnectorSnapshot = vi.fn();

vi.mock("@/lib/loop/runner", () => ({
  invokeAgentPrompt: (...args: unknown[]) => invokeAgentPrompt(...args),
}));
vi.mock("@/lib/loop/connectors", () => ({
  writeConnectorSnapshot: (...args: unknown[]) =>
    writeConnectorSnapshot(...args),
}));
vi.mock("@/lib/loop/store", () => ({ log: () => {} }));

const { probeConnectorState } = await import("@/lib/loop/composio-bridge");

function agentResult(connectors: unknown) {
  return { ok: true, result: { connectors } };
}

beforeEach(() => {
  invokeAgentPrompt.mockReset();
  writeConnectorSnapshot.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("probeConnectorState multi-account parsing (#360)", () => {
  it("parses two active Google Calendar accounts into the snapshot", async () => {
    invokeAgentPrompt.mockResolvedValue(
      agentResult([
        {
          id: "google_calendar",
          label: "Google Calendar",
          connected: true,
          accountCount: 2,
          accounts: [
            { id: "ca_work", label: "work@corp.com", healthy: true },
            { id: "ca_personal", label: "me@gmail.com", healthy: true },
          ],
        },
      ]),
    );

    const entries = await probeConnectorState({
      toolkits: [{ id: "google_calendar", label: "Google Calendar" }],
    });

    const cal = entries?.find((e) => e.id === "google_calendar");
    expect(cal?.connected).toBe(true);
    expect(cal?.accountCount).toBe(2);
    expect(cal?.accounts?.map((a) => a.id)).toEqual(["ca_work", "ca_personal"]);
    expect(cal?.accounts?.map((a) => a.label)).toEqual([
      "work@corp.com",
      "me@gmail.com",
    ]);
  });

  it("keeps healthy accounts while flagging a failed one (partial failure)", async () => {
    invokeAgentPrompt.mockResolvedValue(
      agentResult([
        {
          id: "google_calendar",
          label: "Google Calendar",
          connected: true,
          accountCount: 2,
          accounts: [
            { id: "ca_work", label: "work@corp.com", healthy: true },
            {
              id: "ca_personal",
              label: "me@gmail.com",
              healthy: false,
              lastError: "token expired",
            },
          ],
        },
      ]),
    );

    const entries = await probeConnectorState({
      toolkits: [{ id: "google_calendar", label: "Google Calendar" }],
    });

    const cal = entries?.find((e) => e.id === "google_calendar");
    // The failed account is not discarded — it is retained + flagged.
    expect(cal?.accounts).toHaveLength(2);
    const failed = cal?.accounts?.find((a) => a.id === "ca_personal");
    expect(failed?.healthy).toBe(false);
    expect(failed?.lastError).toBe("token expired");
  });

  it("reconciles accountCount to accounts.length when the agent miscounts", async () => {
    invokeAgentPrompt.mockResolvedValue(
      agentResult([
        {
          id: "gmail",
          label: "Gmail",
          connected: true,
          // Agent wrongly reports 1 while listing two accounts.
          accountCount: 1,
          accounts: [
            { id: "ga_a", label: "a@x.com" },
            { id: "ga_b", label: "b@x.com" },
          ],
        },
      ]),
    );

    const entries = await probeConnectorState({
      toolkits: [{ id: "gmail", label: "Gmail" }],
    });

    const gmail = entries?.find((e) => e.id === "gmail");
    expect(gmail?.accountCount).toBe(2);
  });

  it("never lets token-like fields leak into the persisted account shape", async () => {
    invokeAgentPrompt.mockResolvedValue(
      agentResult([
        {
          id: "slack",
          label: "Slack",
          connected: true,
          accountCount: 1,
          accounts: [
            {
              id: "sl_1",
              label: "team",
              // The agent should never send these, but if it does they
              // must be stripped by the whitelist parser.
              access_token: "xoxb-super-secret",
              refresh_token: "refresh-secret",
            },
          ],
        },
      ]),
    );

    const entries = await probeConnectorState({
      toolkits: [{ id: "slack", label: "Slack" }],
    });

    const slack = entries?.find((e) => e.id === "slack");
    const account = slack?.accounts?.[0];
    expect(account?.id).toBe("sl_1");
    expect(JSON.stringify(account)).not.toContain("secret");
    expect(account).not.toHaveProperty("access_token");
    expect(account).not.toHaveProperty("refresh_token");
  });

  it("degrades to the scalar count when no accounts array is present", async () => {
    invokeAgentPrompt.mockResolvedValue(
      agentResult([
        {
          id: "github",
          label: "GitHub",
          connected: true,
          accountCount: 1,
        },
      ]),
    );

    const entries = await probeConnectorState({
      toolkits: [{ id: "github", label: "GitHub" }],
    });

    const gh = entries?.find((e) => e.id === "github");
    expect(gh?.accountCount).toBe(1);
    expect(gh?.accounts).toBeUndefined();
  });

  it("persists the snapshot with the enumerated accounts", async () => {
    invokeAgentPrompt.mockResolvedValue(
      agentResult([
        {
          id: "google_calendar",
          label: "Google Calendar",
          connected: true,
          accountCount: 2,
          accounts: [{ id: "ca_1" }, { id: "ca_2" }],
        },
      ]),
    );

    await probeConnectorState({
      toolkits: [{ id: "google_calendar", label: "Google Calendar" }],
    });

    expect(writeConnectorSnapshot).toHaveBeenCalledTimes(1);
    const persisted = writeConnectorSnapshot.mock
      .calls[0][0] as ConnectorEntry[];
    const cal = persisted.find((e) => e.id === "google_calendar");
    expect(cal?.accounts).toHaveLength(2);
  });
});
