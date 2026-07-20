#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const MARKER = "_openloomi_plugin";
const PLUGIN_BLOCK_KEY = "__openloomi_claude_plugin_hooks__";

function settingsPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function atomicWriteJson(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);
}

function loadHooksTemplate() {
  const pluginDir = path.resolve(__dirname, "..");
  const hooksFile = path.join(pluginDir, "hooks", "hooks.json");
  return { pluginDir, template: readJsonSafe(hooksFile) };
}

// Resolve `${CLAUDE_PLUGIN_ROOT}` placeholders in a hook command to the
// plugin's absolute path. Claude Code only injects this env var when hooks
// are loaded directly from a plugin manifest; when we install them into
// user-level `~/.claude/settings.json` we have to substitute ourselves or
// the placeholder expands to empty and Node tries to resolve
// `/scripts/loomi-bridge.mjs` from the filesystem root.
function substitutePluginRoot(command, pluginDir) {
  if (
    typeof command !== "string" ||
    !command.includes("${CLAUDE_PLUGIN_ROOT}")
  ) {
    return command;
  }
  // Wrap the substituted path in double quotes so paths with spaces parse
  // correctly under the shell. The original template has the placeholder
  // unquoted (e.g. `node ${CLAUDE_PLUGIN_ROOT}/scripts/...`), so quote just
  // the path component by replacing the placeholder with `"<pluginDir>"`.
  const quoted = `"${pluginDir}"`;
  return command.split("${CLAUDE_PLUGIN_ROOT}").join(quoted);
}

function materializeHookEntry(entry, pluginDir) {
  // Deep-clone so we don't mutate the shared template, then rewrite each
  // inner command's placeholder to an absolute path.
  const cloned = JSON.parse(JSON.stringify(entry));
  if (cloned && Array.isArray(cloned.hooks)) {
    cloned.hooks = cloned.hooks.map((h) => {
      if (h && typeof h.command === "string") {
        return { ...h, command: substitutePluginRoot(h.command, pluginDir) };
      }
      return h;
    });
  }
  return cloned;
}

function install({ yes }) {
  const settingsFile = settingsPath();
  const settings = readJsonSafe(settingsFile);
  if (!settings.hooks || typeof settings.hooks !== "object")
    settings.hooks = {};

  // Legacy cleanup: drop the old nested block from previous broken versions.
  if (settings.hooks[PLUGIN_BLOCK_KEY]) {
    delete settings.hooks[PLUGIN_BLOCK_KEY];
  }

  const { pluginDir, template: tpl } = loadHooksTemplate();
  const templateHooks = tpl?.hooks || {};
  if (Object.keys(templateHooks).length === 0) {
    return {
      ok: false,
      error: "No hooks loaded from template",
      path: settingsFile,
    };
  }

  // Merge per-event into settings.hooks (Claude Code's actual schema is
  // `{ EventName: [matcher-group, ...] }`). Each entry carries the marker
  // so uninstall can strip just our entries.
  let added = 0;
  let already = 0;
  for (const [event, rawEntries] of Object.entries(templateHooks)) {
    const entries = Array.isArray(rawEntries) ? rawEntries : [rawEntries];
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
    for (const entry of entries) {
      const cmd0 = substitutePluginRoot(
        entry?.hooks?.[0]?.command || "",
        pluginDir,
      );
      const isDup = settings.hooks[event].some(
        (e) =>
          e &&
          e[MARKER] === true &&
          e.hooks &&
          e.hooks.some((h) => h && h.command === cmd0),
      );
      if (isDup) {
        already++;
        continue;
      }
      settings.hooks[event].push(
        Object.assign({}, materializeHookEntry(entry, pluginDir), {
          [MARKER]: true,
        }),
      );
      added++;
    }
  }

  atomicWriteJson(settingsFile, settings);
  return {
    ok: true,
    alreadyInstalled: added === 0,
    path: settingsFile,
    summary: {
      events: Object.keys(templateHooks),
      added,
      alreadyInstalled: already,
      note: "Per-event merge into settings.hooks (Claude Code schema-compliant).",
    },
  };
}

function uninstall() {
  const settingsFile = settingsPath();
  const settings = readJsonSafe(settingsFile);
  let removed = false;
  if (settings.hooks && typeof settings.hooks === "object") {
    // Always strip the legacy nested block from older broken versions.
    if (settings.hooks[PLUGIN_BLOCK_KEY]) {
      delete settings.hooks[PLUGIN_BLOCK_KEY];
      removed = true;
    }
    // Strip per-event marker entries (current schema) and any inner
    // loomi-bridge.mjs commands from mixed entries.
    for (const event of Object.keys(settings.hooks)) {
      if (event === PLUGIN_BLOCK_KEY) continue;
      const arr = settings.hooks[event];
      if (!Array.isArray(arr)) continue;
      const before = arr.length;
      settings.hooks[event] = arr.filter((entry) => {
        if (!entry) return false;
        if (entry[MARKER]) return false;
        if (entry.hooks && Array.isArray(entry.hooks)) {
          const inner = entry.hooks.filter(
            (h) =>
              !(
                h &&
                typeof h.command === "string" &&
                h.command.includes("loomi-bridge.mjs")
              ),
          );
          if (inner.length === 0) return false;
          entry.hooks = inner;
          return true;
        }
        return true;
      });
      if (settings.hooks[event].length !== before) removed = true;
    }
  }
  atomicWriteJson(settingsFile, settings);
  return { ok: true, removed, path: settingsFile };
}

function status() {
  const settingsFile = settingsPath();
  const settings = readJsonSafe(settingsFile);
  let installed = false;
  const hooks = settings.hooks || {};
  if (hooks[PLUGIN_BLOCK_KEY]) {
    installed = true;
  } else {
    for (const event of Object.keys(hooks)) {
      if (event === PLUGIN_BLOCK_KEY) continue;
      const arr = hooks[event];
      if (!Array.isArray(arr)) continue;
      for (const entry of arr) {
        if (entry?.[MARKER]) {
          installed = true;
          break;
        }
        if (entry && Array.isArray(entry.hooks)) {
          for (const h of entry.hooks) {
            if (
              h &&
              typeof h.command === "string" &&
              h.command.includes("loomi-bridge.mjs")
            ) {
              installed = true;
              break;
            }
          }
        }
        if (installed) break;
      }
      if (installed) break;
    }
  }
  return {
    ok: true,
    installed,
    path: settingsFile,
    marker: MARKER,
    legacyBlockKey: PLUGIN_BLOCK_KEY,
    schema: "per-event",
  };
}

function printResult(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + os.EOL);
  if (!obj.ok) process.exit(1);
}

const sub = process.argv[2];
if (sub === "install") {
  printResult(install({ yes: process.argv.includes("--yes") }));
} else if (sub === "uninstall") {
  printResult(uninstall());
} else if (sub === "status") {
  printResult(status());
} else {
  process.stdout.write(
    JSON.stringify(
      {
        ok: false,
        code: "UNKNOWN_SUBCOMMAND",
        valid: ["install", "uninstall", "status"],
      },
      null,
      2,
    ) + os.EOL,
  );
  process.exit(1);
}
