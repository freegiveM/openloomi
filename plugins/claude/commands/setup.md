---
description: Run OpenLoomi one-time setup — auto-chains install → launch → guest login → sync Claude env → ready in one call
argument-hint: ""
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/loomi-bridge.mjs *)
---

# /openloomi:setup

The bridge is now an **end-to-end** wizard. A single `setup` invocation
walks the full state machine:

```
install OpenLoomi.app
  → launch the desktop app (`open -a <desktopMarker>`)
  → wait for the local HTTP API to come up
  → mint a guest bearer (one-tap sign-in)
  → sync ANTHROPIC_API_KEY from the shell that spawned Claude Code
  → { ready: true }
```

Each transition is automatic. **Do not** ask the user to click anything in
the GUI. The bridge only surfaces a stop condition when the next step
truly requires human action (e.g. no `ANTHROPIC_API_KEY` in the env).

## Steps

1. If the install needs explicit consent (the bridge returns
   `setup: install_attempted` is the only case where this matters —
   normally `--yes` is passed straight through), confirm with the user
   before re-running.
2. Run: `node ${CLAUDE_PLUGIN_ROOT}/scripts/loomi-bridge.mjs setup --yes [--max-wait <ms>]`
3. Read the JSON. The bridge writes an audit trail of what it did into
   `steps[]`. Surface that to the user so they can see which transitions
   fired. Never echo key contents.
4. If `setup: ready` → done.
5. If `setup: awaiting_user_action` → the chain hit a step that genuinely
   needs the user (e.g. `nextAction: login_openloomi` but `canGuestLogin:
   false` because the local runtime didn't come up, or `nextAction:
   configure_ai_provider` with no env key). Explain what the user needs to
   do and stop.

## Flags

| Flag          | Default | Meaning                                                                                                |
| ------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `--yes`       | off     | Pre-approve install (otherwise the bridge prompts y/N — but in Claude Code's Bash tool there is no TTY, so without `--yes` the install would silently cancel). |
| `--max-wait`  | 30000   | Total milliseconds the bridge will spend waiting for the desktop app's local API to come up after launch. |
| `--bin-path`  | _auto_  | Override the discovered helper binary path (advanced).                                                  |

## Stop conditions and what they mean

| `setup`                  | When it fires                                                                                                                                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`                  | All four transitions completed. Show `mode` and `version`.                                                                                                                                                                                                              |
| `install_attempted`      | First invocation: install ran. The user pre-approved; this is just informational.                                                                                                                                                                                       |
| `install_failed`         | The platform install script exited non-zero. Show `install.code` / `install.stderr`.                                                                                                                                                                                    |
| `launch_failed`          | `open -a <desktopMarker>` returned a non-zero exit. On macOS this almost never happens for a signed .app; if it does, fall back to manual launch instructions.                                                                                                         |
| `api_not_ready`          | The desktop app was launched but the local HTTP API didn't respond within `--max-wait`. Tell the user to look for the OpenLoomi.app window (any TCC prompts?). Re-run `/openloomi:setup` once they're past the prompts.                                                  |
| `guest_login_failed`     | API is up but the one-tap guest login was rejected. Show `guest.code` / `guest.error`. The user can sign in via the GUI and re-run setup.                                                                                                                              |
| `awaiting_user_action`   | A transition that needs the user ran without a programmatic path. Most commonly: `configure_ai_provider` with no `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` in the env — walk them through OpenLoomi Desktop → API Settings, OR export the key and restart Claude Code. |
| `step_limit_reached`     | Hit the internal step ceiling without reaching READY (default 8 transitions). Almost certainly means a state-machine bug; show `steps[]`.                                                                                                                              |

The bridge's stdout output is authoritative. Never invoke the platform
install script (`setup.{macos,linux,windows}.*`) directly — only the
bridge may run it, and only after explicit y/N consent.
