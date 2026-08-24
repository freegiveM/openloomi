import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

const authState = vi.hoisted(() => ({
  verifiedToken: { id: "user-1" } as { id: string } | null,
  user: { id: "user-1" } as object | null,
}));
const modeState = vi.hoisted(() => ({ tauri: true }));
const installState = vi.hoisted(() => ({ run: vi.fn() }));
const loginState = vi.hoisted(() => ({ run: vi.fn() }));
const selectionState = vi.hoisted(() => ({ select: vi.fn() }));

vi.mock("@/lib/auth/dual-auth", () => ({
  getAuthUser: vi.fn(async () => authState.user),
}));
vi.mock("@/lib/auth/remote-auth-utils", () => ({
  verifyToken: vi.fn(() => authState.verifiedToken),
}));
vi.mock("@/lib/env/constants", () => ({
  isTauriMode: vi.fn(() => modeState.tauri),
}));
vi.mock("@/lib/ai/native-agent/codex-login", () => ({
  runCodexLogin: loginState.run,
}));
vi.mock("@/lib/ai/native-agent/codex-install", () => ({
  runCodexInstall: installState.run,
}));
vi.mock("@/lib/ai/native-agent/runtime-selection", () => ({
  selectReadyAgentRuntime: selectionState.select,
}));

const [{ POST: installCodex }, { POST: loginCodex }] = await Promise.all([
  import("@/app/(chat)/api/preferences/agent-runtime/codex/install/route"),
  import("@/app/(chat)/api/preferences/agent-runtime/codex/login/route"),
]);

function request(
  options: {
    bearer?: string;
    desktopHeader?: boolean;
  } = {},
) {
  const headers = new Headers();
  if (options.bearer) {
    headers.set("Authorization", `Bearer ${options.bearer}`);
  }
  if (options.desktopHeader) {
    headers.set("X-Requested-With", "OpenLoomiDesktop");
  }
  return new Request(
    "http://localhost/api/preferences/agent-runtime/codex/login",
    { method: "POST", headers },
  );
}

describe("Codex login route", () => {
  beforeEach(() => {
    authState.verifiedToken = { id: "user-1" };
    authState.user = { id: "user-1" };
    modeState.tauri = true;
    installState.run.mockReset();
    installState.run.mockResolvedValue({ status: "completed" });
    loginState.run.mockReset();
    loginState.run.mockResolvedValue({ status: "completed" });
    selectionState.select.mockReset();
    selectionState.select.mockResolvedValue({
      selected: true,
      settings: {
        platform: "windows",
        runtimes: {},
        preference: "codex",
        effective: { provider: "codex", source: "preference" },
      },
    });
  });

  test("blocks unauthenticated, non-desktop, and cross-site-style requests", async () => {
    authState.user = null;
    expect((await installCodex(request({ desktopHeader: true }))).status).toBe(
      401,
    );

    authState.user = { id: "user-1" };
    expect((await loginCodex(request())).status).toBe(403);

    authState.verifiedToken = null;
    expect(
      (await installCodex(request({ bearer: "invalid", desktopHeader: true })))
        .status,
    ).toBe(401);

    authState.verifiedToken = { id: "user-2" };
    expect(
      (await installCodex(request({ bearer: "valid", desktopHeader: true })))
        .status,
    ).toBe(401);

    authState.verifiedToken = { id: "user-1" };
    modeState.tauri = false;
    expect((await installCodex(request({ desktopHeader: true }))).status).toBe(
      403,
    );
    expect(installState.run).not.toHaveBeenCalled();
    expect(loginState.run).not.toHaveBeenCalled();
  });

  test("installs without output, then verifies, logs in, and enables Codex", async () => {
    const installResponse = await installCodex(
      request({ desktopHeader: true }),
    );
    expect(installResponse.status).toBe(204);
    expect(installResponse.headers.get("cache-control")).toBe("no-store");
    expect(await installResponse.text()).toBe("");
    expect(installState.run).toHaveBeenCalledOnce();

    const loginResponse = await loginCodex(request({ desktopHeader: true }));

    expect(loginResponse.status).toBe(200);
    expect(loginResponse.headers.get("cache-control")).toBe("no-store");
    expect(await loginResponse.json()).toMatchObject({
      preference: "codex",
      effective: { provider: "codex", source: "preference" },
    });
    expect(loginState.run).toHaveBeenCalledOnce();
    expect(selectionState.select).toHaveBeenCalledWith("user-1", "codex");

    installState.run.mockResolvedValueOnce({
      status: "verification_failed",
    });
    const failedVerification = await installCodex(
      request({ desktopHeader: true }),
    );
    expect(failedVerification.status).toBe(409);
    expect(await failedVerification.json()).toEqual({
      error: "codex_install_verification_failed",
    });
  });
});
