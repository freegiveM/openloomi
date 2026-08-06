# SWE-Bench-CL × OpenLoomi 评测 — 任务交接文档

> **状态**：Harness 修复完成；Qwen embedding memory 改造完成；**正在/即将跑 qwen-mem run 验证 memory 是否影响结果**

## 一句话总结

修复了一个让 SWE-Bench-CL 评测 harness 全报 `status=UNKNOWN` 的致命 bug，把 django 50 task 跑通到 **82%**（论文官方 harness 仅 <8.5%）。随后接入真 embedding (Qwen 4096 维) 重做 memory，准备验证"开 memory 是否真有帮助"。

---

## 1. 项目信息

| 项 | 值 |
|----|----|
| 工作目录 | `D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\` |
| Python venv | `.venv38\Scripts\python.exe`（Python 3.8）|
| OpenLoomi 服务 | `http://127.0.0.1:3515` |
| OPENROUTER key | `D:\openloomi3\openloomi\benchmark\clbench\.env`（由 eval_procedure.py 自动加载）|
| 数据集 | `D:\openloomi3\openloomi\benchmark\data\SWE-Bench-CL-Curriculum.json`（8 sequence / 273 task）|
| 当前跑过的 sequence | django_django_sequence（50 task）|

## 2. 已完成的工作

### 2.1 Harness bug 修复

