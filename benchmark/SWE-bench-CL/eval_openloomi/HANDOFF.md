# SWE-Bench-CL × OpenLoomi 评测项目 — 交接文档

## 项目位置

```
D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\
├── HANDOFF.md                       ← 你正在读
├── README_for_openloomi_SWE.md      ← 架构说明（之前生成）
├── run_openloomi_swe.sh             ← 通用脚本（任何 sequence 都能跑）
├── run_django_full.sh               ← 专用脚本（跑 django 全 50 task）
├── config.py                        ← OpenLoomi / 数据集 / venv 配置
├── eval_procedure.py                ← 主循环（★ 已被改 bug fix）
├── openloomi_client.py              ← OpenLoomi HTTP client（★ 已被改 bug fix）
├── prompt_template.py
├── patch_parser.py
├── eval_openloomi_swe.py            ← 旧版（已废弃）
├── .venv38/                         ← Python 3.8 venv（★ 已手动清 stale files）
├── cloned_repos/django__django/     ← git clone 出的 django 仓
├── logs/
│   ├── checkpoints/                 ← 每 task 的 ckpt（当前空，已删）
│   ├── django_full_<时间戳>.log     ← 老 log（已清）
│   ├── django_full.lock / .pid      ← 防重入锁 / PID
│   ├── direct_run.out / .err        ← 当前跑测的实时 stdout / stderr
│   └── run_stdout.log / run_stderr.log
└── swe_agent_cl_*.json              ← 最终结果（当前已删，待生成）
```

## 数据集

```
D:\openloomi3\openloomi\benchmark\SWE-bench-CL\data\SWE-Bench-CL-Curriculum.json
```

- 8 sequence / 273 task：
  - django_django_sequence (50)
  - sympy_sympy_sequence (50)
  - sphinx-doc_sphinx_sequence (44)
  - matplotlib_matplotlib_sequence (34)
  - scikit-learn_scikit-learn_sequence (32)
  - astropy_astropy_sequence (22)
  - pydata_xarray_sequence (22)
  - pytest-dev_pytest_sequence (19)

## OpenLoomi 服务

- URL: `http://127.0.0.1:3515/api/native/...`
- 启动命令（在 `D:\openloomi3\openloomi\apps\web` 下）：
  ```powershell
  cd D:\openloomi3\openloomi\apps\web
  $env:PORT=3515
  pnpm tauri dev --config src-tauri/tauri.conf.dev.json
  ```

## 已经做了的事（按时间顺序）

### 1. 通用脚本 `run_openloomi_swe.sh`
- 5 步：preflight → venv → 装 repo → 跑 eval → summarize
- 自动检测 WSL + 把 `/mnt/...` 转 Windows 路径
- 所有 Windows python 调用走 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <ps1>`（不要用 cmd.exe 被 PowerShell 拦）

### 2. Django 全跑脚本 `run_django_full.sh`
- 锁文件防重入
- 默认 `SEQUENCES=django_django_sequence`, `SEQ_TASK_LIMIT=0`, `RUN_KINDS=no_mem,mem`

### 3. README 文档
`README_for_openloomi_SWE.md` —— 架构、参数速查、已知坑、文件结构

### 4. 三次 bug fix（关键）

#### Bug 1: `run_pytest` 用 `shell=True` + PowerShell
- **症状**：`status=UNKNOWN` 持续出现，所有 task fail
- **原因**：PowerShell 把 `python.exe` 当 cmdlet，把 `"..."` args 当 ScriptBlock
- **修复**：`eval_procedure.py` 的 `run_pytest()` 改用 `subprocess.run(args, shell=False)` + `shlex.split(command)` 拆 list

```python
# eval_procedure.py run_pytest (after fix)
import shlex
def run_pytest(repo_path, command):
    eval_py = EVAL_PYTHON
    args = shlex.split(command) if command else []
    if eval_py and args and args[0] == "python":
        args[0] = eval_py
    try:
        p = subprocess.run(args, shell=False, cwd=str(repo_path),
                           capture_output=True, text=True, timeout=900)
        return p.returncode == 0, p.stdout, p.stderr
    ...
