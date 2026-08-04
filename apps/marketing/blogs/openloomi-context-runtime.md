---
title: "OpenLoomi: The Context Runtime Behind Long-Horizon Agents"
date: 2026-08-04
description: "OpenLoomi's memory system and context runtime engine"
image: /img/blogs/openloomi-context-runtime.png
---

## OpenLoomi's Memory System and Context Runtime Engine

The most intuitive capability of large language models is instantaneous output: write a piece of code in seconds, summarize a complete document in a few minutes, produce a seemingly complete plan in ten-plus minutes. But truly high-value work is almost never generated in a single pass — it is a long-running process that spans days, weeks, or even months. Goals iterate, facts update, decisions produce cascading consequences, external feedback keeps flowing in, the system falls into waiting states, and users intervene at different times in different ways to make adjustments.

So the core problem of long-horizon intelligent agents has never been "can the model handle the next turn of conversation," but rather "in a continuously changing real-world scenario, can it always clearly locate the user being served, the core objective, the confirmed facts, the valid judgments, and the global impact of every action."

OpenLoomi's core technical view is clear: an LLM's context window cannot carry the state management of long-running work. A truly human-centric intelligent agent needs an external memory system that captures and maintains all user state affecting subsequent actions; paired with a context runtime engine, which before every execution integrates the long-term accumulated state, the latest real-world information, permission boundaries, and the current task, building a working environment that can be executed directly.

Memory answers "which information must persist across time and remain in effect"; the context runtime answers "how does the persisted information constrain and drive decisions and actions right now." The former lets the agent always retain a continuous understanding of the user; the latter turns that understanding into actual action rather than merely archiving it. OpenLoomi aims to build not an assistant that can recall chat history, but a foundational intelligent infrastructure that runs continuously around the user's goals.

