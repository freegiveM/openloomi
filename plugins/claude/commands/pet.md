---
description: Set the OpenLoomi Pet to a specific state (theme-agnostic; fox sprite set active by default)
argument-hint: "<state>"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/loomi-bridge.mjs *)
---

# /openloomi:pet <state>

The bridge accepts 9 states for client-side validation:

`happy`, `idle`, `juggling`, `needsinput`, `presenting`, `sleeping`,
`sweeping`, `thinking`, `working`.

However, `POST /api/pet/state` only accepts 7 of these:

`idle`, `thinking`, `working`, `juggling`, `happy`, `presenting`,
`needsinput`.

`sleeping` and `sweeping` are capybara-theme vocabulary managed by the
Loop baseline watcher — the API returns 400 `invalid_state` for them.
The bridge currently forwards them and surfaces the 400 as
`PET_FAILED` rather than rejecting client-side. Avoid requesting those
two from Claude; let the Loop baseline watcher set them.

Run:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/loomi-bridge.mjs pet <state>
```

- If the state is one of the 7 API-accepted values, the bridge returns
  `{ok: true, state, response: { ok: true, ... }}`.
- If the state is `sleeping` / `sweeping` (bridge accepts but API
  rejects), the bridge returns `{ok: false, code: "PET_FAILED",
status: 400, error: { raw: "invalid_state" }}`.
- If the state is anything else, the bridge returns `{ok: false, code:
"INVALID_STATE", validStates: [...]}` client-side without hitting
  the API.
- If the `POST /api/pet/state` endpoint is not yet exposed by OpenLoomi,
  the bridge returns `{ok: false, code: "ENDPOINT_MISSING", ...}` with a
  polite notice. Treat that as a non-blocking outcome for the user.

Tips:

- Manual `idle`, `sleeping`, `sweeping`, `presenting` are managed by the
  loop watcher — changing them from Claude will be quickly overridden.
- Hooks handle automatic state transitions; `/openloomi:pet` is for
  explicit user-driven overrides.
