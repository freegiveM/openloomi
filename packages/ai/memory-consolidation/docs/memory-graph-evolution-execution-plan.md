# Dynamic Memory Cluster Evolution Execution Plan

Status: `PHASE_0_3_DRAFT_PR_STACK`

## Objective

Prepare the accepted foundation and controlled write loop, controlled retrieval
loop, and authorized correction loop as three serial, reviewable experimental
Draft PR candidates. The stack remains disabled by default and does not
authorize a runtime cohort or rollout.

## Delivery Rules

- Requirements define product outcomes; architecture defines boundaries and
  invariants; ADRs hold durable decisions; this plan defines authorization and
  gates.
- Keep graph mutation, retrieval, correction, and rollback server-gated.
- Preserve source evidence, owner isolation, applicability, baseline fallback,
  operation identity, and retryable recovery.
- Do not add UI, scheduling, migration, shared memory, real-time LLM
  dependencies, or default-on behavior.
- A Draft PR stack may be published only after each candidate passes its own
  focused gate and the integrated Phase 0-3 gate passes.

## Review Order

| Candidate | Scope                                           | Dependency    |
| --------- | ----------------------------------------------- | ------------- |
| 1         | Phase 0-1 foundation and controlled write loop  | `origin/main` |
| 2         | Phase 2 trusted retrieval loop                  | Candidate 1   |
| 3         | Phase 3 authorized correction and rollback loop | Candidate 2   |

Later-phase imports, exports, route actions, tests, and status claims must not
appear in an earlier candidate.

## Candidate Scope

### Phase 0: control-plane foundation

**Outcome.** Provide owner-scoped graph contracts, staged publication, and
audit helpers.

**Gate.**

- Plans are deterministic, versioned, explainable, and safe to replay.
- Publication preserves visible evidence across partial failures.
- Audit can recover source nodes, edges, and operation identities.

### Phase 1: controlled real write loop

**Outcome.** New saved-chat evidence can evolve durable long-term memory for a
server-selected cohort.

**Included.**

- Persistent owner-scoped graph snapshots and applied-operation history.
- Evidence accumulation, reinforcement, competition, cluster lifecycle, staged
  summary publication, and source soft deprecation.
- Server-resolved owner scope, write allowlist, kill switch, revision
  protection, idempotent replay, and baseline fallback.
- Postgres, SQLite, and IndexedDB-compatible storage boundaries used by the
  existing raw-message runtime.

**Gate.**

- Repetition, temporary override, scope isolation, failure, retry, disablement,
  and kill-switch behavior pass focused runtime tests.
- Untrusted raw writes cannot select graph scope or internal graph metadata.

### Phase 2: controlled real retrieval loop

**Outcome.** Graph judgments can change one authenticated native-agent memory
context without weakening baseline safety.

**Included.**

- `default` retrieval suppresses superseded evidence when a usable
  representative exists.
- `audit` retrieval restores retained sources and provenance.
- `conflict` retrieval exposes only active, applicable alternatives with usable
  provenance.
- Persisted raw and summary materialization, partial graph coverage, trusted
  applicability, owner/workspace/tenant isolation, and prompt framing.
- Artifact-only rollout evaluation reports retrieval and audit scenarios but
  cannot enable a cohort.

**Gate.**

- Default suppression, audit recovery, conflict explanation, representative
  materialization, applicability, owner isolation, and baseline fallback pass.
- Missing, stale, mismatched, or unmaterializable graph state produces an
  explicit no-op or baseline result.

### Phase 3: authorized correction and rollback loop

**Outcome.** An explicitly authorized operator can repair graph outcomes and
recover evidence without direct storage surgery.

**Included.**

- Deterministic correction and rollback planning with reason codes and
  preserved operation ordering.
- Correction of summary content, cluster membership, lifecycle, and
  representative choice.
- Evidence-first rollback with status, reason codes, restored source IDs,
  provenance, idempotence, version checks, and retry convergence.
- Server-derived owner/requester identity, correction enablement, operator
  allowlist, kill switch, and bounded command validation.

**Gate.**

- Wrong merge, wrong representative, lifecycle repair, rollback ordering,
  partial failure, retry, history preservation, authorization, malformed input,
  and scope isolation pass.