```

#### Bug 2: site-packages stale files
- **症状**：`test_rc=True, status=UNKNOWN` —— runtests.py 启动 import error
- **原因**：`pip install django__django` (setup.py install) 留下了 731 个 stale .py 文件
  - 关键 stale：`django/contrib/admin/templatetags/admin_static.py`（引用 `RemovedInDjango30Warning`，但 base_commit 里 deprecation.py 没有这个 class）
  - 触发链：`runtests.py <module>` 触发 system check → check `django.contrib.admin` → import `admin_static.py` → `ImportError` → 0 tests run → status=UNKNOWN
- **修复**：
  1. 手动清理（已执行）：删除 site-packages 里 base_commit 中不存在的所有 .py 文件
  2. .sh 加自动 cleanup（见 Bug 3）

清理脚本（手动用过）：
```python
import os
sp = r'D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\.venv38\lib\site-packages\django'
wt = r'D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\cloned_repos\django__django\django'
removed = 0
for root, dirs, files in os.walk(sp):
    rel = os.path.relpath(root, sp)
    wt_dir = os.path.join(wt, rel)
    for f in files:
        if not f.endswith('.py'): continue
        if '__pycache__' in root: continue
        if not os.path.exists(os.path.join(wt_dir, f)):
            os.remove(os.path.join(root, f))
            removed += 1
print(f'removed {removed} stale files')
```

#### Bug 3: openloomi_client.py stream handling
- **症状**：OpenLoomi 偶尔 `AgentOutputEventBusError`，harness 在 `resp.text` 等 EOF 死等 3 小时
- **修复**：用 `stream=True` + `iter_content(chunk_size=None)` + 自己 read；30 分钟没数据自动 abort

```python
# openloomi_client.py call_agent (after fix)
try:
    resp = requests.post(url, json=body, stream=True, timeout=(60, 60))
    body_chunks = []
    deadline = started + cfg.timeout
    last_data_at = time.time()
    for chunk in resp.iter_content(chunk_size=None, decode_unicode=True):
        if chunk:
            body_chunks.append(chunk)
            last_data_at = time.time()
        if time.time() > deadline:
            resp.close()
            raise TimeoutError(f"OpenLoomi request exceeded {cfg.timeout}s total")
        if time.time() - last_data_at > 1800:  # 30 分钟静默 = 死
            resp.close()
            raise TimeoutError(f"OpenLoomi stream silent for 1800s (likely dead); abort")
    resp_body = "".join(body_chunks)
```

### 5. `.sh` 加 stale cleanup + 改进 error handling
```bash
# run_openloomi_swe.sh 在 step 3 pip install 之后
PY_SCRIPT="${HARNESS_DIR}/.cleanup_stale_$$.py"
cat > "${PY_SCRIPT}" <<PYEOF
import os
top_pkg = "${repo##*/}".split("-")[0].replace("-", "_").lower()
sp_top = r"${PY38_NATIVE%python.exe}Lib/site-packages/" + top_pkg
wt_top = r"${REPO_DIR_NATIVE}/${repo##*/}/" + top_pkg
sp_top = sp_top.replace("/", "\\\\")
wt_top = wt_top.replace("/", "\\\\")
removed = 0
if os.path.isdir(sp_top) and os.path.isdir(wt_top):
    for root, dirs, files in os.walk(sp_top):
        rel = os.path.relpath(root, sp_top)
        wt_dir = os.path.join(wt_top, rel)
        for f in files:
            if not f.endswith(".py"): continue
            if "__pycache__" in root: continue
            if not os.path.exists(os.path.join(wt_dir, f)):
                os.remove(os.path.join(root, f))
                removed += 1
print(f"removed {removed} stale files from {top_pkg}")
PYEOF
# 调 Windows 端 venv38 python 通过 powershell（bash 直接调 /mnt/d/...python.exe 会 hang）
PY_SCRIPT_NATIVE="$(to_windows_path "${PY_SCRIPT}")"
PY38_NATIVE="$(to_windows_path "${PY38_BIN}")"
printf '& "%s" "%s"\n' "${PY38_NATIVE//\'/''}" "${PY_SCRIPT_NATIVE//\'/''}" > "${PS_TMP}"
PS_TMP_NATIVE="$(to_windows_path "${PS_TMP}")"
"${PS}" "${PS_ARGS[@]}" "${PS_TMP_NATIVE}" 2>&1 | tail -n 3 \
    || log "    [WARN] stale-file cleanup failed"
