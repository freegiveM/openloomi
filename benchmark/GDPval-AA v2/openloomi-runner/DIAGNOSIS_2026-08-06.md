# GDPval-AA v2 with OpenLoomi — 诊断与交接文档

> 接手时间：2026-08-06（Asia/Shanghai）
> 当前状态：根因已定位（OpenLoomi Bun CLI 在 `allowedTools` 字段上 stack overflow），剩下的是验证修复 + 重跑
> 下一个人：把这个文件从头看一遍，先确认 OpenLoomi API 还活着（127.0.0.1:3515），再决定要不要继续修

---

## 0. 目标与已落地的成果

### 用户原始诉求
用 OpenLoomi 跑 `D:\openloomi3\openloomi\benchmark\GDPval-AA v2\openloomi-runner` 这个 GDPval-AA v2 runner，跑题模型用 `MiniMax-M3-highspeed`，baseUrl 是 `https://api.minimaxi.com/anthropic`，OpenLoomi 桌面端已经测过能用。

### 已落地（OK，可复用）
1. **链路打通**：`pnpm tauri:dev` 已起，OpenLoomi API 在 `http://127.0.0.1:3515` 可达，`/api/native/providers` 返回 200，`defaultAgent=claude`。
2. **数据集 + 参考文件**：220 题 gold subset 完整；前 3 题的 reference files 完整（在 `D:\openloomi3\openloomi\benchmark\GDPval-AA v2\dataset\reference_files_index.json`，对应的是 `83d10b06-...`、`7b08cd4d-...`、`7d7fc9a7-...` 三个 task）。
3. **包已链接**：`@openloomi/benchmark-gdpval-aa-v2` 已 `pnpm` 链接到 monorepo workspace（`D:\openloomi3\openloomi\pnpm-workspace.yaml`）。
4. **Python 依赖**：datasets / huggingface_hub / pyarrow 已装（py -3.12）。
5. **源码补丁**（openloomi-runner/src/agent.ts）：在 v2 system prompt 后面追加 `OPENLOOMI_FINISH_PROTOCOL_SUFFIX`，告诉模型 OpenLoomi 没有 `finish` 工具、改用 `<<<FINISH>>>` / `<<<ABANDON>>>` 文本协议。这是合法合理的修复，不破坏 v2 spec verbatim。

---

## 1. 错误现场（已两次出现）

跑 `pnpm --filter @openloomi/benchmark-gdpval-aa-v2 benchmark -- --quick 1 ...` 时：

- 现象：runner 进程卡住，30 分钟 timeout 后退出，**没有生成 `gdpval_aa_v2_run.json`**。
- 在 workdir 里能看到 reference 文件 (`Population%20v2.xlsx`) 被 stage 进来，但 **没有任何新文件**（无 deliverable）。
- 重试第二次（带上 finish-protocol suffix）行为完全一样。

### 1.1 不在 workdir 看到 deliverable 的原因
runner 要拿到 deliverable 需要走 `<<<FINISH>>>` 文本协议或 `fileSnapshots` 事件。
- 真因：模型在 OpenLoomi `claude` provider runtime 上**根本没产出任何 SSE chunk**（而非产出但忘写 finish 协议）。
- 模型单独跑（mini test）：在你桌面 UI 里贴几条 prompt 试，它立刻 emit `<<<FINISH>>>` 并写文件，没问题。

---

## 2. 诊断过程（关键发现）

我做了一个 5 个 probe 的对比实验，**全部从 PowerShell 用 `curl.exe` 直连 `/api/native/agent`**：

