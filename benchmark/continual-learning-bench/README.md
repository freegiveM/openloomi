# Continual Learning Bench on OpenLoomi

A one-shot script that takes a fresh Windows / WSL Ubuntu machine to a
running [pgasawa/continual-learning-bench](https://github.com/pgasawa/continual-learning-bench)
evaluation against a local [OpenLoomi](https://github.com/) server.

The benchmark's `default` schedule is what the upstream paper uses for
its leaderboard numbers (`mean_gain` = stateful reward − stateless reward,
the core continual-learning signal).

---

## TL;DR

Run this in **WSL Ubuntu** (one shot, end to end):

```bash
bash /mnt/d/openloomi3/openloomi/benchmark/continual-learning-bench/run-clbench-on-openloomi.sh --all --full
```

Other useful invocations:

```bash
# Just the smoke test on a single task (~1-3 minutes)
bash /mnt/d/openloomi3/openloomi/benchmark/continual-learning-bench/run-clbench-on-openloomi.sh

# Just one task, full default schedule (~20-40 minutes for exploitable_poker)
bash .../run-clbench-on-openloomi.sh --task exploitable_poker --full

# All six tasks, quick_test schedule (~30-60 minutes total)
bash .../run-clbench-on-openloomi.sh --all

# Different model
bash .../run-clbench-on-openloomi.sh --model MiniMax-M3-highspeed
```

---

## What the script does

The pipeline is fully idempotent. Re-running skips anything that's already done.

| # | Step | What it checks / does |
| --- | --- | --- |
| 1 | Environment | WSL Ubuntu, free RAM, free disk, Windows host IP |
| 2 | OpenLoomi config | Token at `~/.openloomi/token`, `.env` for the benchmark |
| 3 | Docker CE | Installs (if missing) + restarts `dockerd` if dead + pulls 3 CL-bench images |
| 4 | CL-bench repo + venv | Repairs the empty `__init__.py` 9P bug, builds `.venv`, installs deps, writes `clbench` wrapper |
| 5 | OpenLoomi HTTP | `curl http://<host>:3515/` must return 200 / 401 / 403 |
| 6 | Per-task setup | `clbench setup <task>` for tasks that declare `has_setup = True` |
| 7 | Warmup | Probe the homepage to compile Next.js chunks (avoids first-call timeout) |
| 8 | Run | Per-task `clbench run` with the right schedule and `--system openloomi` |
| 9 | Results | List artifacts under `D:\clbench-work\continual-learning-bench\results\` |

---

## Prerequisites

Before you run the script, do these once on Windows:

### 1. Enable WSL 2 + install Ubuntu

```powershell
wsl --install -d Ubuntu
wsl --shutdown
```

(If `aka.ms` is unreachable from your network, use
`D:\downloads\wsl\install-ubuntu-offline.ps1` from the OpenLoomi repo instead
— it pulls an Ubuntu 22.04 rootfs from `partner-images.canonical.com`.)

### 2. Start OpenLoomi

OpenLoomi itself is **not** in this script — it's a long-running dev server.
Start it in **its own PowerShell window** so it stays alive while CL-bench runs:

```powershell
powershell -ExecutionPolicy Bypass -File D:\openloomi3\openloomi\benchmark\continual-learning-bench\scripts\start-openloomi-minimal.ps1
```

That script:
- Uses `--max-old-space-size=3072` (avoids OOM on 16 GB hosts that the
  upstream `pnpm dev` triggers with its hard-coded 16384)
- Uses the **webpack** backend (avoids Turbopack's Rust-side memory pressure)
- Runs `next dev` directly, bypassing pnpm and `run-cross-env.cjs`

Wait until you see `Ready in Xms` and `Local: http://localhost:3515`.

### 3. Verify the OpenLoomi auth token is in place

`%USERPROFILE%\.openloomi\token` (a 251-byte JWT file) — written by
OpenLoomi on first run. WSL reads it as
`/mnt/c/Users/<you>/.openloomi/token`. The script auto-detects this path
for the current user; if your username is not `32274`, edit
`run-clbench-on-openloomi.sh` line `TOKEN_FILE_LINUX=...`.

### 4. Free up enough disk

The 3 Docker images add up to ~1.8 GB. The CL-bench dataset adds another
~200 MB. Make sure `D:\` has at least **5 GB free** before running `--all`.

---

## What the script assumes about the layout

```
D:\clbench-work\continual-learning-bench\                # upstream clone (with our src/systems/openloomi/)
├── .env                                                  # written by this script
├── .venv\bin\clbench                                     # written by this script
├── data\...                                              # populated by clbench setup
└── results\...                                           # output

D:\openloomi3\openloomi\                                  # OpenLoomi repo (your existing checkout)
├── apps\web\.env                                         # AUTH_SECRET / ENCRYPTION_KEY (auto-generated)
└── node_modules\next\dist\bin\next                       # pnpm-hoisted

C:\Users\<you>\.openloomi\token                           # JWT, written by OpenLoomi on first run
```

---

## Argument reference

| Flag | Default | Meaning |
| --- | --- | --- |
| `--task <name>` | (none) | Run a single task instead of all six. Names: `exploitable_poker`, `cohort_studies`, `blind_spectrum_monitoring`, `database_exploration`, `sales_prediction`, `codebase_adaptation`. |
| `--quick` / `--full` | `--quick` | `quick_test` (5 instances) or the task's `default` schedule (5 stages × 5 runs × 50 instances). |
| `--all` | (off) | Run all six tasks sequentially. |
| `--model <id>` | `claude-sonnet-4-5` | Model name forwarded to OpenLoomi. |
| `--skip-docker` | (off) | Skip Docker CE install / image pulls. Use when you've already done that. |
| `--skip-setup` | (off) | Skip per-task `clbench setup` (only the per-task data downloads). |
| `--skip-openloomi-check` | (off) | Don't verify OpenLoomi HTTP before running. Useful for offline rehearsal. |
| `--dry-run` | (off) | Print the commands that would be run; don't actually run. |

---

## Expected output

For a `--full --task exploitable_poker` run, expect:

```
>>> RUN exploitable_poker
...
Mean reward: <float> over <n> instance(s)
Mean gain: <float>
Artifacts:
  /mnt/d/clbench-work/continual-learning-bench/results/exploitable_poker/viewer_artifact_*.json.gz
```

`Mean gain` is the upstream GAIN metric. Higher = the system actually
learned from the previous hands.

For all six tasks with `--all --full`, total runtime is **4-12 hours**
(depends on model latency). A `--all` run with the default quick schedule
is **30-60 minutes**.

---

## Viewing results

The benchmark ships HTML viewers under `viewers/`:

- `single_task_viewer.html` — one task, one system, one model
- `run_all_viewer.html` — compare all systems
- `compare_traces.html` — diff two traces

To open one:

```powershell
# From Windows Explorer, paste this into the address bar:
D:\clbench-work\continual-learning-bench\viewers\single_task_viewer.html
```

Then drag any `results\<task>\viewer_artifact_*.json.gz` from File Explorer
onto the page.

---

## Troubleshooting

### `OpenLoomi HTTP 000` (unreachable)

OpenLoomi isn't running. Start it:

```powershell
powershell -ExecutionPolicy Bypass -File D:\openloomi3\openloomi\benchmark\continual-learning-bench\scripts\start-openloomi-minimal.ps1
```

### `dockerd not running`

`nohup`-style background daemon died. Restart:

```bash
sudo pkill -9 dockerd 2>/dev/null
sudo rm -f /var/run/docker.pid /var/run/docker.sock
nohup dockerd > /tmp/dockerd.log 2>&1 &
disown
sleep 5
docker info | grep "Server Version"
```

For a one-liner next time, add to `~/.bashrc`:

```bash
alias dockerd-up='kill -9 $(cat /var/run/docker.pid 2>/dev/null) 2>/dev/null; \
  rm -f /var/run/docker.pid /var/run/docker.sock; \
  nohup dockerd > /tmp/dockerd.log 2>&1 & disown; sleep 5; \
  docker info | grep "Server Version"'
```

### `Cannot find module 'D:\...\node_modules\next\dist\bin\next'`

The minimal startup script looks for `next` at the **monorepo root**
(`D:\openloomi3\openloomi\node_modules\next\...`), not at
`apps/web/node_modules/next`. If you ran `pnpm install` inside
`apps/web/` it would have been placed in the right spot, but pnpm
workspaces prefer the monorepo root.

### `Loading chunk app/layout failed (timeout)`

Next.js dev mode compiles chunks on first request, which can take 60+
seconds. The script's Step 7 (warmup) pre-compiles the homepage. If a
specific task still hits this, retry the call — chunks are cached
after the first compile.

### `database_exploration` setup fails (Hugging Face unreachable)

CL-bench's `database_exploration` task downloads two SQLite files from
Hugging Face. In China, set `HF_ENDPOINT=https://hf-mirror.com` before
running the script:

```bash
HF_ENDPOINT=https://hf-mirror.com bash /mnt/d/openloomi3/openloomi/benchmark/continual-learning-bench/run-clbench-on-openloomi.sh --task database_exploration
```

If that mirror also blocks you, skip that task; the other 5 work
without it.

### `pkill: command not found` / `sudo: command not found`

The script tolerates both root and non-root users, but if your
shell environment is unusual (e.g. inside a container with reduced
PATH), make sure `/usr/bin`, `/bin`, `/sbin`, `/usr/sbin` are in `PATH`.

---

## Files this script depends on

| Path | What |
| --- | --- |
| `run-clbench-on-openloomi.sh` | this script |
| `scripts/start-openloomi-minimal.ps1` | start OpenLoomi (in another PowerShell window) |
| `scripts/install-docker-ce.sh` | optional; only if you need to install Docker |
| `D:\clbench-work\continual-learning-bench\src\systems\openloomi\` | custom CL-bench system that talks to OpenLoomi |
| `D:\clbench-work\continual-learning-bench\.env` | environment file written by this script |
| `D:\openloomi3\openloomi\apps\web\.env` | OpenLoomi's own env (auto-generated by `ensure-secrets.js` on first run) |

---

## Architecture

```
CL-bench (Python)                                     OpenLoomi (Node/Next.js)         MiniMax (upstream)
─────────────────────────────────────                  ──────────────────────────         ──────────────────
run-clbench-on-openloomi.sh                            start-openloomi-minimal.ps1
  │
  │  POST /api/native/agent
  │  Authorization: Bearer <~/.openloomi/token>
  │  Body: {prompt, provider:"claude", model:"..."}
  ▼
src/systems/openloomi/system.py ──── SSE stream ───▶   apps/web/app/api/native/agent/route.ts
  │                                                   │
  │                                                   │  POST https://api.minimaxi.com/anthropic
  │                                                   │  x-api-key: sk-cp-...
  │                                                   ▼
  │                                                   MiniMax (forwards to Claude)
```

CL-bench never sees the MiniMax API token — it only talks to OpenLoomi,
which is responsible for upstream provider routing.
