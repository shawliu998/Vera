# Big @ Context

Big @ references make professional context addressable outside chat history.
Instead of saying "the late notice point above", a memo, review comment, audit
event, or agent run can preserve a typed reference such as
`@Evidence:notice-window`, `@Issue:notice-timing`, or `@Run:run-evidence-demo-001`.

This is not a social tagging system. A Big @ reference points to a professional
matter object that can be resolved, previewed, reviewed, and carried into audit
history.

## Supported Reference Types

- `@Matter`
- `@Document`
- `@Clause`
- `@Evidence`
- `@Issue`
- `@Risk`
- `@Memo`
- `@ReviewComment`
- `@Gate`
- `@Run`
- `@Playbook`
- `@Skill`
- `@EvalCase`

References can be bare when the type is unique in the local matter memory, or
qualified with a selector:

```text
@Evidence:notice-window
@Clause:chunk-notice-window
@Issue#notice-timing
@Document.pdf
@Run:run-evidence-demo-001
```

## Local-First Resolution

The first implementation builds a matter memory index from
`AgentOpsMatterWorkspace` fixtures and local state:

1. Parse typed Big @ tokens from text with `parseBigAtReferences`.
2. Index matter objects with `createMatterMemoryIndex`.
3. Resolve tokens with `resolveBigAtReferences`.
4. Attach resolved artifact refs to memo sections, review comments, agent runs,
   or audit events with `linkBigAtReferences` or `withAuditEventReferences`.
5. Offer UI insertion choices with `createBigAtAutocompleteCandidates`.

Resolution returns one of three states:

- `resolved`: exactly one local object matched.
- `ambiguous`: the reference type or selector matched multiple objects.
- `missing`: no local object matched.

Ambiguity is intentional. Professional workflows should ask for a more precise
selector rather than silently linking the wrong evidence, issue, gate, or run.

## Auditability

`AgentRun`, `DraftMemoSection`, `ReviewComment`, and `AuditEvent` now accept
optional `big_at_references`, `referenced_artifacts`, and
`big_at_resolution_records` fields. This lets Aletheia preserve the raw
user-facing reference, the resolved artifact identity, and the explicit
resolution outcome.

That dual record matters because professional work needs to show:

- what the human or agent wrote,
- what object the system resolved at the time,
- whether the object was missing or ambiguous,
- which artifact IDs were used in later review or export gates.

Only `resolved` references are promoted into `referenced_artifacts`. Ambiguous
references keep candidate artifact refs in `big_at_resolution_records`, and
missing references keep their raw text plus the missing status. That keeps final
professional outputs from silently citing the wrong object.

`@Clause` is a reference type over source-grounded evidence or document chunks,
not a separate persisted artifact yet. When a clause resolves from local matter
memory, its artifact ref points back to the supporting `evidence_item` while the
resolution metadata preserves `source_chunk_id`, document ID, page, and quote
offsets when available.

For adapter-backed audit snapshots, `auditCandidatesFromResolutions` creates a
read-only map from Big @ text to its source owner and resolution state. Resolved
records carry `resolved_artifact_refs`; ambiguous records carry only
`candidate_artifact_refs` plus a review action; missing records carry no artifact
refs and require review before professional reliance.