| Probe | systemPrompt | userPrompt | allowedTools | 跑了多久 | 结果 |
| --- | --- | --- | --- | --- | --- |
| **hello** | 无 | "Say HELLO" | 未设 | 39 s | ✅ 拿到完整 SSE 流 |
| **A** | v2 sys + OpenLoomi suffix (~1251 chars) | GDPval task 1 (~2010 chars) | `[WebFetch,WebSearch,ViewImage,Bash]` | 5.7 s | ❌ `__INTERNAL_ERROR__` |
| **B** | 同上 | "Reply HELLO" (50 chars) | 同上 | 5.7 s | ❌ 同上 |
| **D** | "You are an assistant." | "Reply OK" (50 chars) | 同上 | 5.7 s | ❌ 同上 |
| **E** | "You are an assistant." | "Reply OK" | **未设** | 10.9 s | ✅ 完整 reasoning + text SSE |

OpenLoomi 内部日志 `C:\Users\32274\.openloomi\logs\openloomi.log` 直接暴露了根因：

```
[2026-08-06T16:05:38.864Z] [ERROR] [ClaudeAgent] [Claude <session-id>] STDERR: panic(main thread): Stack overflow
[2026-08-06T16:05:38.872Z] [ERROR] [ClaudeAgent] [Claude <session-id>] STDERR: Bun v1.3.14 (d2989145) Windows x64 (baseline)
[2026-08-06T16:05:38.872Z] [ERROR] [ClaudeAgent] [Claude <session-id>] STDERR: oh no: Bun has crashed. This indicates a bug in Bun, not your code.
[2026-08-06T16:05:38.919Z] [ERROR] [ClaudeAgent] [Claude <session-id>] Error occurred {
  "error": { "name": "AgentOutputEventBusError", "message": "Agent output event bus aborted", ... },
  "config": { "baseUrl": "https://api.minimaxi.com/anthropic", "apiKey": "configured", "model": "MiniMax-M3-highspeed" },
  "env":    { "ANTHROPIC_BASE_URL": "https://api.minimaxi.com/anthropic", "ANTHROPIC_MODEL": "MiniMax-M3-highspeed", "hasAuthToken": true }
}
[2026-08-06T16:05:38.920Z] [ERROR] [ClaudeAgent] [Claude <session-id>] Internal error: Agent output event bus aborted
```

**根因 = OpenLoomi 调用的 `claude.exe`（Bun v1.3.14 打包）在收到 `allowedTools` 非空数组时栈溢出 / 进程崩溃。** 跟 prompt 大小、跟模型 (MiniMax-M3-highspeed) 无关。

---

## 3. 修复路线

**已确认的修复方向**：在 openloomi-runner/src/agent.ts 里把 `requestBody.allowedTools` 设为**省略 / 空数组 / 跟 OpenLoomi 默认值一致**。

