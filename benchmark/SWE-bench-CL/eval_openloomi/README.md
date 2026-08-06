# eval_openloomi — SWE-Bench-CL on OpenLoomi Harness

> **与官方 `agents-never-forget` 的 `eval_v3_swe-agent/` 同目录同命名风格；仅替换** LLM 调用为 **OpenLoomi 本地 `/api/native/agent`**，其余评测骨架与 v3 几乎一致。

## 之前的错误

第一版把 OpenLoomi 当 LLM 用了——给 OpenLoomi 发了 4 条 LLM 角色 prompt（planner/executor/reflector/solver），OpenLoomi 完全没有跑它的 base agent / MCP tools / skills。**这一版修正后**：每条 SWE-Bench-CL task **只调一次** `/api/native/agent`，让 OpenLoomi 自己的多步 agent（plan → execute → reflect → tool calls）跑完整流程。

## 目录结构

```
D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\
├── README.md                       # 本文
├── requirements_openloomi.txt      # 依赖清单（少于官方 requirements.txt）
├── .env.example                    # 环境变量示例
├── config.py                       # OpenLoomiConfig + FAISS 配置 + 路径配置
├── openloomi_client.py             # ★ POST /api/native/agent 客户端（含 SSE 流还原）
├── prompt_template.py              # ★ 唯一一处 prompt 模板
├── patch_parser.py                 # ★ 从 agent 回复抠 ```diff``` 块
├── eval_procedure.py               # ★ 主循环：setup_repository → agent → apply_patch → pytest
├── dummy_eval.py                   # 用官方 dummy 数据冒烟测试
└── cloned_repos/                   # git clone 出来的本地仓库缓存（已 .gitignore）
```

## 章节与官方 v3_swe-agent 对照

| 官方 v3 § | 本目录实现 | 备注 |
|---|---|---|
| §1 Setup | 文件顶部 + config.py | |
| §2 Load dataset | `load_swe_bench_cl()` | |
| §2.5 setup_repository | `setup_repository()` | **与官方原文一致**：git clone + reset --hard + clean -fdx |
| §3 Model Configuration | ★ **替换** OpenLoomiConfig | 传 `workDir`、`permissionMode="dontAsk"` 给 `/api/native/agent` |
| §4 SWE-agent Tools (手写 ACI) | ★ **删除** | OpenLoomi 自带 bash / read / edit / grep / glob |
| §5 Semantic Memory | 精简版 `SemanticMemory` | FAISS + sentence-transformers（默认离线、零外部依赖） |
| §6 LangGraph 5-node | ★ **删除** | 单层 for 循环；每 task 单次 `/api/native/agent` |
| §7 Evaluation | `apply_patch` + `run_pytest` + `check_test_outcomes` | 与官方原文一致 |
| §8 Experiments | `SWEAgentCLEvaluator` + memory × no-memory 双组对比 | **顺序先跑 no_mem 再跑 mem**（避免污染） |
| §9 Results Analysis | `analyze_results()` | |

## 与官方 v3 调用粒度的核心差异

```
官方 v3 论文：                  本目录：
  每条 task 调 5 次 LLM           每条 task 调 1 次 /api/native/agent
  ├─ planner 输出 AgentPlan       OpenLoomi 自带的 base agent 自行 plan → execute
  ├─ executor ↔ tool_node         OpenLoomi 自己跑 bash/read/edit/grep/glob
  ├─ reflector 输出 Reflection    OpenLoomi 内置 self-reflection
  └─ solver 输出 AgentSolution    OpenLoomi 最终回复包含 ```diff``` 块
```

OpenLoomi 是完整的 coding agent（base agent + MCP tools + skills），所以让 **整条 task 作为一个会话一次性跑完**，比手动拆 5 个 role 更真实。

## 快速开始

### 1. 启动 OpenLoomi 服务

```powershell
cd D:\openloomi3\openloomi\apps\web
$env:PORT=3515
pnpm.cmd tauri dev --config src-tauri/tauri.conf.dev.json
```

确认 `http://127.0.0.1:3515/api/native/providers` 可访问。

### 2. 装依赖

```powershell
cd D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi
pip install -r requirements_openloomi.txt
copy .env.example .env
```

### 3. 冒烟测试（推荐先用 dummy 数据）

```powershell
python dummy_eval.py
```

期望：
- 启动时 `validate_openloomi_endpoint()` 探测 `/api/native/providers` 通过
- 1 个 sequence × 1 个 task
- 等待 OpenLoomi agent 跑完
- 输出 `dummy_results.json`

