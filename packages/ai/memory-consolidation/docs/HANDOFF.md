# Memory Graph Handoff

Status: `PHASE_0_3_SHIPPED_PHASE_4_GATE_REDEFINED`

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

Classification matters here. Of fourteen acceptance scenarios, roughly one is a
value claim, four are capability claims, nine are safety claims that cannot be
demonstrated against a baseline that lacks the mechanism, and one is
unimplemented. Two scenarios were reclassified downward after testing and none
moved up, so the untested rows should be read as optimistic.

## Standing against the redefined gate

| Gate | Status                                                               |
| ---- | -------------------------------------------------------------------- |
| G1   | Four of five value/capability claims demonstrated                    |
| G2   | Not attempted — the substantive gap                                  |
| G3   | Covered by tests, but run default-off; needs an enabled-path run     |
| G4   | Same as G3                                                           |
| G5   | Measured: P95 graph-incremental latency ~`3.92 ms`, payload `5689` B |
| G6   | Not started                                                          |

## Next bounded step

G2. It is the only gate that is both unattempted and directly about the risk of
turning defaults on, and it needs no new cohort: assert that the enabled path
withholds nothing without a nameable reason, and that everything withheld stays
reachable through audit retrieval. The four existing demonstrations show the
shape.

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
held whether or not the graph was enabled, and a positive result that a control
reproduced with the graph's ranking discarded entirely.

## Stop line

Do not enable any default, expand a cohort, propose the archived apparatus, or
begin Phase 5 without the redefined Phase 4 gate passing and explicit
authorization.
