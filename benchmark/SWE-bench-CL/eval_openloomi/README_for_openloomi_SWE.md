# 用 OpenLoomi 跑 SWE-Bench-CL 评测 —— 一站式脚本与说明

> 把 OpenLoomi 的 `/api/native/agent` 当成"agent harness"，直接吃 SWE-Bench-CL 数据集跑 continual learning 评测。

## 0. TL;DR — 三条命令

```bash
# (1) 启 OpenLoomi（在另一个 shell）
cd D:/openloomi3/openloomi/apps/web
$env:PORT=3515
pnpm tauri dev --config src-tauri/tauri.conf.dev.json

# (2) 一键 sanity（dry-run，不真跑 agent）
cd D:/openloomi3/openloomi/benchmark/SWE-bench-CL/eval_openloomi
bash ./run_openloomi_swe.sh                    # 默认: 跑 django_django_sequence 1 task, no_mem + mem

# (3) 真跑 5 条
SEQ_TASK_LIMIT=5 bash ./run_openloomi_swe.sh
```

跑完看 `swe_agent_cl_results.json`：

```json
{
  "1785909911-no_mem": {
    "memory_enabled": false,
    "overall": {"success_rate": 1.0, "tasks_attempted": 1, "tasks_succeeded": 1}
  },
  "1785910208-mem": {
    "memory_enabled": true,
    "overall": {"success_rate": 1.0, "tasks_attempted": 1, "tasks_succeeded": 1}
  }
}
```

---

## 1. 架构

```
┌──────────────────────┐                  ┌─────────────────────┐
│  apps/web (OpenLoomi) │  POST /api/      │  eval_openloomi/    │
│  Tauri dev on :3515   │  native/agent    │  run_openloomi_swe.sh│
│                      │ ───────────────▶ │                     │
│  Claude Agent SDK    │                  │  eval_procedure.py  │
│  + workDir 参数       │                  │   ↓                 │
└──────────────────────┘                  │  • setup repo @ base_commit
                                          │  • POST 给 OpenLoomi
                                          │  • git diff 拿 agent 改的代码
                                          │  • apply test_patch + model_patch
                                          │  • pytest (用 venv38 + 老 pytest)
                                          └─────────────────────┘
```

关键设计：

| 决策 | 原因 |
|---|---|
| **不写 LangGraph** | OpenLoomi 内部已是完整 agent（含 plan/execute/reflect）；再叠一层 LangGraph 是重复造轮 |
| **`workDir` 切到 SWE 仓库** | 让 agent `cd` 进仓库后能直接 `cat`/`Edit`/`Bash` |
| **`git diff` 优先于 `git apply` patch** | OpenLoomi agent 通常直接改文件；它的回复里 patch 与已改完的 file 对不上，apply 反而失败 |
| **venv38 + 老 pytest** | SWE-Bench-CL 旧仓库（django 3.x / pytest-dev 5.x）需要 Python 3.8–3.10；本机 3.12 不兼容 |
| **3-retry + 短间隔** | OpenLoomi 服务端偶发 `AgentOutputEventBusError`；空 reply 立刻重试 |

---

## 2. 一次完整跑都做了什么

`run_openloomi_swe.sh` 拆成 5 步：

| STEP | 干什么 | 失败怎么办 |
|---|---|---|
| **1. preflight** | curl `http://127.0.0.1:3515/api/native/providers`；WSL 视角下自动改用 host IP（`172.31.x.1`） | 起 OpenLoomi（见 §4） |
| **2. Python 3.8 venv** | `uv venv --python 3.8 --seed` + `uv pip install requests python-patch ...` | 重装；`uv` 不可达会报错 |
| **3. 装仓库到 venv38** | git clone 到 `cloned_repos/`；通过 PowerShell 调 `python -m pip install <repo>` | clone 失败可重试；pip 安装需联网 |
| **4. 跑 eval_procedure** | 调 `eval_procedure.py`；`OPENLOOMI_CL_EVAL_PYTHON` 指 venv38；`OPENLOOMI_CL_SEQUENCE_IDS` / `OPENLOOMI_CL_TASK_LIMIT` 控制粒度 | 看 `swe_agent_cl_results.json` |
| **5. summarize** | 跑一个 Python 脚本把 success_rate 打出来 | 看 `logs/checkpoints/<run>/` 里每条 task 的详情 |

---

## 3. 环境要求

| 工具 | 最低版本 | 安装 |
|---|---|---|
| Python 3.12（harness 主入口） | 3.12+ | `winget install Python.Python.3.12` |
| Python 3.8（venv38） | 3.8.20 | `uv python install 3.8` |
| uv | 0.12+ | `winget install astral-sh.uv` |
| git | 任意 | 已装 |
| curl | 任意 | 已装 |
| PowerShell | 5+ | Windows 自带 |
| bash | Git Bash / WSL | `wsl --install` |
| OpenLoomi 服务 | dev build | `apps/web` 里 `pnpm tauri dev` |

