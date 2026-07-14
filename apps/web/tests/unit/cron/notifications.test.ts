import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the preferences read so we control `cronCompletionPetNotify`
// without touching the user's real ~/.openloomi/loop/config.json.
const readPreferences = vi.fn();
vi.mock("@/lib/loop/preferences", () => ({
  readPreferences: () => readPreferences(),
}));

const { notifyCronCompletion } = await import("@/lib/cron/notifications");

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal("fetch", fetchMock);
  // Default prefs: opt-out.
  readPreferences.mockReturnValue({ cronCompletionPetNotify: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastFetchBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls[0];
  const init = call?.[1] as { body?: string } | undefined;
  return JSON.parse(init?.body ?? "{}");
}

describe("notifyCronCompletion", () => {
  it("skips when cronCompletionPetNotify is false (default)", async () => {
    const r = await notifyCronCompletion("water reminder", "success");
    expect(r.skippedOptOut).toBe(true);
    expect(r.sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts happy + monologue on success when opted in", async () => {
    readPreferences.mockReturnValue({ cronCompletionPetNotify: true });
    const r = await notifyCronCompletion("water reminder", "success");
    expect(r.sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = lastFetchBody();
    expect(body.state).toBe("happy");
    expect(body.source).toBe("openloomi-cli");
    expect(body.monologue).toBe('Cron "water reminder" completed');
  });

  it("posts needsinput + monologue on error when opted in", async () => {
    readPreferences.mockReturnValue({ cronCompletionPetNotify: true });
    const r = await notifyCronCompletion("nightly sync", "error", "boom");
    expect(r.sent).toBe(true);
    const body = lastFetchBody();
    expect(body.state).toBe("needsinput");
    expect(body.monologue).toBe('Cron "nightly sync" failed — boom');
  });

  it.each(["loop.tick", "loop.brief", "loop.wrap", "loop.action"])(
    "skips Loop's own handler %s regardless of pref",
    async (handler) => {
      readPreferences.mockReturnValue({ cronCompletionPetNotify: true });
      const r = await notifyCronCompletion(
        "loop job",
        "success",
        undefined,
        handler,
      );
      expect(r.skippedLoopJob).toBe(true);
      expect(r.sent).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