- No unresolved high-severity finding remains after integrated review.

## Demonstrated Behaviour

Correctness tests show a mechanism does what it was specified to do. They
cannot show it is worth its complexity, because they never let the failure it
prevents actually happen. These demonstrations assert both arms: what the
baseline does with the same evidence, and what changes with the graph enabled.

Each runs through the real ingestion and retrieval paths, pairs every claim
with a control that removes the graph's knowledge while keeping its mechanics,
and is mutation tested so no arm can pass vacuously.

**Corrections and rollbacks take effect.** `memory_summaries` carries no
deprecation or visibility column, while `raw_messages` carries `deprecatedAt`.
A raw record can therefore be hidden without the graph; a summary cannot.
Baseline retrieval returns a summary a rollback already retired alongside the
one that replaced it, indistinguishable from live content. With the graph both
are absent from default retrieval and still reachable through audit retrieval.
Removing only the supersession record from the snapshot brings the summary
back, so the suppression follows that record rather than incidental filtering.

**Supersession follows evidence, not recency.** One contradicting record leaves
a stable preference at `default` with no cluster superseded; three retire it to
`audit-only` and mark its cluster `superseded`. Identical mechanics, more
evidence. Given the same two-phase evidence with the graph disabled the
baseline creates no summary and deprecates nothing, so this is a capability the
graph adds rather than a baseline defect it repairs.

**A task-scoped exception does not become a preference.** Three contradicting
records claiming global validity retire the standing preference; the same three
scoped to one task leave it standing and produce two coexisting `stable`
clusters. Dose, content, and mechanics are identical and only the applicability
differs, which makes the global arm the control for the scoped one.

**Withheld records can be named.** Given one candidate set that includes the
deprecated sources, both arms return the same single representative. The graph
also reports which three records it withheld and under which rules,
`default_hides_deprecated_raw` and `cluster_representative_prioritized`. The
baseline response carries the results plus three counters and no list-shaped
field at all, so there is nowhere for an account of withheld records to live;
it drops the same three silently. Removing the deprecation record from the
snapshot empties that accounting, so it follows the record rather than the
shape of the query. Nothing about result quality is in question here — the two
arms agree on the answer and differ on whether the answer can be explained,
which is what MR-10 asks for.

One result is recorded for what it rules out. Deduplication of repeated imports
has a real downstream effect inside the graph — one node instead of three, a
`forming` cluster instead of `stable`, no summary instead of one — but with the
graph disabled neither case consolidates at all. The baseline has no support
counter to inflate, so that rule protects the graph from itself rather than
repairing anything. Claims of that shape cannot be demonstrated against the
baseline, and manufacturing a comparison for them would only produce a
strawman.

## Draft PR Gate

The Phase 0-3 stack is ready only when:

1. Phase 4 persisted comparison evidence and its route policy, metadata, tests,
   and current-state documentation are absent.
2. All feature policies remain default-off and fail closed.
3. Focused write, retrieval, correction, rollback, route, and backend suites
   pass.
4. `apps/web` and memory-consolidation TypeScript checks pass.
5. Formatting, targeted lint, `git diff --check`, and final diff review pass.
6. The PR description references requirements, architecture, and applicable
   ADRs without copying them.

## Deferred Phases

### Phase 4: is it safe to turn on

Not authorized in this candidate. Phase 4 decides one thing: whether the
memory-graph defaults may be enabled for real users. That is a question about
safety and demonstrated behaviour rather than about winning a retrieval
benchmark, and the gates below are ordered accordingly.

**G1 — Demonstrated behaviour.** Every acceptance scenario classified as a
value or capability claim has a demonstration asserting both arms: what the
baseline does with the same evidence, and what changes with the graph enabled.
Each pairs its claim with a control that removes the graph's knowledge while
preserving its mechanics, and each arm is mutation tested. A scenario whose
baseline arm shows no failure is recorded as a safety claim rather than
converted into a comparison.

