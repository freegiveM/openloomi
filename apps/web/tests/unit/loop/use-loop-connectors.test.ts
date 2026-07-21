/**
 * #412 — the previous `useLoopConnectors` hook collapsed the server's
 * structured `lastProbeError: { kind, message, at }` into a plain string,
 * silently dropping `kind` (and `at`). The per-kind callout on
 * `/connectors` needs the full shape to render the right affordance
 * (install / sign-in / retry / tooltip). These tests pin the contract
 * that `kind` is preserved end-to-end.
 *
 * The hook itself isn't exported, so we mock `useSWR` and assert on the
 * fetcher the hook passes to it. That fetcher is the single boundary
 * between the wire payload and the React tree — if it drops `kind`, the
 * UI can never get it back.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

// Mock `swr` *before* importing the SUT so the hook grabs our stub.
// We only care about the (key, fetcher) tuple the hook hands to useSWR.
// The SUT uses `import useSWR from "swr"`, and SWR exports
// `useSWR as default` — so the mock's `default` export IS the
// useSWR function we want to capture. The named `useSWR` export
// is also exposed so consumers using either style see the same stub.
// The mock returns an SWR-shaped object so the hook's destructure
// (`{ data, error, isLoading, isValidating, mutate }`) doesn't blow up.
const useSWRMock: Mock = vi.fn(() => ({
  data: undefined,
  error: undefined,
  isLoading: false,
  isValidating: false,
  mutate: vi.fn(),
}));
vi.mock("swr", () => {
  const stub = (...args: unknown[]) => useSWRMock(...args);
  return {
    default: stub,
    useSWR: stub,
  };
});

// Token manager is a no-op in node — replace with a stub that yields
// nothing so the hook's `typeof window !== "undefined"` guard is the
// only thing shaping the headers it builds.
vi.mock("@/lib/auth/token-manager", () => ({
  getAuthToken: () => undefined,
}));

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Re-import the SUT so its module body re-runs and re-registers a
 * fresh fetcher against the cleared `useSWRMock`. Returns the
 * fetcher the hook handed to `useSWR` so a test can drive it with
 * any synthetic server payload.
 */
async function loadFetcher(): Promise<(url: string) => Promise<unknown>> {
  useSWRMock.mockClear();
  vi.resetModules();
  const { useLoopConnectors } = await import("@/hooks/use-loop-connectors");
  useLoopConnectors();
  const calls = useSWRMock.mock.calls as unknown[][];
  const fetcher = calls[0]?.[1] as
    | ((url: string) => Promise<unknown>)
    | undefined;
  if (!fetcher) {
    throw new Error("useSWR was not called with a fetcher");
  }
  return fetcher;
}

function stubFetch(payload: unknown): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("useLoopConnectors lastProbeError (#412)", () => {
  it("preserves the structured {kind, message, at} shape — does not collapse to a string", async () => {
    // Reproduce the previous bug: a server payload with all three
    // fields must reach the fetcher's caller as `ProbeErrorInfo`, not
    // `string`. The kind is the load-bearing field for the per-kind
    // callout.
    const fetcher = await loadFetcher();
    const stub = stubFetch({
      items: [],
      lastProbeError: {
        kind: "cli_not_found",
        message: "composio: command not found",
        at: "2026-07-21T12:34:56.000Z",
      },
    });

    const result = (await fetcher("/api/loop/connectors")) as {
      lastProbeError: unknown;
    };
    expect(result.lastProbeError).toEqual({
      kind: "cli_not_found",
      message: "composio: command not found",
      at: "2026-07-21T12:34:56.000Z",
    });
    expect(typeof result.lastProbeError).not.toBe("string");

    stub.mockRestore();
  });

  it("drops the diagnostic when any required field is missing (malformed server payload)", async () => {
    const fetcher = await loadFetcher();
    const stub = stubFetch({
      items: [],
      // Missing `at` — server sent a partial blob.
      lastProbeError: {
        kind: "timeout",
        message: "probe exceeded 600000ms",
      },
    });

    const result = (await fetcher("/api/loop/connectors")) as {
      lastProbeError: unknown;
    };
    expect(result.lastProbeError).toBeNull();

    stub.mockRestore();
  });

  it("rejects unknown kinds rather than passing them through as a structural ProbeErrorKind", async () => {
    const fetcher = await loadFetcher();
    const stub = stubFetch({
      items: [],
      lastProbeError: {
        kind: "totally_made_up",
        message: "x",
        at: "2026-07-21T12:34:56.000Z",
      },
    });

    const result = (await fetcher("/api/loop/connectors")) as {
      lastProbeError: unknown;
    };
    expect(result.lastProbeError).toBeNull();

    stub.mockRestore();
  });

  it("returns lastProbeError=null on the happy path (no error blob in the payload)", async () => {
    const fetcher = await loadFetcher();
    const stub = stubFetch({ items: [] });

    const result = (await fetcher("/api/loop/connectors")) as {
      lastProbeError: unknown;
    };
    expect(result.lastProbeError).toBeNull();

    stub.mockRestore();
  });
});