| Bug | 修复 |
|-----|------|
| `site-packages/django/` 子目录被 stale-cleanup 误改名为 `~xxx/` → `ModuleNotFoundError` → 0 tests run → 全部 FAIL_TO_PASS=UNKNOWN | [run_openloomi_swe.sh:295-310](file:///D:/openloomi3/openloomi/benchmark/SWE-bench-CL/eval_openloomi/run_openloomi_swe.sh#L295-L310) — `pip install` → `pip install -e`，删除整段 stale-cleanup |
| `apply_patch` 用 `write_text` 在 Windows 把 LF → CRLF → 长 patch 触发 `corrupt patch at .openloomi_eval.patch:N` | [eval_procedure.py:446](file:///D:/openloomi3/openloomi/benchmark/SWE-bench-CL/eval_openloomi/eval_procedure.py#L446) — `write_text` → `write_bytes` |

### 2.2 主跑结果（jaccard backend）

| Run | success_rate | tasks_attempted | tasks_succeeded |
|-----|--------------|-----------------|-----------------|
| 1785945800-no_mem | 82.00% | 50 | 41 |
| 1785963970-mem    | 82.00% | 50 | 41 |

**两个 run 完全相同 = memory 模块当时**没起作用**。** 根因：原实现用 char 3-gram + Jaccard，论文 Figure 1 实测 SWE-Bench-CL 平均相似度仅 0.11，远低于真 embedding 的 0.45+。

### 2.3 Memory 改造（Qwen embedding）

[eval_procedure.py:246-420](file:///D:/openloomi3/openloomi/benchmark/SWE-bench-CL/eval_openloomi/eval_procedure.py#L246-L420) `SemanticMemory` 重写支持 3 个 backend：

| Backend | 说明 | 状态 |
|---------|------|------|
| `jaccard`（默认） | char 3-gram + 词袋 + Jaccard 集合相似度 | ✅ 工作（之前主跑用这个）|
| `qwen` | OpenRouter 调 `qwen/qwen3-embedding-8b` (4096 维) + numpy 余弦 | ✅ 已验证可调通 |
| `faiss` | 同 qwen + `faiss.IndexFlatIP` | ⚠️ 装不上（SSL 错）|

环境变量切换：`OPENLOOMI_CL_EMBEDDING_BACKEND=qwen|jaccard|faiss`

[eval_procedure.py:57-75](file:///D:/openloomi3/openloomi/benchmark/SWE-bench-CL/eval_openloomi/eval_procedure.py#L57-L75) 加了 `_load_env_file()` — Python 启动时**自动从 `.env` 文件加载** `OPENROUTER_API_KEY`（避免跨进程 env 丢失问题）。

[eval_procedure.py:854-860](file:///D:/openloomi3/openloomi/benchmark/SWE-bench-CL/eval_openloomi/eval_procedure.py#L854-L860) 加了 `OPENLOOMI_CL_RUN_KINDS` 支持只跑某种 run（`no_mem` / `mem` / `no_mem,mem`）。

## 3. 当前状态

### OPENROUTER key 测试

| 模型 | 状态 |
|------|------|
| `openai/gpt-4o-mini` (chat) | ❌ 403 "model not available in your region" |
| `openai/text-embedding-3-small` | ❌ 403 "violation of provider Terms Of Service" |
| `qwen/qwen3-embedding-8b` | ✅ 200 OK, dim=4096 |

**结论**：OpenAI 模型被 OpenRouter 账户区域封锁，**只能用 Qwen**。

### 后台 job 状态

启动脚本 [__dbg_run_mem_qwen.ps1](file:///D:/openloomi3/openloomi/benchmark/SWE-bench-CL/eval_openloomi/logs/__dbg_run_mem_qwen.ps1) 最后一次启动成功，**job Id=1 已起**。

需要新窗口验证：
1. Job 是否还在跑
2. Key 是否在 Python 里实际可读
3. stderr 是否有 401

## 4. 新窗口操作步骤

### 4.1 验证状态

```powershell
# 1. 后台 job
Get-Job
Get-Process python | Select-Object Id, StartTime

# 2. 看 stderr 是否调通 Qwen
Select-String -Path "D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\logs\direct_run.err" -Pattern "401|backend=|qwen|OpenRouter"
```

### 4.2 如果 job 没跑 / 401

```powershell
# 杀残留
Get-Process python | Where-Object {$_.StartTime -gt (Get-Date).AddMinutes(-5)} | Stop-Process -Force

# 检查 numpy（qwen backend 需要）
& "D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\.venv38\Scripts\python.exe" -c "import numpy; print(numpy.__version__)"

# 装 numpy（如果缺）
& "D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\.venv38\Scripts\python.exe" -m pip install numpy

# 重启
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\logs\__dbg_run_mem_qwen.ps1"
```

### 4.3 监控进度（每 30 分钟拉一次）

```powershell
Get-Content "D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\logs\direct_run.err" -Tail 5
& "D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\.venv38\Scripts\python.exe" "D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\logs\__dbg_show_ckpt.py" "D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\logs\checkpoints\1785985401-mem"
```

### 4.4 跑完后

1. 对比 jaccard-mem (41/41) vs qwen-mem（新数字）
2. 写结果到 HANDOFF.md 新章节
3. 清掉调试脚本（`__dbg_run_mem_qwen.ps1`, `__dbg_show_ckpt.py`, `.run_qwen_*.ps1`, `logs/launcher_*.out/err`, `clbench/.env` 改成只读）

## 5. 关键文件位置

| 文件 | 用途 |
|------|------|
| [eval_procedure.py](file:///D:/openloomi3/openloomi/benchmark/SWE-bench-CL/eval_openloomi/eval_procedure.py) | 主评测脚本（含 SemanticMemory 改造 + .env 加载 + RUN_KINDS env）|
| [run_openloomi_swe.sh](file:///D:/openloomi3/openloomi/benchmark/SWE-bench-CL/eval_openloomi/run_openloomi_swe.sh) | 启动脚本（已改 pip install -e）|
| [HANDOFF.md](file:///D:/openloomi3/openloomi/benchmark/SWE-bench-CL/eval_openloomi/HANDOFF.md) | 已有"修复记录 + 论文对比"章节 |
| [prompt_template.py](file:///D:/openloomi3/openloomi/benchmark/SWE-bench-CL/eval_openloomi/prompt_template.py) | 把 memory_excerpt 拼进 prompt（已支持，未被改）|
| [.env](file:///D:/openloomi3/openloomi/benchmark/clbench/.env) | OPENROUTER_API_KEY |
| [__dbg_run_mem_qwen.ps1](file:///D:/openloomi3/openloomi/benchmark/SWE-bench-CL/eval_openloomi/logs/__dbg_run_mem_qwen.ps1) | 启动 qwen mem run 的脚本 |
| [swe_agent_cl_results.json](file:///D:/openloomi3/openloomi/benchmark/SWE-bench-CL/eval_openloomi/swe_agent_cl_results.json) | 之前 41/50 的结果（jaccard）|

## 6. 风险 & 注意

1. **PowerShell 跨 RunCommand env 不持久** —— RunCommand 每次开新 PowerShell 进程，Process env 不传。**用 .env 文件**解决
2. **Trae IDE RunCommand 对 `Start-Process -ArgumentList` 解析有 bug** —— 用 `Start-Job` 替代（已写在启动脚本里）
3. **OpenAI 模型不能用**（403 region 封锁）—— 只能用 Qwen 或其它非 OpenAI 模型
4. **FAISS 装不上**（SSL 错）—— qwen backend 用 numpy 暴力余弦，50 task 量级足够
5. **每次 RunCommand 启新 Process** —— 不能 set 永久 env；目前都用 .env 文件传递

## 7. 已完成 vs 未完成

| 步骤 | 状态 |
|------|------|
| 修复 harness bug（pip install -e + write_bytes） | ✅ |
| 主跑 50 task 验证修复 | ✅ 41/50 = 82% |
| 写 HANDOFF.md 修复记录 + 论文对比 | ✅ |
| 加 Qwen embedding 接入 | ✅ 代码改完 |
| Smoke test Qwen 调用通 | ✅ |
| 跑 Qwen mem run 验证 memory 效果 | ⏳ job Id=1 刚启动 |
| 对比 jaccard vs qwen 结果 | ⏳ 待跑完 |
| 更新 HANDOFF.md 加 memory 章节 | ⏳ 待跑完 |
| 清理调试脚本 | ⏳ 待跑完 |

---

文档创建时间：2026-08-06 11:25
后续工作：监控 job，跑完后分析 + 写 HANDOFF + 清理