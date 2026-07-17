/**
 * #378 — deterministic GitHub notification aggregator regression tests.
 *
 * Pins:
 *   - canonical-key derivation prefers `id`, falls back to repo+number, url,
 *     repo+title;
 *   - cross-source dedupe collapses two `github` / `github_notifications`
 *     records of the same thread to one item;
 *   - URL normalization strips api.github.com subjects to canonical web URLs
 *     and rejects non-HTTPS / non-github.com URLs;
 *   - aggregator excludes keys already covered by a non-unknown typed
 *     decision or a prior pending digest;
 *   - aggregator merges new items into an existing pending digest instead
 *     of creating a second summary card;
 *   - bounded digest caps at MAX_DIGEST_ITEMS items;
 *   - `unknown` decisions are NEVER treated as having already summarized
 *     notifications (otherwise they'd suppress the digest they couldn't
 *     cover).
 */
import { describe, expect, it } from "vitest";
import {
  GITHUB_NOTIFICATIONS_MODULE,
  MAX_DIGEST_ITEMS,
  aggregateGithubNotifications,
  buildGithubDigestDecision,
  collectCoveredNotificationKeys,
  deriveGithubWebUrl,
  findPendingGithubDigest,
  githubNotificationKey,
  isGithubDigestDecision,
  isGithubNotificationSignal,
  normalizeGithubNotifications,
} from "@/lib/loop/github-notifications";
import type { LoopDecision, LoopSignal } from "@/lib/loop/types";

function sig(
  id: string,
  payload: Record<string, unknown>,
  source: "github" | "github_notifications" = "github",
): LoopSignal {
  return {
    id,
    ts: "2026-07-17T00:00:00.000Z",
    source,
    type: "github_notification",
    payload,
  };
}

function typedDecision(
  source: LoopSignal,
  type: LoopDecision["type"],
): LoopDecision {
  return {
    id: `dec_${source.id}`,
    ts: "2026-07-17T00:00:00.000Z",
    status: "pending",
    type,
    title: "typed",
    action: { kind: "github_review", params: {} },
    source_signal: source,
  };
}

describe("isGithubNotificationSignal", () => {
  it("accepts github + github_notifications sources with the right type", () => {
    expect(
      isGithubNotificationSignal({
        id: "1",
        ts: "t",
        source: "github",
        type: "github_notification",
        payload: {},
      }),
    ).toBe(true);
    expect(
      isGithubNotificationSignal({
        id: "2",
        ts: "t",
        source: "github_notifications",
        type: "github_notification",
        payload: {},
      }),
    ).toBe(true);
  });

  it("rejects wrong type / wrong source / null", () => {
    expect(
      isGithubNotificationSignal({
        id: "x",
        ts: "t",
        source: "slack",
        type: "github_notification",
        payload: {},
      }),
    ).toBe(false);
    expect(
      isGithubNotificationSignal({
        id: "y",
        ts: "t",
        source: "github",
        type: "github_pr",
        payload: {},
      }),
    ).toBe(false);
    expect(isGithubNotificationSignal(null)).toBe(false);
  });
});

describe("deriveGithubWebUrl", () => {
  it("passes through github.com URLs", () => {
    expect(deriveGithubWebUrl("https://github.com/owner/repo/issues/1")).toBe(
      "https://github.com/owner/repo/issues/1",
    );
  });

  it("converts api.github.com issue URLs to web URLs", () => {
    expect(
      deriveGithubWebUrl("https://api.github.com/repos/owner/repo/issues/123"),
    ).toBe("https://github.com/owner/repo/issues/123");
  });

  it("converts api.github.com pull URLs to web URLs", () => {
    expect(
      deriveGithubWebUrl("https://api.github.com/repos/owner/repo/pulls/7"),
    ).toBe("https://github.com/owner/repo/pull/7");
  });

  it("converts bare repo api URLs", () => {
    expect(deriveGithubWebUrl("https://api.github.com/repos/owner/repo")).toBe(
      "https://github.com/owner/repo",
    );
  });

  it("rejects non-HTTPS, foreign host, and garbage input", () => {
    expect(
      deriveGithubWebUrl("http://github.com/owner/repo/issues/1"),
    ).toBeNull();
    expect(
      deriveGithubWebUrl("https://example.com/repos/owner/repo/issues/1"),
    ).toBeNull();
    expect(deriveGithubWebUrl("not a url")).toBeNull();
    expect(deriveGithubWebUrl(null)).toBeNull();
  });
});