### 4. 真实数据集跑测

```powershell
python eval_procedure.py
```

自动跑两轮：
1. **`no_mem`** (baseline)：单纯按时间序跑
2. **`mem`** (FAISS semantic memory)：每 task 完成后把 `(problem, diff, success)` 写进 FAISS；下条 task 的 prompt 会注入 top-3 相关经验

结果落到：
- `swe_agent_cl_results.json` —— 全量结果
- `swe_agent_cl_analysis.json` —— summary 表（per-sequence success rate）

## 环境变量

```bash
# OpenLoomi
OPENLOOMI_BASE_URL=http://127.0.0.1:3515
OPENLOOMI_PROVIDER=claude         # claude / codex / hermes / ...
OPENLOOMI_TIMEOUT=1200            # 秒；20 分钟
OPENLOOMI_PLATFORM=swe-bench-cl  # 写到 OpenLoomi session.platform

# 测试命令
OPENLOOMI_CL_TEST_COMMAND="python -m pytest -x --tb=short -q"

# Memory
OPENLOOMI_CL_EMBEDDING=sentence-transformers/all-MiniLM-L6-v2
OPENLOOMI_CL_MEMORY_K=3
OPENLOOMI_CL_MEMORY_MAX_CHARS=6000

# 行为
OPENLOOMI_CL_TASK_LIMIT=0        # 0 = 跑全部；>0 表示每 sequence 跑前 N 条
OPENLOOMI_CL_SEQUENCE_IDS=django__django__sequence,sympy__sympy__sequence
```

## 设计要点

1. **`/api/native/agent` 自动 cd 到 SWE-Bench 仓库**：`workDir` + `useProvidedWorkDir: true` 让 OpenLoomi 把它的 cwd 切到 `setup_repository()` 拿回来的那个干净目录，避免在 OpenLoomi 默认 `~/.openloomi/...` 跑代码。
2. **权限自动放行**：`permissionMode: "dontAsk"` —— agent 跑测试时遇到 bash 不会卡在弹窗上。
3. **每条 task 调一次**：因为 OpenLoomi 是会话式 agent，频繁切 session 会丢上下文。让它内部多步跑完，再用 `extract_patch(reply)` 抠 `\`\`\`diff ... \`\`\`` 块。
4. **git clean -fdx**：上一条 task 跑完后，仓库可能被 agent 留下 untracked 文件；下一条任务前必须 `git reset --hard <base_commit> + git clean -fdx` —— 与官方 v3 完全对齐。
5. **测试失败的兜底**：`extract_patch` 三段式（```diff → 任意 ``` ``` → 裸 diff --git），最后退到 `NO_PATCH_AVAILABLE` 判定。

## 已知风险与缓解

| 风险 | 缓解 |
|---|---|
| agent 把 diff 跟解释混在一起，`extract_patch` 抓错 | 三段式匹配；测试后可读 `reply_tail` 字段反查 |
| 多条 sequence 时 git clone 占盘 | 复用同一仓到不同 commit 路径（`./cloned_repos/{repo}/`），仅当 commit 不同时才需要重新 fetch |
| Memory 嵌入模型首次跑会下载（~80 MB） | 把 sentence-transformers 模型 cache 到 `~/.cache/huggingface` |
| 测试运行时间长（pytest 加载 django 几十秒） | 调小 `--tb=line` 或加 `-x`（fail-fast），已在默认配置里加 |
| OpenLoomi 把仓库破坏到 `setup_repository()` 也救不回 | 在 prompt 里明令"不 commit、不动 test 文件、最小改动"；事后 git status + diff 检查可在结果 JSON 看到 `patch_len` |

## 与 jobbench / clbench 的对比

| 维度 | jobbench / clbench (已有) | eval_openloomi (本目录) |
|---|---|---|
| 调用 | `/api/native/agent` 单次 | `/api/native/agent` 单次（同样接口） |
| 数据 | HF JSONL → 本地 JSON | SWE-Bench-CL-Curriculum.json (8 sequences × 273 tasks) |
| 评测机制 | LLM judge / 字符串相似 | **apply diff + 跑 pytest + 检查 FAIL_TO_PASS / PASS_TO_PASS** |
| 沙箱 | 不需要 | **`workDir` + git clean -fdx + 真实测试** |
| 状态 | 单轮任务 | **连续学习序列**（memory × no-memory 双组对比） |
