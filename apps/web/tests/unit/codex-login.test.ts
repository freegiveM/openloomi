import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const processTools = vi.hoisted(() => ({
  buildEnvironment: vi.fn(),
  resolve: vi.fn(),
  terminate: vi.fn(),
  track: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => "C:\\Users\\test",
    platform: () => "win32",
  };
});
vi.mock("cross-spawn", () => ({ default: spawnMock }));
vi.mock("@/lib/ai/extensions/agent/codex/command-resolver", () => ({
  resolveCodexCommand: processTools.resolve,
}));
vi.mock("@/lib/ai/extensions/agent/cli-process", () => ({
  buildAgentCliSearchPath: vi.fn(() => "C:\\safe-cli-path"),
  buildCliEnvironment: processTools.buildEnvironment,
  shouldDetachCliProcess: vi.fn(() => false),
  terminateCliProcessTree: processTools.terminate,
  trackCliProcess: processTools.track,
}));

const [{ runCodexInstall }, { runCodexLogin }] = await Promise.all([
  import("@/lib/ai/native-agent/codex-install"),
  import("@/lib/ai/native-agent/codex-login"),
]);

function childProcess(): ChildProcess {
  type MutableChildProcess = {
    -readonly [Key in keyof ChildProcess]: ChildProcess[Key];
  };
  const child = new EventEmitter() as MutableChildProcess;
  child.stdout = null;
  child.stderr = null;
  child.stdin = null;
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 1234;
  child.kill = vi.fn(() => true);
  return child as ChildProcess;
}

describe("Codex CLI browser login", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    processTools.buildEnvironment.mockReset();
    processTools.buildEnvironment.mockReturnValue({
      AWS_SECRET_ACCESS_KEY: "must-not-reach-login",
      CODEX_CA_CERTIFICATE: "C:\\certs\\enterprise-ca.pem",
      CODEX_API_KEY: "must-not-reach-login",
      CODEX_HOME: "C:\\Users\\test\\.codex",
      CODEX_INSTALL_DIR: "D:\\unexpected-install-directory",
      DATABASE_URL: "postgres://must-not-reach-login",
      OPENAI_API_KEY: "must-not-reach-login",
      Path: "C:\\unsafe-cli-path",
      PATH: "C:\\safe-cli-path",
    });
    processTools.resolve.mockReset();
    processTools.resolve.mockReturnValue("C:\\Codex\\codex.exe");
    processTools.terminate.mockReset();
    processTools.track.mockReset();
    vi.stubEnv("CODEX_HOME", "C:\\Users\\test\\.codex");
    vi.stubEnv("OPENAI_API_KEY", "must-not-reach-login");
    vi.stubEnv("CODEX_API_KEY", "must-not-reach-login");
    vi.stubEnv("CODEX_INSTALL_DIR", "D:\\unexpected-install-directory");
    vi.stubEnv("DATABASE_URL", "postgres://must-not-reach-login");
    vi.stubEnv("LOCALAPPDATA", "C:\\Users\\test\\AppData\\Local");
    vi.stubEnv("SYSTEMROOT", "C:\\Windows");
    Reflect.deleteProperty(globalThis, "__openLoomiCodexInstall");
    Reflect.deleteProperty(globalThis, "__openLoomiCodexLogin");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  test("spawns only the resolved login command with a restricted environment", async () => {
    const child = childProcess();
    spawnMock.mockReturnValue(child);

    const login = runCodexLogin();
    const concurrent = runCodexLogin();

    expect(concurrent).toBe(login);
    expect(processTools.resolve).toHaveBeenCalledWith({
      configuredCommand: process.env.OPENLOOMI_AGENT_CODEX_COMMAND,
      searchPath: "C:\\safe-cli-path",
    });
    expect(spawnMock).toHaveBeenCalledWith(
      "C:\\Codex\\codex.exe",
      ["login"],
      expect.objectContaining({
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      }),
    );
    const environment = spawnMock.mock.calls[0]?.[2]?.env;
    expect(environment).toMatchObject({
      CODEX_CA_CERTIFICATE: "C:\\certs\\enterprise-ca.pem",
      CODEX_HOME: "C:\\Users\\test\\.codex",
      PATH: "C:\\safe-cli-path",
    });
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(environment).not.toHaveProperty("CODEX_API_KEY");
    expect(environment).not.toHaveProperty("DATABASE_URL");
    expect(processTools.track).toHaveBeenCalledWith(child);

    child.emit("close", 0);
    await expect(login).resolves.toEqual({ status: "completed" });
  });

  test("runs the fixed non-interactive installer once and unlocks after timeout", async () => {
    const installedChild = childProcess();
    processTools.resolve
      .mockImplementationOnce(() => {
        throw new Error("not installed");
      })
      .mockReturnValueOnce("C:\\Codex\\codex.exe");
    spawnMock.mockReturnValueOnce(installedChild);

    const install = runCodexInstall();
    const concurrent = runCodexInstall();

    expect(concurrent).toBe(install);
    expect(spawnMock).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Invoke-RestMethod -Uri 'https://chatgpt.com/codex/install.ps1' | Invoke-Expression",
      ],
      expect.objectContaining({
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      }),
    );
    const environment = spawnMock.mock.calls[0]?.[2]?.env;
    expect(environment).toMatchObject({
      CODEX_INSTALLER_USE_RELEASES_OPENAI_COM: "1",
      CODEX_NON_INTERACTIVE: "1",
      CODEX_RELEASE: "latest",
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
      OS: "Windows_NT",
      PATH: "C:\\safe-cli-path",
    });
    expect(environment).not.toHaveProperty("CODEX_INSTALL_DIR");
    expect(environment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(environment).not.toHaveProperty("CODEX_API_KEY");
    expect(environment).not.toHaveProperty("DATABASE_URL");
    expect(environment).not.toHaveProperty("Path");
    expect(processTools.track).toHaveBeenCalledWith(installedChild);

    installedChild.emit("close", 0);
    await expect(install).resolves.toEqual({ status: "completed" });
    expect(processTools.resolve).toHaveBeenLastCalledWith({
      searchPath: "C:\\safe-cli-path",
    });

    vi.useFakeTimers();
    processTools.resolve.mockImplementationOnce(() => {
      throw new Error("not installed");
    });
    const hangingChild = childProcess();
    spawnMock.mockReturnValueOnce(hangingChild);
    const timedOut = runCodexInstall();
    await vi.advanceTimersByTimeAsync(8 * 60 * 1000);
    await expect(timedOut).resolves.toEqual({ status: "timed_out" });
    expect(processTools.terminate).toHaveBeenCalledWith(hangingChild);

    processTools.resolve.mockReturnValueOnce("C:\\Codex\\codex.exe");
    await expect(runCodexInstall()).resolves.toEqual({ status: "completed" });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});