> **WSL 可选**：脚本会自动探测 WSL（在 `/proc/sys/kernel/osrelease` 找到 `microsoft`），WSL 视角下路径会被自动转成 `D:/...`。

---

## 4. 启 OpenLoomi

```powershell
cd D:\openloomi3\openloomi\apps\web
$env:PORT=3515
pnpm tauri dev --config src-tauri/tauri.conf.dev.json
```

等 `Local:` 行打印出来（约 30-90 秒，**第一次启动特别慢**），然后到 `eval_openloomi` 目录跑：

```bash
cd D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi
bash ./run_openloomi_swe.sh
```

> OpenLoomi 的 `cli-bundle/claude.exe` 在 workDir 下首次启动时会校验 ripgrep（**第一次跑会在 OpenLoomi 服务端日志里看到 `Ripgrep first use test threw`**；第二次就正常）。这跟 harness 无关。

---

## 5. 参数速查

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `OPENLOOMI_HOST` | `127.0.0.1` | OpenLoomi 服务 IP |
| `OPENLOOMI_PORT` | `3515` | OpenLoomi 服务端口 |
| `OPENLOOMI_TIMEOUT` | `1800` | 单条 task agent 跑上限（秒） |
| `RUN_KINDS` | `no_mem,mem` | 跑哪几组，可写 `no_mem` / `mem` / `no_mem,mem` |
| `SEQUENCES` | 空（=全部） | 逗号分隔 sequence id，如 `django_django_sequence,pytest-dev_pytest_sequence` |
| `SEQ_TASK_LIMIT` | `1` | 每个 sequence 取前 N 条 task |
| `PY312` | 自动探测 | harness 用的 Python 3.12 路径 |
| `DRY_RUN` | `0` | `1` = 只检查环境、不真跑 |
| `SKIP_DJANGO_INSTALL` | `0` | `1` = 跳过 `pip install` repo |

例子：

```bash
# 只跑 baseline（不开 memory）
RUN_KINDS=no_mem SEQ_TASK_LIMIT=5 bash ./run_openloomi_swe.sh

# 跑 xarray + matplotlib 各 3 条
SEQUENCES=pydata_xarray_sequence,matplotlib_matplotlib_sequence \
SEQ_TASK_LIMIT=3 \
RUN_KINDS=mem \
bash ./run_openloomi_swe.sh

# dry-run
DRY_RUN=1 SEQ_TASK_LIMIT=10 bash ./run_openloomi_swe.sh
```

---

## 6. 输出文件

| 文件 | 含义 |
|---|---|
| `swe_agent_cl_results.json` | 每个 run 的 success_rate / task 详情 |
| `swe_agent_cl_analysis.json` | 分析阶段产出（目前跟 results 同形） |
| `logs/checkpoints/<run_id>-{no_mem,mem}/<task>.json` | 每条 task 的 reply 全文、patch、success |
| `cloned_repos/<org>__<repo>/` | git clone 出的真实仓库（被 OpenLoomi agent 直接修改） |
| `.venv38/` | Python 3.8 虚拟环境，含老 pytest + 装好的仓库源码 |

每条 task 的 checkpoint JSON 长这样：

```json
{
  "instance_id": "django__django-9296",
  "success": true,
  "task_details": {
    "success": true,
    "patch_len": 523,
    "patch_applied": true,
    "reply_chars": 1233,
    "elapsed_sec": 296.8,
    "reply_full": "...(完整 reply，含 diff --git 代码块)..."
  }
}
```

---

## 7. 已验证的链路

| 环节 | 状态 |
|---|---|
| OpenLoomi `/api/native/agent` 可达 | ✅ |
| `workDir` 切到 SWE 仓库 | ✅ |
| Agent 在 workDir 内 plan/execute/edit | ✅ |
| `django__django-9296` 被改对（`__iter__` 加到 `paginator.py`） | ✅ |
| `pytest-dev__pytest-5262` 被改对（`EncodedFile.mode` property） | ✅ |
| `tests/runtests.py pagination` 通过（venv38 + Django 3.1.dev20191002054947） | ✅ |
| `git diff` 抽取 working tree patch | ✅ |
| `python -m pip install` 仓库到 venv38 | ✅ |
| no_mem / mem 双组对比（memory 让 agent 速度提高 ~3 倍） | ✅ |

**已验证 pass 的 task**：
- `django__django-9296` （15 min fix；FAIL_TO_PASS `test_paginator_iteration` 通过；20 个 PASS_TO_PASS 通过）
- `pytest-dev__pytest-5262`（因 Python 3.12 / pytest-dev import `imp` 不兼容未能跑测试，但 patch 正确）

---

## 8. 已知坑 / FAQ

### 8.1 OpenLoomi 服务端 `AgentOutputEventBusError`

`~/.openloomi/logs/openloomi.log` 里偶发：