describe("githubNotificationKey", () => {
  it("prefers the notification id", () => {
    const key = githubNotificationKey(
      sig("abc", {
        id: "thread-123",
        repository: { full_name: "owner/repo" },
        subject: {
          title: "PR title",
          url: "https://api.github.com/repos/owner/repo/pulls/1",
        },
      }),
    );
    expect(key).toBe("gh:id:thread-123");
  });

  it("falls back to repo + subject number when id missing", () => {
    const key = githubNotificationKey(
      sig("abc", {
        repository: { full_name: "owner/repo" },
        subject: {
          url: "https://api.github.com/repos/owner/repo/issues/42",
        },
      }),
    );
    expect(key).toBe("gh:owner/repo#42");
  });

  it("falls back to repo + title when id and url missing", () => {
    const key = githubNotificationKey(
      sig("abc", {
        repository: { full_name: "owner/repo" },
        subject: { title: "Custom title" },
      }),
    );
    expect(key).toBe("gh:owner/repo:custom title");
  });

  it("returns null when nothing usable is present", () => {
    expect(githubNotificationKey(sig("abc", {}))).toBeNull();
  });
});

describe("normalizeGithubNotifications", () => {
  it("collapses cross-source duplicates by canonical key", () => {
    const a = sig(
      "1",
      {
        id: "thread-1",
        repository: { full_name: "owner/repo" },
        subject: {
          title: "PR",
          url: "https://api.github.com/repos/owner/repo/pulls/5",
        },
      },
      "github",
    );
    const b = sig(
      "2",
      {
        id: "thread-1",
        repository: { full_name: "owner/repo" },
        subject: {
          title: "PR",
          url: "https://api.github.com/repos/owner/repo/pulls/5",
        },
      },
      "github_notifications",
    );
    const items = normalizeGithubNotifications([a, b]);
    expect(items).toHaveLength(1);
    expect(items[0]?.repo).toBe("owner/repo");
    expect(items[0]?.url).toBe("https://github.com/owner/repo/pull/5");
  });

  it("prefers items that carry a URL when merging", () => {
    const noUrl = sig("1", {
      id: "thread-1",
      repository: { full_name: "owner/repo" },
      subject: { title: "PR" },
    });
    const withUrl = sig("2", {
      id: "thread-1",
      repository: { full_name: "owner/repo" },
      subject: {
        title: "PR",
        url: "https://api.github.com/repos/owner/repo/issues/9",
      },
    });
    const items = normalizeGithubNotifications([noUrl, withUrl]);
    expect(items).toHaveLength(1);
    expect(items[0]?.url).toBe("https://github.com/owner/repo/issues/9");
  });

  it("ignores signals that are not github_notification typed", () => {
    const email: LoopSignal = {
      id: "e",
      ts: "t",
      source: "gmail",
      type: "email",
      payload: {},
    };
    expect(normalizeGithubNotifications([email])).toHaveLength(0);
  });

  it("skips signals with no canonical key", () => {
    const none = sig("1", { subject: {} });
    expect(normalizeGithubNotifications([none])).toHaveLength(0);
  });
});

