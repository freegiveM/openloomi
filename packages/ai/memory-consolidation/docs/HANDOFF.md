# Memory Graph Handoff

Status: `PHASE_0_3_SHIPPED_PHASE_4_G1_REMAINING`

## Authority

- Branch: `codex/memory-graph-value-demonstrations`, based on upstream `main`.
- The [execution plan](./memory-graph-evolution-execution-plan.md) is the sole
  authority for status, phase numbering, and scope. This handoff never widens
  what that plan authorizes.

## Where the work stands

Phases 0-3 are merged upstream and ship default-off. Phase 4 has been
redefined: it now decides whether the defaults may be turned on, judged by
demonstrated behaviour and safety rather than by an aggregate retrieval metric.
The reasoning and the six gates are in the execution plan under Deferred
Phases.

This branch carries the demonstrations that survived that redefinition, plus
the archive restructure. It does not carry the evaluation apparatus built for
the previous definition.

## What is demonstrated

Four acceptance scenarios have two-armed demonstrations with controls and
mutation testing. In order of how much they establish:

- Corrections and rollbacks take effect. Baseline retrieval returns a summary a
  rollback already retired; the graph withholds it and audit retrieval still
  reaches it. The only scenario so far where the baseline is simply wrong.
- Withheld records can be named. Identical results from both arms; only the
  graph can say which records it withheld and under which rule.
- Supersession follows evidence, not recency. One contradicting record does not
  retire a stable preference; three do.
- A task-scoped exception does not become a preference. Same dose and content,
  only applicability differs, and the outcomes diverge.
- Nothing is withheld anonymously. Every baseline candidate the enabled path
  drops is named with its rule, everything it adds is named with the rule that
  admitted it, and a drop no rule accounts for is reported as `unexplained`
  rather than absorbed into the nearest plausible label.
- A readiness claim names what it observed. A rollout report built from dry-run
  scenarios and validated commands is blocked rather than declared ready, and
  gates say whether an applied operation or a validated command backed them.

Classification matters here. Of fourteen acceptance scenarios, roughly one is a
value claim, four are capability claims, nine are safety claims that cannot be
demonstrated against a baseline that lacks the mechanism, and one is
unimplemented. Two scenarios were reclassified downward after testing and none
moved up, so the untested rows should be read as optimistic.

## Standing against the redefined gate

| Gate | Status                                                               |
| ---- | -------------------------------------------------------------------- |
| G1   | Four of five value/capability claims demonstrated                    |
| G2   | Met. The gap it found is closed and the fix is asserted              |
| G3   | Met at the enabled path; one qualifier below                         |
| G4   | Met for cross-user and cross-applicability; the rest has no path     |
| G5   | Measured: P95 graph-incremental latency ~`3.92 ms`, payload `5689` B |
| G6   | Met. The gap it found is closed and both arms are asserted           |

G2 found a real gap rather than confirming an assumption. Retrieval withheld
records it could not name — including the summary a rollback retires, which is
the most valuable behaviour here. It now reports both differences from the
baseline, withheld and added, each with the rule behind it, and carries them
through to the runtime type so a rollout can monitor what the gate checked.

G6 found a gap of the same shape. The rollout report could reach
`ready-for-limited-rollout` having observed nothing: dry-run retrieval
scenarios, correction and rollback gates satisfied by commands that only
validated, and a runtime gate that was added only when runtime evidence existed,
so its absence lowered the gate count rather than failing. Readiness is now
gated on observation, and gates record whether an applied operation or a
validated command backed them.

G3 and G4 were previously recorded as needing an enabled-path re-run. That was
wrong: the route tests already run under the enabled policy, and the policy is a
pure on/off gate that does not change how the graph behaves. The execution plan
records the correction, the coverage, and the one qualifier — interrupted staged
publication is proven at the library level rather than through the route.
Cross-workspace and cross-tenant isolation have no enabled path because the
runtime never populates those scopes.

## Next bounded step

G1's last claim, and it is a decision before it is a task. The acceptance table
says repeated consistent evidence should improve retrieval priority. That is
gradual rather than a state change, so a two-armed demonstration may not exist:
the baseline reorders by similarity and the graph reorders by cluster state, and
neither is wrong at a given dose. Decide whether to attempt it or reclassify it
as a capability claim before spending time there. Every other gate is met.

One product decision is still open and is not a gate: the requirements say
consistent evidence across independent contexts can broaden applicability, and
no implementation exists. Applicability is inherited from evidence and never
widened. Either the implementation or the acceptance row has to change.

Do not start from the archived apparatus. Its numbers do not yet mean what its
gates claimed, which is why it is archived.

## Held work

The Phase 4 evaluation apparatus is preserved at tag
`phase4-apparatus-archived`: paired comparison collection, labeled
observations, closure reporting, label-evidence repair tooling, and a
graph-delta negative control. Roughly eight thousand lines, tested, and not
proposed. The execution plan records why. Retrieve it if the redefined gate
turns out to need parts of it; do not resume it wholesale.

## Required reading

- [Requirements](./memory-graph-evolution-requirements.md): the acceptance
  scenario table, MR-4, MR-7, and MR-10.
- [Architecture](./memory-graph-evolution-architecture.md): applicability,
  staged publication, and rollout governance.
- [ADR index](./adr/README.md): ADR-0001 through ADR-0006.
- [Execution plan](./memory-graph-evolution-execution-plan.md): Demonstrated
  Behaviour, Deferred Phases, and Stop Line.

## Method that produced these results

Two rules did the work and should carry forward. Assert both arms, never only
the passing one — a mechanism's value is in the failure it prevents, so a test
that never lets that failure happen cannot show the value. And mutation test
every arm, because an arm that cannot fail is the same defect as a tuned
threshold. Both rules caught real errors here: a baseline arm whose assertions
held whether or not the graph was enabled, a positive result that a control
reproduced with the graph's ranking discarded entirely, and a G2 arm that
asserted over an empty set and so would have passed against any implementation.

The second rule earned its keep again in a subtler way. G2's first version let
the test infer from the snapshot why a record had been added, which meant a
mutation could disable one justification and the test would still pass on
another. A gate that asks whether the graph can explain itself must read the
graph's explanation, not reconstruct one. Mutating an assertion that consults
the wrong source is how that surfaced.

## Stop line

Do not enable any default, expand a cohort, propose the archived apparatus, or
begin Phase 5 without the redefined Phase 4 gate passing and explicit
authorization.