**G2 — No regression on the path being enabled.** Every result the baseline
would have returned is either still returned, or withheld for a reason the
graph can name — superseded, audit-only, out of applicability, or out of owner
scope — and every withheld result stays reachable through audit retrieval.
Nothing appears that the baseline would not have surfaced and the graph cannot
justify. This is a set relation with stated justifications and needs no
threshold.

**G3 — Failure and recovery hold when enabled.** Partial writes, cross-store
divergence, interrupted publication, and replayed operations converge or fail
closed with the raw evidence chain intact.

**G4 — Isolation holds when enabled.** No cross-user, cross-workspace,
cross-tenant, or cross-applicability result is reachable.

**G5 — Cost within budget.** Graph-incremental latency and payload stay within
the recorded budgets.

**G6 — Runtime readiness.** Established by trusted observed behaviour rather
than configuration strings.

G3 and G4 are already covered by tests, but those run against the default-off
configuration; the gate requires them against the enabled one.

**What this gate deliberately excludes.** Aggregate retrieval quality. A local
cohort's recall against a fixed similarity threshold measures the embedding
model's fit to a set of queries. That is a real product concern and it is
currently poor, but the memory graph neither causes it nor can repair it, and
gating a graph decision on it blocks Phase 4 for reasons unrelated to the
graph. Three facts support this, each checkable in the code rather than
inferred from a measurement: the recall gate scores the product semantic path
and not the graph-aware one; graph-aware retrieval re-ranks and filters
baseline candidates and so cannot manufacture recall the baseline lacked; and
the one behaviour the capability demonstrably changes, withholding a summary a
correction or rollback retired, does not alter whether an expected record was
retrieved.

This is a change of scope and not a lowered bar. Retrieval quality needs its
own workstream and its own evidence, and Phase 5 must not read this gate's
passing as a statement about it.

An evaluation apparatus for an earlier definition of this phase was built
locally and is deliberately
not proposed here. It collects paired baseline-versus-graph evidence, labels it
against a single owner's real query history, and reduces both to a fail-closed
closure verdict. It is complete and tested, and it is held back for two
reasons.

It did not establish that the capability is valuable. Its verdict is blocked,
and the one positive signal it produced — a mean graph recall delta above
budget — was refuted by a negative control: discarding the graph's ranking and
keeping only its record-removal decision reproduces the same recall exactly, so
the delta carries no ranking contribution. Two design faults surfaced with it.
The paired comparison issues no query, so it never measured per-query retrieval
quality; and the recall gate scores the product semantic path rather than the
graph-aware path it was read as scoring.

It is also too large to review against so little settled meaning: roughly eight
thousand lines whose central numbers cannot yet be explained. Proposing it in
that state would ask reviewers to accept an instrument before its readings mean
anything.

What that work did produce is in this candidate: the demonstrations recorded
under Candidate Scope, and the method behind them.

### Phase 5: gradual rollout

May begin only after Phase 4 passes and the project owner explicitly approves a
limited rollout. It must retain scope-based expansion, kill-switch containment,
and rollback.

Rollout monitors the same properties Phase 4 gates on, and for the same reason
the gate excludes aggregate retrieval quality: a signal that does not track the
thing being rolled out cannot steer the rollout. Concretely, monitoring watches
for results the enabled path withholds without a nameable reason (G2), for
isolation breaches (G4), and for latency or payload beyond budget (G5). A
retrieval-quality regression is worth knowing about but belongs to the separate
workstream and is not a rollback trigger here.

Enabling is currently coarser than the evidence. Graph write and graph-aware
retrieval share one policy, so the behaviour with the strongest evidence cannot
be enabled without the ones that have none. Phase 5 must either accept that
bundle and gate on the whole of it, or add a retrieval seam first. That choice
is open.

### Phase 6: maturation

Product UX, scheduling, storage optimization, optional artifact generation, and
shared-memory design require separate authorization after validated rollout.
This remains a list of candidates rather than a specification, and should stay
empty until something concrete needs to go in it.

## Stop Line

Stop at `PHASE_0_3_DRAFT_PR_STACK` or
`PHASE_0_3_DRAFT_PR_SPLIT_BLOCKED`. Do not collect cohort observations,
implement Phase 4 persistence, expand runtime exposure, merge a pull request,
or enter the next phase without explicit approval.