rm -f "${PY_SCRIPT}"
```

## 当前状态（重要！）

### 跑了多次，**所有尝试的 task 都没真正通过测试**

**最终 root cause 仍未完全解决**：

- ✅ Bug 1, 2, 3 已修
- ❌ **最后一个问题**：`apply_patch` 报告 `corrupt patch at line 15`，但 git apply --check rc=0（手动验证 OK）
- ❌ harness 报 `status=UNKNOWN` 即使测试应该跑了

**关键观察**（来自最新一轮 `run_id 1785941660-no_mem` task 1 = django__django-9296）：

- agent patch 内容看起来完全正确
- 但 harness 调用 `apply_patch` 失败：`error: corrupt patch at .openloomi_eval.patch:15`
- working tree diff 显示 **113 files changed** —— 这是前一个 task (task 10097 = aggregation) 改的，不是 9296 的！
- **意味着**：`setup_repository` 没正确 reset，或者有其他 eval_procedure 进程在跑改文件

### 进程状态

- 我手动 Stop-Process 杀了 python 进程，但 **bash 进程（PID 11）杀不掉**
- 可能还有 eval_procedure 进程在跑，**建议在动手前先彻底检查**
- OpenLoomi 服务应该还在跑

### 直接启动 eval_procedure.py 的方法

**绕过 bash 直接 PowerShell 启动**（bash 在 PowerShell 环境不可靠）：

```powershell
$env:OPENLOOMI_CL_EVAL_PYTHON='D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\.venv38\Scripts\python.exe'
$env:OPENLOOMI_CL_TASK_LIMIT='0'
$env:OPENLOOMI_CL_SEQUENCE_IDS='django_django_sequence'
$env:OPENLOOMI_TIMEOUT='1800'
Start-Process -FilePath 'D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\.venv38\Scripts\python.exe' `
  -ArgumentList @('D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\eval_procedure.py') `
  -RedirectStandardOutput 'D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\logs\direct_run.out' `
  -RedirectStandardError 'D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\logs\direct_run.err' `
  -WindowStyle Hidden `
  -WorkingDirectory 'D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi' `
  -PassThru | Out-Null
```

## 新窗口要继续做的任务

### 优先级 1：先把"为什么 apply_patch 报 corrupt"搞清楚

最近一轮 `direct_run.err` 显示 task 1 (9296)：
```
WARNING - git apply --check failed: error: corrupt patch at .openloomi_eval.patch:15
INFO - [django__django-9296] working_tree_diff=499 chars; running tests directly
INFO - auto-selected test command: python tests/runtests.py --verbosity=2
WARNING - FAIL_TO_PASS not passed: test_paginator_iteration (pagination.tests.PaginationTests) (status=UNKNOWN)
INFO - task evaluation: test_rc=False, FAIL_TO_PASS/PASS_TO_PASS check=False
```

但**手动验证**：同样的 patch 文件 `git apply --check rc: 0`、`git apply rc: 0`、测试 21 tests pass。

**怀疑**：
1. `apply_patch` 在并发或文件系统缓存有问题
2. `extract_patch` 拿到的 patch 字符串跟手动拿到的不同（chat truncation、特殊字符）
3. **真的有另一个 python 进程在同时改 working tree**（导致 patch apply 时 working tree 已变）

**调试建议**：
```bash
# 1. 看 working tree 是不是真的脏
cd D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\cloned_repos\django__django
git status -sb
git diff --stat

# 2. 手动跑 task 1 evaluate
& 'C:\Users\32274\AppData\Local\Programs\Python\Python312\python.exe' _dbg.py
```

### 优先级 2：杀干净所有进程 + 重新跑干净

如果 working tree 是脏的，需要：
```powershell
# 杀所有 python
Get-Process python -ErrorAction SilentlyContinue | Stop-Process -Force

# 杀残留 bash
Get-Process bash -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -gt (Get-Date).AddHours(-2) } | Stop-Process -Force