describe("isGithubDigestDecision + collectCoveredNotificationKeys", () => {
  it("identifies github-notification digest decisions", () => {
    const dec: LoopDecision = {
      id: "g1",
      ts: "t",
      status: "pending",
      type: "quiet_digest",
      title: "GitHub has 1 update",
      action: {
        kind: "quiet_digest",
        params: { module: GITHUB_NOTIFICATIONS_MODULE },
      },
    };
    expect(isGithubDigestDecision(dec)).toBe(true);
  });

  it("rejects other quiet_digest modules", () => {
    const dec: LoopDecision = {
      id: "g1",
      ts: "t",
      status: "pending",
      type: "quiet_digest",
      title: "Weather",
      action: { kind: "quiet_digest", params: { module: "ai-news-digest" } },
    };
    expect(isGithubDigestDecision(dec)).toBe(false);
  });

  it("collects keys from prior digests and from typed decisions", () => {
    const src = sig("1", { id: "t1", repository: { full_name: "o/r" } });
    const digest: LoopDecision = {
      id: "d",
      ts: "t",
      status: "dismissed",
      type: "quiet_digest",
      title: "old",
      action: {
        kind: "quiet_digest",
        params: { module: GITHUB_NOTIFICATIONS_MODULE },
      },
      context: {
        module: GITHUB_NOTIFICATIONS_MODULE,
        notification_keys: ["gh:other#1"],
      },
    };
    const typed = typedDecision(src, "review_pr");
    const unknown: LoopDecision = {
      id: "u",
      ts: "t",
      status: "pending",
      type: "unknown",
      title: "noise",
      action: { kind: "todo", params: {} },
      source_signal: src,
    };
    const covered = collectCoveredNotificationKeys([digest, typed, unknown]);
    expect(covered.has("gh:other#1")).toBe(true);
    expect(covered.has("gh:id:t1")).toBe(true);
    // unknown must NOT count as covering the key.
    expect(covered.size).toBe(2);
  });
});

describe("buildGithubDigestDecision", () => {
  it("produces a read-only quiet_digest with bounded items", () => {
    const items = Array.from({ length: MAX_DIGEST_ITEMS + 5 }, (_, i) => ({
      key: `gh:owner/repo#${i}`,
      repo: "owner/repo",
      title: `Issue ${i}`,
      summary: "Open",
    }));
    const dec = buildGithubDigestDecision(items);
    expect(dec.type).toBe("quiet_digest");
    expect(dec.action.kind).toBe("quiet_digest");
    expect(dec.action.params?.module).toBe(GITHUB_NOTIFICATIONS_MODULE);
    const ctx = dec.context as Record<string, unknown>;
    expect(Array.isArray(ctx.items)).toBe(true);
    expect((ctx.items as unknown[]).length).toBe(MAX_DIGEST_ITEMS);
    expect(dec.confidence).toBe(0.9);
  });

  it("produces singular phrasing for one item", () => {
    const dec = buildGithubDigestDecision([
      { key: "gh:o/r#1", repo: "o/r", title: "t", summary: "s" },
    ]);
    expect(dec.title).toBe("GitHub has 1 update");
    expect(dec.dialogue).toContain("1 unread GitHub notification");
    expect(dec.dialogue).toContain("across 1 repo");
  });

  it("produces plural phrasing for many items, summarizing repos", () => {
    const dec = buildGithubDigestDecision([
      { key: "gh:a/r#1", repo: "a/r", title: "t1", summary: "" },
      { key: "gh:b/r#1", repo: "b/r", title: "t2", summary: "" },
      { key: "gh:c/r#1", repo: "c/r", title: "t3", summary: "" },
      { key: "gh:d/r#1", repo: "d/r", title: "t4", summary: "" },
    ]);
    expect(dec.title).toBe("GitHub has 4 updates");
    expect(dec.dialogue).toContain("across 4 repos");
    expect(dec.dialogue).toContain("+1 more");
  });
});