具体改 [src/agent.ts L252-L253](file:///D:/openloomi3/openloomi/benchmark/GDPval-AA%20v2/openloomi-runner/src/agent.ts#L252-L253)（当前代码）：

```typescript
  const allowed = options.allowedTools ?? [...V2_TOOL_SET];
  requestBody.allowedTools = allowed;
```

改成其中之一：

1. **完全不发送字段**（推荐，最稳）：
   ```typescript
   // requestBody.allowedTools intentionally omitted; empty arrays still
   // trigger Bun CLI stack overflow on this OpenLoomi build.
   ```

2. **仅当用户显式传 `--allowed-tools` 时才注入**：
   ```typescript
   if (options.allowedTools && options.allowedTools.length > 0) {
     requestBody.allowedTools = options.allowedTools;
   }
   ```

3. **谨慎保留 v2 tool set 但绕一层包装**：用 `{tools: V2_TOOL_SET.map(name => ({name}))}` 这种对象型（也得先验证不触发 panic）。

**这条修改若做完**，理论上 checkpoint 立刻能产出 `gdpval_aa_v2_run.json`，并把 `Sample.xlsx`、`Population.xlsx` 等写进 `results/artifacts/<task_id>/`。

---

## 4. 修改后的验证步骤（4 步）

```powershell
# 0. 确认 OpenLoomi API 还活着
curl.exe -sS -m 5 -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3515/api/native/providers
#   期望输出: 200

# 1. 清掉失败残留
Remove-Item -Recurse -Force "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\openloomi-runner\results\workdirs\83d10b06-26d1-4636-a32c-23f92c57f30b" -ErrorAction SilentlyContinue
Remove-Item -Force "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\openloomi-runner\results\gdpval_aa_v2_run.json" -ErrorAction SilentlyContinue

# 2. 重跑 1 题（已带 OPENLOOMI_FINISH_PROTOCOL_SUFFIX）—— 默认 timeout 30 分钟
Set-Location D:\openloomi3\openloomi
$env:OPENLOOMI_API_URL = "http://127.0.0.1:3515"
$env:PYTHONUNBUFFERED = "1"
pnpm --filter @openloomi/benchmark-gdpval-aa-v2 benchmark -- `
  --dataset "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\dataset\gdpval_gold.jsonl" `
  --output   "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\openloomi-runner\results\gdpval_aa_v2_run.json" `
  --reference-index "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\dataset\reference_files\reference_files_index.json" `
  --provider claude `
  --model    "MiniMax-M3-highspeed" `
  --quick 1 `
  --permission-mode bypassPermissions

# 3. 跑完之后看 run.json + artifacts
Get-Content "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\openloomi-runner\results\gdpval_aa_v2_run.json" | Select-Object -First 80
explorer "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\openloomi-runner\results\artifacts"

# 4. 出 submission JSONL（喂给 grader）
Set-Location "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\openloomi-runner"
py -3.12 scripts\evaluate.py --run results\gdpval_aa_v2_run.json --output results\submissions\openloomi_claude_MiniMax-M3-highspeed.jsonl
Get-Content "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\openloomi-runner\results\submissions\openloomi_claude_MiniMax-M3-highspeed.jsonl" -First 1
```

如果第 2 步跑出来 `run.json` 有内容，且 `artifacts/<task_id>/` 里有 deliverable → 修复成功。

---

## 5. 关键文件位置

- **Runner 入口**：[`pnpm-workspace.yaml`](file:///D:/openloomi3/openloomi/pnpm-workspace.yaml)、[`openloomi-runner/src/index.ts`](file:///D:/openloomi3/openloomi/benchmark/GDPval-AA%20v2/openloomi-runner/src/index.ts)
- **Agent SSE client + 待修代码**：[`openloomi-runner/src/agent.ts`](file:///D:/openloomi3/openloomi/benchmark/GDPval-AA%20v2/openloomi-runner/src/agent.ts)（重点 L249-L255）
- **已加的 finish-protocol suffix**：`agent.ts` L50-L70
- **v2 prompt builder**：[`openloomi-runner/scripts/prompts/prompt_builder.py`](file:///D:/openloomi3/openloomi/benchmark/GDPval-AA%20v2/openloomi-runner/scripts/prompts/prompt_builder.py)（verbatim；**不要改**）
- **数据集**：[`dataset/gdpval_gold.jsonl`](file:///D:/openloomi3/openloomi/benchmark/GDPval-AA%20v2/dataset/gdpval_gold.jsonl)（220 行）
- **参考文件索引**：[`dataset/reference_files/reference_files_index.json`](file:///D:/openloomi3/openloomi/benchmark/GDPval-AA%20v2/dataset/reference_files/reference_files_index.json)
- **OpenLoomi 内部日志**：`C:\Users\32274\.openloomi\logs\openloomi.log`（按时间戳 `16:05:38` 找 Bun panic 记录）
- **Probe 日志（本次留下的证据）**：`D:\openloomi3\probe-A\sse-A.log`、`D:\openloomi3\probe-B\sse.log`、`D:\openloomi3\probe-D\sse.log`、`D:\openloomi3\probe-E\sse.log`
- **.shims**（python shim 实验残留，可删）：`D:\openloomi3\openloomi\benchmark\GDPval-AA v2\openloomi-runner\.shims\`
- **wrapper 脚本（实验残留，可删）**：`D:\openloomi3\openloomi\benchmark\GDPval-AA v2\openloomi-runner\run_smoke3.sh`、`D:\openloomi3\runs.sh`

---

## 6. 环境速查

| 项 | 值 |
| --- | --- |
| OpenLoomi 端口 | 3515 |
| OpenLoomi 已启动 | 是 (`pnpm tauri:dev` 在另一个用户终端) |
| OpenLoomi 桌面端 model | `MiniMax-M3-highspeed`（在 Settings → AI） |
| baseUrl | `https://api.minimaxi.com/anthropic` |
| provider | `claude` |
| Node | `v22.11.0`，在 `C:\nodejs\` |
| pnpm | `10.14.0` |
| Python | `3.12.10`（用 `py -3.12` 调用） |
| WSL bash | 已装（但是用 `/mnt/c` 而不是 `/d`；host loopback 不可达，所以全在 PowerShell 里跑最稳） |
| PowerShell 版本 | 5（默认） |

---

## 7. 重建 / 重新构跑的关键命令

如果之前调试过的状态全部被清掉，从头再来一遍：

```powershell
# 1. 启动 OpenLoomi（用户手动做的）
cd D:\openloomi
pnpm tauri:dev
# 在桌面端: Settings -> AI / API -> 设 baseUrl / apiKey / model = MiniMax-M3-highspeed

# 2. 验证 API 通
curl.exe -sS -m 5 -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3515/api/native/providers

# 3. 安装 Python 依赖（如果换机器）
py -3.12 -m pip install -U datasets huggingface_hub pyarrow

# 4. 链接包（如果第一次跑）
cd D:\openloomi3\openloomi
pnpm install --filter @openloomi/benchmark-gdpval-aa-v2 --no-frozen-lockfile

# 5. 跑题（用 PowerShell，不要走 WSL bash，因为 WSL 拿不到 host loopback）
Set-Location D:\openloomi3\openloomi
$env:OPENLOOMI_API_URL = "http://127.0.0.1:3515"
pnpm --filter @openloomi/benchmark-gdpval-aa-v2 benchmark -- `
  --dataset "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\dataset\gdpval_gold.jsonl" `
  --output   "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\openloomi-runner\results\gdpval_aa_v2_run.json" `
  --reference-index "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\dataset\reference_files\reference_files_index.json" `
  --provider claude `
  --model    "MiniMax-M3-highspeed" `
  --quick 1 `
  --permission-mode bypassPermissions

# 6. 出 submission JSONL
Set-Location "D:\openloomi3\openloomi\benchmark\GDPval-AA v2\openloomi-runner"
py -3.12 scripts\evaluate.py --run results\gdpval_aa_v2_run.json --output results\submissions\openloomi_claude_MiniMax-M3-highspeed.jsonl
```

---

## 8. paper / 资料索引（已查过）

- **GDPval 原文**：Patwardhan et al., 2025，[arXiv:2510.04374](https://arxiv.org/abs/2510.04374)
  - 人专家平均耗时 **HT = 404 分钟 ≈ 6.7 小时/题**
  - 模型平均耗时通常 5-40 分钟/题
- **AA v2 method**：[artificialanalysis.ai/methodology/intelligence-benchmarking#gdpval-aa](https://artificialanalysis.ai/methodology/intelligence-benchmarking#gdpval-aa)
  - turn cap 250，per-task timeout 24h
- **本 runner 默认 timeout**：30 分钟（可通过 `--timeout-ms` 改）
- 公共 leaderboard（v2）：[artificialanalysis.ai/evaluations/gdpval-aa](https://artificialanalysis.ai/evaluations/gdpval-aa)

---

## 9. 没做完的 TODO（移交）

| TODO | 优先级 |
| --- | --- |
| 改 `src/agent.ts` L252-L253 不再发 `allowedTools`（除非用户显式传 `--allowed-tools`） | 高 |
| 改完后重跑 `--quick 1` 验证 | 高 |
| 冒烟通过后扩到 `--quick 3` → 全 220 题 | 中 |
| `scripts/evaluate.py` 出 `submissions/openloomi_claude_MiniMax-M3-highspeed.jsonl` | 中 |
| 准备第二个 submission JSONL（同任务用 codex 或别的 OpenLoomi runtime）跑 pairwise grader | 中 |
| 跑 `python -m gdpval.grading.pairwise_grader` + `python -m gdpval.elo.bradley_terry --matches matches.jsonl --anchor 1000` | 低（v2 anchor = 1000） |
| 删 `.shims/`、`run_smoke3.sh`、`D:\openloomi3\runs.sh` 等临时实验残留 | 低 |
| 决定后续要不要修 OpenLoomi 的 Bun CLI panic（属于另一个工程） | 低 |

---

## 10. 给下一个接手的人一句话总结

**runner 现在链路全通，根因找到**（OpenLoomi 的 Bun CLI 收到 `allowedTools` 数组就 stack overflow，**跟模型、prompt 大小、文件附件都没关系**）。改一行（[src/agent.ts L252-L253](file:///D:/openloomi3/openloomi/benchmark/GDPval-AA%20v2/openloomi-runner/src/agent.ts#L252-L253)）把 `requestBody.allowedTools = allowed` 改成**只在用户显式指定时才注入**，然后照 §4 的 4 步验证即可。需要 `--quick 1` 跑通后再扩。

---

## 11. 2026-08-07 增量（OpenLoomi SSE flush 问题）— **未决**

接手人在 8/6 修复代码后跑了三次，结果分别记录在：

- `results/quick1_no_allowed_tools_fix.log`：源码修后第一次跑。OpenLoomi log 显示 16:16:05 又出现 `AgentOutputEventBusError: Agent output event bus aborted`——但 stack trace 不在 Bun，是 SDK `pumpQuery` 抛错被 EventBus 转 abort。但模型那时还没产出任何 output event，所以是「init-time 即崩」。
- `results/quick1_with_sse_debug.log`：第二次跑。OpenLoomi log 显示 16:21→16:26+ 模型在持续 tool dispatch（写 SKILL.md / 重命名 audit_script.py 等），但 SSE reader 一次都没收到 mid-stream event。客户端 SSE 卡在第一个 `session` event 之后再无任何帧。
- `results/debug_logs/_openloomi_sse_debug_*.log`：第三轮（`OPENLOOMI_DEBUG_SSE=1` + raw chunk log）。**确凿证据**：`raw read #1: 96 bytes` 拿到的是 `session` event，**之后 5 分钟内 `raw read` 计数 = 0，模型却连续做了 ~10 次 tool dispatch**。

### 11.1 进一步读源码（apps/web）的关键发现

OpenLoomi route.ts 生成 SSE 用 `for await (const message of generator) { controller.enqueue(...) }`，generator 来自 session.subscribe()（即 AgentOutputEventBus 的 async iterator）。EventBus 配置 `subscriberCapacity = 256` + `replayCapacity = 256`，默认 `publishOne` 是 async + 等待 `subscriber.pending.length < subscriberCapacity`。

但**真正的瓶颈**应该是 OpenLoomi web 端的 Next.js dev server（`pnpm tauri:dev`）— 它跑 `next dev` (turbopack) 直接用 ReadableStream 喂给 client，且默认对 chunk 不显式 `controller.flush()`。**Node 18+/undici 的 stream 默认行为是尽量 batch 输出，直到 ReadableStream 高水位线或 close() 才推送**。

### 11.6 OpenLoomi web 端的修复（8/7 凌晨已落地，验证后无效）

在 [`apps/web/app/api/native/agent/route.ts`](file:///D:/openloomi3/openloomi/apps/web/app/api/native/agent/route.ts) L29 起新增：

```typescript
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
```

**8/7 凌晨跑完一轮验证**：`results/quick1_v4.log` + `_openloomi_sse_debug.log` 显示 OpenLoomi dev 重启后效果不变——模型在 9 分钟内出 `Sample.xlsx` + `Population.xlsx`（workdir 顶层），SSE reader 仍然只收 `raw read #1: 96 bytes`（`session` event），之后再 0 frame。

**结论**：`runtime/dynamic` 段配置不能解决这个 SSE flush 问题。问题更深一层，要么在 OpenLoomi 的 EventBus `publishOne` 路径里，要么在 SDK 的 `outputMultiplexer.convert(message)` 转换/serialize 阶段。

### 11.8 OpenLoomi SSE 真正的根因 + 修复（8/7 全栈调查 + 改后待验证）

**根因（来自 8/7 全栈 trace + Web Streams 标准与 OpenLoomi `output-event-bus.ts` 全部对照）**：

OpenLoomi 的 [session.ts#L443](file:///D:/openloomi3/openloomi/apps/web/lib/ai/extensions/agent/claude/runtime/session.ts#L443) 在 `pumpQuery` 里是：

```ts
for (const agentMessage of this.outputMultiplexer.convert(message)) {
  await this.output.publish({ ...agentMessage, runEpoch: observedRunEpoch });
}
```

`AgentOutputEventBus.publish` 是 Promise，**`publishOne` 内部 `await Promise.all(subscribers.map(s => this.waitForCapacity(subscriber)))`**，其中 `waitForCapacity` 在 `subscriber.pending.length >= subscriberCapacity (256)` 且 `waiters.length === 0` 时返回**永不 resolve 的 Promise**。

只有 `subscriber.next()` 被外层 SSE writer 调，pending 队列才会被消费、`waiters` 才会被排队。所以**当 SSE writer 因为任何原因（socket 慢、HTTP/2 流控、React 19 streaming 调试、Tauri 代理压缩）停顿时**，`for await` 微任务被卡，外层 `subscriber.next()` 不被调，pumpQuery 又因为 `await publish(...)` 等 publisher 解锁 → **死锁**。

证据（完全对应）：
- runner raw read `#1` = 96 bytes（session event），之后 `#2` 没出现
- OpenLoomi 内部 `tool_dispatch` 持续在写（pumpQuery 在跑、recordProviderObservation 在跑）
- workdir 顶层九分钟后已出现 `Sample.xlsx` / `Population.xlsx` —— 模型实际完成了任务

**修复（最小入侵、最大化把握）**：

把 [session.ts#L443](file:///D:/openloomi3/openloomi/apps/web/lib/ai/extensions/agent/claude/runtime/session.ts#L443) 的 `await this.output.publish(...)` 改为**fire-and-forget**：

```ts
for (const agentMessage of this.outputMultiplexer.convert(message)) {
  this.output.publish({ ...agentMessage, runEpoch: observedRunEpoch })
    .catch((err) => this.logger.warn(`[Claude ${this.runtimeSessionId}] output publish failed`, err));
}
```

**为什么能解**：
- pumQuery 的 SDK `for await` 不再被 publisher 等，**`query` iterator 持续推进**。
- 事件被 publish 进 EventBus 的 `pending`（最多 256 个）。如果 SSE writer 慢，pending 满 → `publishOne` 在 `waitForCapacity` 阻塞——但此时**SDK iterator 仍向前推进**（多个 message 之间可独立 fire-and-forget），不会形成死锁。SSE writer 一旦恢复，会持续 drain pending。
- 容量满了会自动 backpressure——不会无限堆内存。

**这是 OpenLoomi 内部 publish 路径的 fire-and-forget hack，跟 §11.6 的 segment config 修复是正交的，能叠加**。

代码改动在 [`apps/web/lib/ai/extensions/agent/claude/runtime/session.ts`](file:///D:/openloomi3/openloomi/apps/web/lib/ai/extensions/agent/claude/runtime/session.ts) L442-L461。

### 11.7 备选：filesystem polling fallback（8/7 凌晨建议）

既然模型**实际上**已经能写 deliverable（`Sample.xlsx`、`Population.xlsx`），OpenLoomi 实际行为是「task done，但 SSE 不通告」。最务实的下一步是在 runner 里加一个 watchdog：

- 每 30s 扫一遍 `workdir` 顶层（用 mtime）。
- 出现新文件 + 60s 静默后仍无 SSE `result` event → 直接把"自 t=N 之后新增的 top-level 文件"当作 deliverable list。
- 把 force-close SSE reader、构造一个 fake handle 走 `summariseHandle()` 流程，让 runner 写进 `gdpval_aa_v2_run.json`。

评估：这能交付一个**近似正确**的 run.json（lose：缺 tool_calls/turn_count/usage 真实数据；gain：deliverables 大概率正确）。如果要严格的 v2 spec，必须等 SSE 修好。



### 11.2 验证手段（接手人可选）

1. 在 web 端的 `route.ts` L99 `controller.enqueue(data)` 之后，加 `controller.enqueue(new Uint8Array())` 或在 `ReadableStream` 上调用 `(controller as any).flush?.()`——应该能立刻推下去。但这是 OpenLoomi 侧代码，不在我们项目的 scope 里。
2. 在 runner 端换 SSE reader 策略：放弃 `text/event-stream`，自己 `request` 拿 raw stream，肉眼解析 SSE 帧——**不会解决**，因为 OpenLoomi 不发帧。
3. 临时 hack：在 web 端 route.ts 把 `useFlowingStream` / `useDynamic = 'force-dynamic'` 之类加好，或者改用 dev:next 自带的 `flushHeaders()` API。让 SSE response 不被 buffer。

### 11.3 当前最稳的 fallback

**不走 SSE**——改用 OpenLoomi 的「轮询 endpoint」风格 API（如果存在）；或者干脆让 runner 周期性 GET `/api/native/sessions/<sessionId>` 拉累积 output。但这都依赖 OpenLoomi 后端实现，**不是 runner 内部能解决的工程问题**。

### 11.4 代码层面已落地的改动（保留、不要回滚）

- [`src/agent.ts`](file:///D:/openloomi3/openloomi/benchmark/GDPval-AA%20v2/openloomi-runner/src/agent.ts) L275-L285：默认不发 `allowedTools`（文档 §3 的修复 #2），仍保留 `OPENLOOMI_DEBUG_SSE` env flag + raw chunk + per-event log。
- [`src/index.ts`](file:///D:/openloomi3/openloomi/benchmark/GDPval-AA%20v2/openloomi-runner/src/index.ts) L390-L395：CLI 入口同步删除 `args.allowedTools ?? [...V2_TOOL_SET]` 兜底；help 文案也改了。
- `:V2_TOOL_SET` 常量已经从两个文件中删除（避免死代码）。
- 残留物：`results/quick1_no_allowed_tools_fix.log`、`results/quick1_with_sse_debug.log`、`results/quick1_v3.log`、`results/debug_logs/_openloomi_sse_debug_*.log`——**别删**，作为现场证据。

### 11.5 总结

| 假设 | 排查手段 | 结果 |
|---|---|---|
| 文 §3 的 Bun panic 还是主导 | 去掉 `allowedTools` 字段 | ❌ panic 消失，剩下另一个错 |
| OpenLoomi SDK 在 mid-stream 抛错 | OpenLoomi log 错误搜索 | ✅ 没看到 ERROR 级，只看到 WARN 级 stall |
| Node fetch buffer 吞 SSE 帧 | raw `reader.read` 日志 | ❌ OpenLoomi 真的不发 mid-stream 帧 |
| next dev turbotpack 默认 batch 响应 | 持续监测 | 🟡 高度怀疑，**未验证** |

**这是一道 OpenLoomi（`apps/web`）的题，不是 runner 的题**。Runner 端已经把所有能做的事做完。