# Reset django 仓
cd D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\cloned_repos\django__django
git checkout HEAD -- .

# 清 ckpt + results
Remove-Item -Recurse -Force D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\logs\checkpoints
Remove-Item D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\swe_agent_cl_*.json

# 再清 stale files（用上面 Python 脚本）

# 重新启动（用上面 PowerShell Start-Process 块）
```

### 优先级 3：如果根因是 `extract_patch` 拿到损坏 patch

考虑改 `patch_parser.py` 或 `eval_procedure.py` 让 `extract_patch` 后做 `git apply --check` 测试，发现 corrupt 就 fallback 用 `git diff` 拿 working tree。

### 优先级 4：跑测过程中监控

```bash
# 看进度
Get-Content D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\logs\direct_run.err -Tail 20

# 看哪些 task 跑过
ls D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\logs\checkpoints\1785941660-no_mem\

# 看每个 task 的真信号
ls D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\logs\checkpoints\1785941660-no_mem\*.json | ForEach-Object {
    & 'C:\Users\32274\AppData\Local\Programs\Python\Python312\python.exe' -c "import json,sys; d=json.load(open(r'$($_.FullName)',encoding='utf-8')); print(f'{\"$(\"OK\" if d[\"success\"] else \"FAIL\")\",15} patch_len={d[\"task_details\"][\"patch_len\"]} reply={d[\"task_details\"][\"reply_chars\"]}  {(r'$($_.BaseName)')}')"
}
```

## 经验教训

1. **PowerShell 不能直接 exec Windows .exe** —— 用 bash interop 或 `cmd /c` 不可靠，必须走 `powershell -File` 或 `Start-Process`
2. **WSL bash 调 Windows python.exe 会 hang** —— 必须先转 Windows 路径再通过 powershell 调用
3. **`pip install <local repo>` 会留 stale .py** —— pip 不会删掉 base_commit 没有的文件，必须手动清
4. **多进程并发改动 working tree** —— eval_procedure 进程没杀干净时，下一个 task 的 setup_repository 会看到脏 working tree
5. **`git diff` 可能跨多 file** —— 一次跑 task 后 working tree 不一定是 base_commit + 单 task diff，可能混了多个 task 的修改

---

## 修复记录（2026-08-06，已落地并验证）

### 关键结论
**交接文档里归因的"git apply 报 corrupt patch"是次要现象，不是当前阻塞问题。** 真实根因有 2 个，**且都已被修复并通过全量 50 task 验证**：

| 指标 | pre-fix | post-fix |
|------|---------|----------|
| django_django_sequence no_mem | 0/1 → 0% (卡在 ModuleNotFoundError) | **41/50 = 82.0%** ✓ |
| django_django_sequence mem  | 0/1 → 0% (同上) | **41/50 = 82.0%** ✓ |
| FAIL_TO_PASS=UNKNOWN 的根因 | 每次都因为 import 错误 0 tests run | **已消除** |
| `apply_patch` 写盘内容 | LF 转 CRLF (in_mem 668 → disk 685) | **保留原始字节** ✓ |

### 根因 #1（致命）：`.venv38/Lib/site-packages/django/` 子目录被 stale-cleanup 误改名为 `~xxx/`
- **症状**：`python tests/runtests.py ...` → `ModuleNotFoundError: No module named 'django.core'` → 0 tests run → check_test_outcomes 找不到 PASS/FAIL 行 → 全部 FAIL_TO_PASS=UNKNOWN
- **真实场景**：交接文档中"已手动清 stale files"是误导。stale cleanup 脚本**只删 .py 文件，不删目录**，留下空目录（如 `core/`, `http/`, `urls/`）。但更糟的是 venv 里的 `~ore/`, `~ttp/`, `~rls/`, `~iddleware/`, `~ispatch/`, `~in/`, `~est/`, `~iews/`, `~emplate/`, `~emplatetags/`, `~orms/`, `~onf`, `~_pycache__` 这种**被 Windows 改名**的目录（**疑似 setup.py install 安装过程中的临时备份行为**）
- **修复**：`run_openloomi_swe.sh` 改用 `pip install -e` (develop/editable 模式)。egg-link 让 venv 里的 import 直接走 cloned_repos 的 working tree，**完全不碰 site-packages 里的 django/**，stale-cleanup 整个删掉

### 根因 #2（次要）：`apply_patch()` 用 `write_text` 在 Windows 上把 LF → CRLF
- **症状**：in-mem patch 668 chars → on-disk 685 chars（多 17 字节 = 17 行 × 多 1 `\r`）
- **触发条件**：长 patch / 跨 hunk 边界时 git 算偏移失败 → `corrupt patch at .openloomi_eval.patch:N`
- **修复**：[eval_procedure.py:446-447](file:///D:/openloomi3/openloomi/benchmark/SWE-bench-CL/eval_openloomi/eval_procedure.py#L446-L447) 改成 `tmp.write_bytes(patch_content.encode("utf-8"))`，保留原始字节

### 错误的旧归因
| 旧假设（HANDOFF） | 实际状态 |
|-------------------|----------|
| 多评测进程并发 | **被否**（进程清单 0 个 python/bash） |
| `extract_patch` 拿损坏 patch | **被否**（in-mem patch has_bom/has_crlf/has_nul 全部 false） |
| reset/checkout 失败 | **被否**（test_patch 在 base_commit 下 apply OK） |
| `corrupt patch` 频繁 | **被否**（9296 这种短 patch 不会被 git 拒；9296 实际只是被 site-packages 脏所挡） |

### 修改的文件
1. [run_openloomi_swe.sh:295-310](file:///D:/openloomi3/openloomi/benchmark/SWE-bench-CL/eval_openloomi/run_openloomi_swe.sh#L295-L310) —— `pip install` → `pip install -e`，删除整段 stale-cleanup 块（约 50 行）
2. [eval_procedure.py:446](file:///D:/openloomi3/openloomi/benchmark/SWE-bench-CL/eval_openloomi/eval_procedure.py#L446) —— `write_text` → `write_bytes`（1 行）

### 一次性补救（**新机器或被污染 venv 必须跑**）
```powershell
# 1. 清空 venv38 的 site-packages 残留
Remove-Item -Recurse -Force D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\.venv38\Lib\site-packages\django
# 2. 用 develop 模式装 django（egg-link → working tree）
& D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\.venv38\Scripts\python.exe -m pip install -e D:\openloomi3\openloomi\benchmark\SWE-bench-CL\eval_openloomi\cloned_repos\django__django
```

### 经验教训（补充）
6. **不要相信"corrupt patch"是当前阻塞** —— 它只是症状，不是根因；要看 in-mem vs on-disk 的字节级差异（sha256 + len）才能定位
7. **`pip install -e` 是 SWE-Bench 这类 benchmark 的最佳实践** —— working tree 即源码，agent 改完 import 立即生效；stale-cleanup 整个不需要
8. **stale-cleanup 脚本**只删 .py 不删目录，**目录被重命名（`~xxx`）** 是 Windows 上 setup.py install 过程中的临时行为；用 `pip install -e` 后整个问题消失

## 关键文件链接

- 主脚本：[run_openloomi_swe.sh](file:///D:/openloomi3/openloomi/benchmark/SWE-bench-CL/eval_openloomi/run_openloomi_swe.sh)
- Django 专用：[run_django_full.sh](file:///D:/openloomi3/openloomi/benchmark/SWE-bench-CL/eval_openloomi/run_django_full.sh)
- eval 主循环：[eval_procedure.py](file:///D:/openloomi3/openloomi/benchmark/SWE-bench-CL/eval_openloomi/eval_procedure.py)
- OpenLoomi client：[openloomi_client.py](file:///D:/openloomi3/openloomi/benchmark/SWE-bench-CL/eval_openloomi/openloomi_client.py)
- README：[README_for_openloomi_SWE.md](file:///D:/openloomi3/openloomi/benchmark/SWE-bench-CL/eval_openloomi/README_for_openloomi_SWE.md)

## 数据集

[SWEBench-CL-Curriculum.json](file:///D:/openloomi3/openloomi/benchmark/SWE-bench-CL/data/SWE-Bench-CL-Curriculum.json)