describe("aggregateGithubNotifications", () => {
  const src = sig("1", {
    id: "t-1",
    repository: { full_name: "owner/repo" },
    subject: {
      title: "PR",
      url: "https://api.github.com/repos/owner/repo/pulls/1",
    },
    reason: "review_requested",
  });

  it("returns noop when there are no github_notification signals", () => {
    const r = aggregateGithubNotifications({ signals: [], decisions: [] });
    expect(r.kind).toBe("noop");
  });

  it("creates a new digest when nothing covers the keys", () => {
    const r = aggregateGithubNotifications({ signals: [src], decisions: [] });
    expect(r.kind).toBe("create");
    expect(r.decision?.type).toBe("quiet_digest");
    expect(r.newKeys).toEqual(["gh:id:t-1"]);
  });

  it("returns noop when every key is already covered by typed decisions", () => {
    const typed = typedDecision(src, "review_pr");
    const r = aggregateGithubNotifications({
      signals: [src],
      decisions: [typed],
    });
    expect(r.kind).toBe("noop");
  });

  it("returns noop when every key is covered by an existing digest", () => {
    const coveredKey = githubNotificationKey(src);
    if (!coveredKey) throw new Error("expected canonical key");
    const existing: LoopDecision = {
      id: "existing",
      ts: "t0",
      status: "pending",
      type: "quiet_digest",
      title: "old",
      action: {
        kind: "quiet_digest",
        params: { module: GITHUB_NOTIFICATIONS_MODULE },
      },
      context: {
        module: GITHUB_NOTIFICATIONS_MODULE,
        notification_keys: [coveredKey],
        items: [
          {
            key: coveredKey,
            repo: "owner/repo",
            title: "PR",
            summary: "",
          },
        ],
      },
    };
    const r = aggregateGithubNotifications({
      signals: [src],
      decisions: [existing],
    });
    expect(r.kind).toBe("noop");
  });

  it("merges new items into an existing pending digest", () => {
    const existing = buildGithubDigestDecision([
      { key: "gh:old/r#1", repo: "old/r", title: "old", summary: "" },
    ]);
    const newSig = sig("2", {
      id: "t-2",
      repository: { full_name: "new/r" },
      subject: { title: "New" },
    });
    const r = aggregateGithubNotifications({
      signals: [newSig],
      decisions: [existing],
    });
    expect(r.kind).toBe("merge");
    expect(r.decision?.id).toBe(existing.id);
    expect(r.newKeys).toEqual(["gh:id:t-2"]);
    const items = (r.decision?.context as Record<string, unknown>)
      ?.items as Array<{
      key: string;
    }>;
    const keys = items.map((i) => i.key);
    expect(keys).toContain("gh:old/r#1");
    expect(keys).toContain("gh:id:t-2");
  });

  it("uses a custom clock for deterministic ts when supplied", () => {
    const r = aggregateGithubNotifications({
      signals: [src],
      decisions: [],
      now: "2026-07-17T12:34:56.000Z",
    });
    expect(r.decision?.ts).toBe("2026-07-17T12:34:56.000Z");
  });

  it("preserves the existing pending digest's created_ts when merging", () => {
    const originalTs = "2026-07-01T00:00:00.000Z";
    const existing: LoopDecision = {
      id: "merge_target",
      ts: originalTs,
      status: "pending",
      type: "quiet_digest",
      title: "old",
      action: {
        kind: "quiet_digest",
        params: { module: GITHUB_NOTIFICATIONS_MODULE },
      },
      context: {
        module: GITHUB_NOTIFICATIONS_MODULE,
        notification_keys: ["gh:o/r#1"],
        items: [{ key: "gh:o/r#1", repo: "o/r", title: "t", summary: "" }],
        created_ts: originalTs,
      },
    };
    const newSig = sig("3", {
      id: "t-3",
      repository: { full_name: "x/y" },
      subject: { title: "X" },
    });
    const r = aggregateGithubNotifications({
      signals: [newSig],
      decisions: [existing],
      now: "2026-07-17T00:00:00.000Z",
    });
    expect(r.kind).toBe("merge");
    expect((r.decision?.context as Record<string, unknown>)?.created_ts).toBe(
      originalTs,
    );
  });
});

describe("findPendingGithubDigest", () => {
  it("finds a pending github digest, ignores done/dismissed", () => {
    const pending = buildGithubDigestDecision([
      { key: "gh:a#1", repo: "a", title: "t", summary: "" },
    ]);
    const done: LoopDecision = { ...pending, id: "x", status: "done" };
    const dismissed: LoopDecision = {
      ...pending,
      id: "y",
      status: "dismissed",
    };
    expect(findPendingGithubDigest([pending])?.id).toBe(pending.id);
    expect(findPendingGithubDigest([done])).toBeNull();
    expect(findPendingGithubDigest([dismissed])).toBeNull();
  });
});