In today's AI engineering context, this philosophy aligns with the core argument in Lilian Weng's July 2026 post, ["Harness Engineering for Self-Improvement"](https://lilianweng.github.io/posts/2026-07-04-harness/): "the harness is not an auxiliary function of model capability, but a core optimization target of equal importance to the model weights." Weng has built an industry abstraction coordinate system. This post reinterprets OpenLoomi's design philosophy through that framework — not to judge right or wrong, but to give this long-horizon intelligence architecture a clear industry positioning.

## The Real Difficulty of Long-Horizon Intelligence Is State Drift, Not Context Length

For one-shot tasks, the problem is usually inaccuracy in the result; for long-running tasks, failure is often hidden and hard to detect. The agent can still output fluent text, yet may have long forgotten the original goal; it can still quote past decisions, yet cannot recognize that a decision has been reversed; it solidifies temporary speculation into established fact, completes fragmented local tasks, and gradually drifts away from the user's core intent.

This kind of "state drift" cannot be solved by simply stretching the context window. Stuffing all conversation history, documents, and tool logs into the context only yields a pile of fragmented information with no hierarchy, temporal order, or causal logic. The model still has to re-identify goals, evidence, decisions, expired information, and pending actions on every turn, and each round of ad hoc judgment drifts and distorts further across long iterations.

![State Drift vs Context Stuffing — Patent No. 2026-0513](/img/blogs/openloomi-context-runtime/state-drift.png)

The key to long-horizon intelligent operation is not that the agent is always online, but that it can "resume precisely after a pause." Whether the task is interrupted for days, the session window changes, new tools are added, or the user reprioritizes, the system can always recalibrate three core questions in real time: has the goal changed, what is new in the real-world situation, and what is the optimal path forward based on the latest state.

> The harness should not carry the entire workflow and all logs in context; instead, it should persist state in the file system rather than in context.

OpenLoomi's local file memory path `~/.openloomi/data/memory/{people,projects,strategy,insights,channels,notes}/` is exactly the implementation of this idea — all memory is readable, auditable, and version-managed, making the reproducibility of long-running tasks a default capability.

Among the seven core industry challenges Weng raises in her post, she also notes: "the lifecycle management of context and memory is the key that determines the upper bound of long-horizon intelligence." OpenLoomi turns this abstract problem into a runnable product mechanism: through the lifecycle states `supersededBy` and `disputed` on commitments, combined with a retention scoring system that weighs access frequency, importance, time decay, and manual pinning, it completes dynamic memory management.

## OpenLoomi's Context Runtime: Turning One Person's World into Executable State

Conventional memory focuses on "fully reconstructing past events"; OpenLoomi's memory design focuses on "from past information, what still guides the present and shapes future actions." The two sound close, but the underlying system design logic is entirely different.

In an ordinary conversation, formal decisions, unverified ideas, emotional expressions, and objective external facts are mixed together. OpenLoomi does not store them uniformly or recall them with equal weight. A user-confirmed product direction has far higher priority and authority than a temporary guess; customer feedback keeps its source and timestamp intact to avoid being mistaken for team consensus after multiple summarizations.

Therefore, OpenLoomi's memory system does not store redundant history — it only maintains the user's "executable state library," covering long-term goals, project progress, core decisions, interpersonal and collaborative relationships, stable preferences, key events, unfinished commitments, potential risks, and pending items. Every memory is traceable, time-verifiable, and credibility-confirmable, and clearly labels the scope of its influence on subsequent actions.

This makes OpenLoomi's memory far beyond ordinary retrieval: retrieval only "finds similar content," while executable memory "participates in the decision loop." It supports state updates, conflict checks, expiration invalidation, and revocation backtracking, cleanly distinguishing four categories of information: objective fact, user cognition, agent inference, and unverified hypothesis. The core value of memory is not to let the agent retell the past, but to let it, amid real-world iteration, precisely filter effective history and avoid outdated judgments.

OpenLoomi's four-layer memory architecture ([raw messages / lifecycle summaries / interpretation layer / knowledge layer](https://openloomi.ai/docs/memory)) is the concrete realization of this idea: abandoning the inefficient "stacking text" pattern and building a structured, iterable playbook.

![Four-Layer Memory Architecture — Patent No. 2026-0514](/img/blogs/openloomi-context-runtime/four-layer-memory.png) The three core components of the industry ACE model translate into actionable product capabilities in OpenLoomi: the Generator corresponds to the ability to read, write, and update memory on every loop tick; the Reflector corresponds to the traceability record after human review; the Curator corresponds to the interpretation layer's automatic merging of information, dispute handling, and pruning of expired decisions. This abstract intelligence logic ultimately lands as a user-perceivable, traceable local file system; all terminology is unified in the glossary.

## Context Runtime: Not Concatenating Prompts, but Rebuilding a World for Every Action

The core value of the context runtime engine is by no means simply expanding context or stitching prompts. Before every limited execution window begins, it precisely builds a minimal working environment that is "sufficient, precise, and low-error" — supporting effective decisions while avoiding misjudgments from irrelevant information.

This working environment must fully cover six core dimensions: the user's long-term core goals, current task progress, factual evidence strongly relevant to this turn of action, the latest state of external tools and business systems, the agent's permission boundaries, and the new state and valid receipts this execution must commit.

Thus, a single agent execution is no longer a closed loop of "user asks → model outputs → task ends," but a complete state iteration. The runtime pulls valid historical state from memory, syncs the latest real-world changes, judges the boundary of the current task, outputs controllable and bounded actions, verifies the actual effect of those actions, and finally writes back new facts, new decisions, execution results, and blockers. The starting point for the next execution is not the model's fuzzy memory, but the latest, verified, precise state.

This is the essential difference between OpenLoomi and ordinary "long-memory chatbots": ordinary bots use memory as auxiliary material to optimize answers, while OpenLoomi folds memory into the core execution governance system. The former focuses on "can it recall relevant history"; the latter focuses on "how to precisely load effective state, authorize compliant actions, and identify items that need confirmation."

> The harness is the system that wraps around the base model, orchestrates execution, decides how the model thinks and plans, invokes tools and acts, perceives and manages context, stores artifacts, and evaluates results.

OpenLoomi implements this architecture as the [Loop core cycle](https://openloomi.ai/docs/loop) — a Read → Judge → Write decision loop. The system auto-triggers a tick inspection every 10 minutes: it reads valid memory state (Read), combines the current task boundary to judge the optimal action (Judge), waits for the user's human ruling through one of four gestures — Approve / Edit / Later / Skip — and finally writes the decision along with its supporting evidence back into the interpretation layer to solidify state (Write). Beyond scheduled inspection, automated tasks such as morning briefings, evening reviews, and weekly summaries, as well as inline drafting during conversation, all reuse the same loop rules, differing only in trigger mode.

![Read Judge Write Loop — Patent No. 2026-0515](/img/blogs/openloomi-context-runtime/read-judge-write-loop.png)

## A Typical Use Case: From One Strategic Judgment to a Continuously Running Work Chain

What best embodies OpenLoomi's long-horizon value is not instantaneous capabilities like copywriting or content generation, but the ability to keep following through on long-running goals that a user cannot describe or execute in a single pass. Take a founder iterating on the business: the user plans to validate a new customer segment, complete customer research, output a product judgment, precisely reach target customers, and iterate product direction based on real market feedback — a cycle that runs for weeks.

At the project's start, the founder raises a tentative hypothesis — "the product fits early-stage teams better" — but it has not been market-validated. At this point, OpenLoomi does not solidify a temporary guess into a user tag, nor does it directly generate irreversible go-to-market strategies. It tags the content as "unverified strategic hypothesis," fully preserves the background, time, rationale, and uncertainty of the proposal, and sets up the matching task chain in parallel: capture existing customer characteristics, screen target groups, structure research dimensions, and wait for the user to confirm permissions and boundaries for outbound outreach.

As the project advances, the system automatically syncs new market signals from emails, meeting notes, chat messages, and project documents. Faced with similar deployment issues raised by multiple customers, it does not simply merge identical conclusions; instead, it distinguishes differences in user stage, scenario, and demand, benchmarks new signals against the original strategic hypothesis, judges whether each signal supports, weakens, or revises the original guess, and outputs the minimum viable iteration action: it does not blindly rebuild the market analysis, but only flags evidence conflicts, adds verification questions, and routes key decisions to the user for final approval.

Once the user confirms the iteration direction, the agent can autonomously complete low-risk actions such as organizing research outlines, screening candidate customers, drafting personalized outreach, and tracking reply status. At the same time, it strictly distinguishes permission levels: draft edits can be performed autonomously; outbound messages require human confirmation; and core decisions like product roadmap iteration must rely on a complete evidence chain and wait for explicit user instructions — no autonomous high-risk operations.

As customer feedback keeps flowing in, market fact gradually overturns and refines the original hypothesis: some customers see the value but refuse to pay; some are willing to try but have custom integration needs; others do not respond at all. OpenLoomi does not merely aggregate data into a weekly report and passively wait for assignments. It actively updates relationships, project progress, evidence validity, and task status, sorts out which parts of the original hypothesis have failed and which still hold, downgrades unverified conclusions, and outputs a new round of reviewable, executable minimum-advancement actions.

This is a typical long-horizon intelligence scenario: the user's long-term goal, supported by multi-source real data, cross-temporal memory management, human-decision verification, and permission-boundary governance, is steadily delivered as real business progress. The core difficulty of this entire flow has never been content generation; it is that, after many rounds of information iteration, the agent still anchors the original core goal — never blurred, never drifted, never treating an unverified hypothesis as established fact.

This scenario clearly illustrates the division of labor in the dual-layer architecture: emails, meetings, tasks, and documents are objective sources of fact; the memory system settles strategic hypotheses, user decisions, relationship status, core evidence, and commitments awaiting execution; the context runtime dynamically determines what to load, what is executable, what needs confirmation, and what to write back. Business systems record "what happened"; OpenLoomi interprets "what to do next."

## Every Execution Should Form a Closed Loop, Not Leave a Longer Summary

The core execution unit of OpenLoomi is a complete state iteration loop: recall effective state → assemble precise context → execute a bounded action → verify real-world results → commit and update future-usable state.

The "write-back" here is far from simply archiving the model's output. The system precisely distinguishes newly added facts, human decisions, valid evidence, unfinished items, failure causes, and follow-up recovery conditions. After the agent outputs a plan, what persists is not only the text, but also the plan version, supporting evidence, modules awaiting verification, user-confirmed content, and continuation nodes — ensuring that every round of work is connectable and traceable.

"Result verification" is an indispensable part of long-horizon intelligence: without verification, the agent's subjective reasoning is solidified into fact; without traceability, summary conclusions replace original information; without temporal management, expired judgments mislead present actions; without conflict handling, multiple versions of conclusions interfere with decisions simultaneously. The quality of long-horizon intelligence depends not on memory capacity, but on whether memory can keep fitting the real world's ongoing change.

The value of human feedback is thus redefined. When the user rejects an output, it may not just be correcting a single answer; it may be overturning a strategic hypothesis, refining an expression pattern, or raising the permission threshold for an entire class of action. Valid feedback synchronously updates memory and the rules of context assembly — one feedback, system-wide optimization, not a one-off patch.

> The self-improvement loop optimizes whatever signal is given to it. If the reward comes from unit tests, the agent may overfit tests. If the reward comes from human feedback, the agent may learn to deceive humans.

To address the industry-wide challenge of self-optimization, OpenLoomi's solution is the "four-gesture human ruling mechanism": Approve / Edit / Later / Skip. No optimization signal is auto-generated or model-self-judged — all of it relies on real human decisions, and every ruling is written into the system with traceability information. This also implements the industry principle of "evaluation and permission governance must be independent of the intelligence evolution loop": the system can autonomously filter candidate actions, but final decisions and core optimization directions always remain with the human.

## OpenLoomi's Control Plane: Let State Directly Drive the Next Step

In short, OpenLoomi is a **user-side control plane for long-horizon intelligent agents**. It does not merely visualize tasks and archive memory — it structures the four core elements of goal, state, evidence, and permission into underlying rules that constrain every execution, so that every action is evidence-based and bounded.

- **Vision / Goal:** Records the direction the user truly wants to achieve, and the long-term constraints that must not be sacrificed for local optimization.
- **Memory / User State:** Preserves goals, decisions, relationships, preferences, events, commitments, and their sources, times, and credibility.
- **Domain State:** Connects domain systems like messaging, files, calendars, CRMs, and code repositories to identify changes that have already happened in the real world.
- **Task / Frontier:** Clarifies how far the current push has gone, what the next step is, which items are already done, and which are waiting or blocked.
- **Evidence / Receipt:** For important conclusions and actions, keeps readable sources, results, versions, and verification records.
- **Authority / Gate:** Distinguishes actions the agent can complete autonomously from judgments and external operations that must be returned to the user for confirmation.
- **Runtime / Handoff:** After a pause, resume, session switch, model switch, or tool switch, reconstructs a runnable working environment.

An ordinary collaboration board can only answer "what is being done right now"; OpenLoomi's control plane can fully answer "what is the value of this thing, what is its core evidence, what is its iteration impact, and what is the termination condition." When this state rule can directly constrain every limited execution, the control plane is no longer a pure result-display tool — it becomes a core component of the entire intelligent execution system.

OpenLoomi's seven core elements are the embryonic form of an operating-system-level architecture: it is not a single intelligent scheduling harness, but a neutral general-purpose control plane onto which many harnesses can be mounted. Each module has a clear engineering carrier:

- _Memory / User State_ — see the [memory doc](https://openloomi.ai/docs/memory) for the four-source design and retention scoring.
- _Task / Frontier_ and _Authority / Gate_ — see the [Loop doc](https://openloomi.ai/docs/loop) for the Read → Judge → Write loop and the four-gesture ruling.
- _Domain State_ — see the [connectors doc](https://openloomi.ai/docs/connectors) for the dual-track (Composio + native Loomi) connectors and trust ladder.
- _Evidence / Receipt_ — see the [audit package](https://github.com/melandlabs/openloomi/tree/main/packages/audit) for local logs of every tick, every ruling, and every decision.
- _Runtime / Handoff_ — see [Any Agent Runtime](https://openloomi.ai/docs/reference/agent-runtimes) for the unified access protocol of Claude Code / Codex / OpenCode / Hermes / OpenClaw.

The "neutrality" of the control plane has two meanings: first, it is neutral to models (not locked to any single LLM); second, it is neutral to harnesses (any harness that wants long-term memory can plug in and obtain the same memory and decision-card queue). This is only achievable through open source, so [Apache 2.0](https://github.com/melandlabs/openloomi/blob/main/LICENSE) is not a commercial posture — it is the existential condition of the control plane. Neutrality at the product layer also includes safety governance: all connectors, ticks, and decision cards are bound by the three principles in the [privacy-security doc](https://openloomi.ai/docs/privacy-security) — local-first storage, AES-256 encryption, and access auditing — which is also the engineering existential condition of the "open-source control plane."

## The Evolution of Long-Horizon Agents Is Not Infinite Automation, but Learning How to Work Reliably

Long-running operation exposes the system's own flaws. The agent may find that some category of customer feedback never classifies correctly, that some memory is often mis-recalled, that an external tool lacks verification, or that some step always requires the user to repeat an explanation. A mature system should not keep burying these issues inside every turn of conversation — it should recognize them as opportunities to improve the working system.

This lets "completing work" and "upgrading the system that completes work" happen on the same long-running track. The agent can propose a new memory type, add a verification step, refine a context-assembly pass, or add a tool capability; after testing and human approval, it returns to the original goal and continues executing. Self-evolution is not about giving the agent unrestricted self-modification rights — it is about letting failures from real work accumulate into system capability.

OpenLoomi's boundary must also be clear: when no one is intervening, it should maintain state, push low-risk work forward, identify blockers, and quietly wait; when someone intervenes, it should accurately absorb feedback, update memory, and replan; when directional decisions, external commitments, or irreversible actions are involved, it should know when to stop and request authorization. A reliable long-horizon agent does not make decisions for the human forever — it lets the human intervene only where real judgment is needed.

OpenLoomi's approach shares the same source as Self-Harness, but what it opens up is not the self-rewrite permission — it is the narrow path "failures in real work → write back into memory → reshape the next context assembly." Going further, it turns the "user's approximate decisions" into a special class of evidence and writes them back into the [audit layer](https://github.com/melandlabs/openloomi/tree/main/packages/audit). This path does not pursue "harness modifying harness"; instead, it lets the harness increasingly understand this one user through real feedback.

## From "Can Answer" to "Continuously Working Around One Person's Reality"

If every new session requires the user to re-explain the project background, copy past decisions, remind relationships, and search for last time's evidence, then so-called intelligence is merely shifting the cost of context maintenance onto the human. The real value lies not in typing a few fewer words, but in reducing the cognitive burden of repeatedly rebuilding context, calibrating state, and tracking commitments.

OpenLoomi aims to be an invisible yet indispensable intelligence layer for the user: it continuously absorbs conversations, files, meetings, tasks, and external events, and settles important content as memory with sources and times; before acting, it reconstructs the truly needed context for the moment; after acting, it verifies results and updates the future working state.

This is also OpenLoomi's most fundamental product boundary: memory is not an add-on feature, and context is not a longer prompt. Memory decides what can persist across time; the runtime decides how these persisting states participate in current action; together, they determine whether the agent can keep working in the real world, rather than just delivering one beautiful answer in a demo.

What is truly worth verifying is not whether OpenLoomi can remember a sentence the user once said, but whether, after a task pauses for several days and goes through new feedback and reality changes, it still knows: what does this person actually want to achieve, which pieces of evidence have already changed judgment, which decisions still hold, why the next step is this step, and what must be handed back to the human.

If the answer is yes, the agent stops being a one-shot answer machine and begins to be a system that runs long-term around one person's goal. What it remembers is not the past itself, but how the past continues to influence the future; what it uses is not a static context, but a working world that keeps updating with reality, feedback, and action.

What OpenLoomi aims to build is exactly this: giving every person an intelligence layer that can understand long-term, resume continuously, act cautiously, and keep evolving. Long-horizon intelligence does not mean the agent is always online — it means that every time it comes back, it knows why it is here and how to keep the truly important things moving forward.

## How to Use OpenLoomi's Memory and Context Capabilities

The full set of long-term memory and context runtime capabilities above is provided by OpenLoomi through three lightweight access paths: Plugins, Skills, and MCPs, supporting all intelligent runtimes in reusing the same control plane and persistent state, sharing the core protocol and local memory, differing only in distribution form and applicable scenario.

### Plugins: Let a Specific Agent Runtime Directly Become OpenLoomi's Front End

[Plugins for Claude Code](https://openloomi.ai/docs/plugins/claude) is the most direct access path: it lets the corresponding agent runtime serve directly as OpenLoomi's front-end interaction window. Deploy with a one-line command inside Claude Code:

```
/plugin marketplace add melandlabs/plugins
/plugin install openloomi
```

Once installed, invoking the full `/openloomi:*` command set inside Claude Code is forwarded to the local OpenLoomi runtime. Memory, connectors, and decision cards are inherited natively; all data and operational side effects land on the local desktop, and Claude Code only handles front-end rendering.

[Plugins for Codex CLI](https://openloomi.ai/docs/plugins/codex) uses the same source design, adapted to the Codex plugin naming convention. The install command is:

```
codex plugin marketplace add melandlabs/plugins
codex plugin add openloomi@openloomi
```

After deployment, invoke the full capability set through the `@OpenLoomi` prefix. All newer agent runtimes that support the marketplace plugin protocol — including OpenCode, Hermes, and OpenClaw — are also supported.

### Skills

Skills are a lighter, more universal distribution form, not bound to a specific agent runtime. Any platform supporting the Skills protocol — Claude Code, Codex, Cursor, Hermes, and others — can be deployed quickly with a single command:

[OpenLoomi Skills](https://openloomi.ai/docs/skills) is the lighter distribution form — any agent runtime supporting the skills protocol (including Claude Code / Codex / Cursor / Hermes, etc.) can be installed with a single command:

```
npx skills add https://github.com/melandlabs/openloomi/tree/main/skills \
  --skill openloomi openloomi-setup openloomi-memory openloomi-connectors openloomi-loop openloomi-api openloomi-feature-guide composio \
  -y
```

After deploying the `openloomi` skill pack, the corresponding runtime quickly gains the full set of capabilities — local environment detection, semantic memory recall, connector invocation, Loop closed-loop scheduling, and HTTP API access. Skills themselves are stateless loads; all persistent state and memory data remain on the local OpenLoomi Desktop, ensuring data does not get lost across sessions and state does not get disordered.

At the same time, Skills also serve as the unified entry point to official documentation and source code: feature guides, memory mechanisms, connector rules, loop scheduling, and API docs are all deployed along with the skill pack, so a new environment can be fully provisioned with a single command, ready out of the box.

## Closing: Long-Horizon Intelligence Is the Industrial-Grade RSI Foundation

Today's mainstream AI remains trapped in the single-shot, instantaneous tool-delivery paradigm and cannot adapt to the real human workflow of discontinuous advancement, dynamic iteration, and frequent adjustment. OpenLoomi's core breakthrough is to abandon the industry's inertial thinking of merely stretching context and stacking conversation data — relying instead on structured executable memory, a dynamic context runtime, and a human-machine collaborative closed-loop architecture, it cures the long-horizon agent's pervasive state drift, goal deviation, and decision failure, giving the agent real long-running capability across sessions, with interruptibility, resumability, and governance — completely breaking free from the limitation of being a one-shot Q&A tool.

This mature long-horizon governance architecture is exactly the core engineering foundation for industrial-grade RSI (Recursive Self-Improvement) to land. The reason most current agents cannot achieve effective self-evolution is not insufficient model compute, but the lack of a traceable, verifiable, iterative state management system. Through layered memory governance, Loop cycle verification, full-chain auditing, and the four-gesture human ruling mechanism, OpenLoomi builds a safe, controllable, ordered recursive iteration path. Using real business scenarios as the evolutionary soil, it turns every execution deviation, every piece of user feedback, and every scenario iteration into system optimization evidence — freeing intelligence evolution from the risk of unbounded autonomous rewriting, and achieving sustainable human-machine co-iteration.
