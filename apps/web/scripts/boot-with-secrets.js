#!/usr/bin/env node
// Read secrets JSON from stdin, set environment variables, then execute the original server.js

import { spawn } from "node:child_process";

let secretsData = "";

process.stdin.setEncoding("utf8");

process.stdin.on("data", (chunk) => {
  secretsData += chunk;
});

process.stdin.on("end", () => {
  if (secretsData.trim()) {
    try {
      const secrets = JSON.parse(secretsData);
      Object.entries(secrets).forEach(([key, value]) => {
        if (value) process.env[key] = value;
      });
      console.log("✅ Loaded secrets from stdin");
    } catch (e) {
      console.error("❌ Failed to parse secrets:", e.message);
    }
  }

  // Execute the original Next.js server.js (last argument)
  const serverScript = process.argv[process.argv.length - 1];
  const child = spawn("node", [serverScript], {
    stdio: "inherit",
    env: process.env,
  });

  // Forward termination signals to the inner child so killing only the
  // wrapper (e.g. Tauri cleanup sending SIGTERM to this pid, not the
  // whole process group) still tears down the actual server. Without
  // this the inner Next.js process survives and burns the user's quota
  // (#516: orphaned Loop ticks after uninstall). The forwarded signal
  // child.on("exit") below turns into a conventional shell exit code.
  const FORWARDED_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
  const forwardSignal = (signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill(signal);
    } catch (_) {
      /* child already gone — best effort */
    }
  };
  for (const sig of FORWARDED_SIGNALS) {
    process.on(sig, () => forwardSignal(sig));
  }

  child.on("exit", (code, signal) => {
    if (signal) {
      // Conventional exit code for signal-induced death so callers
      // can distinguish a forced kill from a clean shutdown.
      const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
      process.exit(signalExitCodes[signal] ?? 128);
    }
    process.exit(code ?? 0);
  });
});