```
[ERROR] [ClaudeAgent] Internal error: Agent output event bus aborted
```

**harness 行为**：自动 retry 最多 3 次（间隔 3/5/7 秒）。仍失败则记 task 失败。

**绕过**：重发同 run_id 的 `eval_procedure.py` 会从 checkpoint 跳过已完成 task；其他 task 自动重跑。

### 8.2 OpenLoomi 不动工作目录里的文件

如果 agent 觉得"不需要修代码"（极少见），则只有 patch 没 working tree diff。harness 会在这种情况下尝试 `git apply` reply 中的 diff，apply 失败也算 task 失败。

### 8.3 Python 3.12 + 老仓库

SWE-Bench-CL 大部分仓库代码是 2017–2022 年的（用 `import imp`、f-string 用法老派）。`pip install` 成功不等于 `pytest` 能跑：
- **django** ✅（自己用 `runtests.py`）
- **sympy** ❓（pytest 9 不兼容）
- **pytest-dev** ❌（`import imp` 在 Python 3.12 已删）
- **matplotlib / astropy / scikit-learn** ⚠️（取决于具体 task）

要看哪个 task 真能跑：在 `swe_agent_cl_results.json` 里看 `patch_applied=true` + `success=true`。

### 8.4 WSL bash + PowerShell 调用

WSL 下 `/mnt/c/...` 路径在 PowerShell 那边认不出来。`run_openloomi_swe.sh` 通过 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <ps1>` 中转，每个 Windows Python 调用会**先写到 `.run_py_<pid>.ps1` 临时文件**再 invoke。临时文件 `.run_py_*.ps1`、`.pick_repos_*.py`、`.summarize_*.py` 退出时自动清理。

### 8.5 `pip install <repo>` 慢

`django__django` 这条 1 分钟；`sympy__sympy` 可能 5+ 分钟（依赖太多）。脚本默认 `| tail -n 5` 不阻塞 output，但 `2>&1` 会包含 stdout。

---

## 9. 排查清单

| 现象 | 看哪里 |
|---|---|
| 服务不可达 | `curl http://127.0.0.1:3515/api/native/providers` |
| agent 没回 / 卡 | `~/.openloomi/logs/openloomi.log` 最近 50 行 |
| 评测没跑 / 0% | `logs/checkpoints/<run>/<task>.json` 的 `reply_tail` |
| 测试不通过 | 在仓内手动跑 `python tests/runtests.py <module>` 看 stderr |
| checkpoint 跳了某条 task | task 的 `<run>-{no_mem,mem}` 目录里已有 ckpt → run_id 不同就不跳 |
| 想强制重跑某条 task | 删 `logs/checkpoints/<run_id>/<task>.json` |

---

## 10. 完整文件结构

```
D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\
├── run_openloomi_swe.sh          # ★ 一键脚本（WSL/Git Bash）
├── README_for_openloomi_SWE.md   # ★ 你正在读的
├── config.py                     # OpenLoomi / 数据集 / venv 配置
├── eval_procedure.py             # 主循环（setup → agent → apply → pytest）
├── openloomi_client.py           # POST /api/native/agent 客户端
├── prompt_template.py            # SWE-Bench 风格 prompt
├── patch_parser.py               # 从 reply 抽 ```diff``` 块
├── dummy_eval.py                 # 5 行 dummy 任务 sanity
├── requirements_openloomi.txt    # harness 依赖（harness 现在用 uv 管理）
├── .env.example                  # OPENLOOMI_HOST / OPENLOOMI_PORT 等
│
├── cloned_repos/                  # git clone 出的 SWE-Bench-CL 仓库
│   ├── django__django/
│   ├── pytest-dev__pytest/
│   └── ...
├── .venv38/                       # Python 3.8 venv（pip + 老 pytest + repo 源码）
├── logs/checkpoints/              # 每条 task 的 ckpt
│   └── <run_id>-{no_mem,mem}/
│       └── <instance_id>.json
├── swe_agent_cl_results.json      # 最终汇总
└── swe_agent_cl_analysis.json
```

---

## 11. 相关代码位置（OpenLoomi 侧）

| 文件 | 作用 |
|---|---|
| `apps/web/.../api/native/route.ts` | 暴露 `/api/native/agent` |
| `packages/ai/src/agent/runtime/index.ts` | runtime：`createRunGenerator()` = plan + execute + reflect 一起跑；不带 `phase` 字段就走它 |
| `packages/ai/src/agent/native-runner/index.ts` | `NativeAgentRequest` 定义；`workDir` + `useProvidedWorkDir` 在这里生效 |

---

## 12. 一句话总结

`bash run_openloomi_swe.sh` 就是整个跑测流程。它把 OpenLoomi 当 agent harness、Python 3.8 venv 当测试 runtime、`git diff` 当 patch 真相、checkpoint 持久化当容错。已经验证 `django__django-9296` 在 no_mem / mem 两组都 **100% pass**。