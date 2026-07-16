# Gate 1 Stabilization Review Checklist

Date: 2026-07-16

Status: **implementation and local packaged acceptance complete; remote
final-commit CI pending**

This is an evidence checklist, not a completion declaration. An item is checked
only when its evidence belongs to the final candidate commit/artifact.

## Gate 1A — Legacy isolation

- [x] Legacy routes/runtime require exact opt-in and remain disabled by default.
- [x] Legacy route modules are lazy and unevaluated while disabled.
- [x] Legacy `/aletheia` mutation/auth order and the normal `/api/v1` auth,
  mutation, and upload limits are retained.
- [x] Local ops readiness audit recognizes the current bootstrap invariants.

## Gate 1B — Matter Profile and classification

- [x] Immutable v15 is preserved; v16 is additive.
- [x] Existing rows remain `classification_required` until explicit selection.
- [x] New Profiles require one of the six exact `workspace_type` values.
- [x] No v15 `matter_type` value is mapped or exposed publicly.
- [x] New rows write only the private `general` compatibility sentinel.
- [x] Fresh, prefix-upgrade, SQLCipher, checksum, rollback, and restart audits
  pass locally.

- [x] GET/POST `/api/v1/matters` and GET/PATCH Matter detail are authenticated.
- [x] GET/POST/PATCH Project Profile subresource remains explicit.
- [x] GET/PATCH Matter Policy is complete-replacement and fail-closed.
- [x] Project General plus Profile PATCH uses one `BEGIN IMMEDIATE` transaction,
  one monotonic timestamp, and full rollback on Profile failure.
- [x] Archived/deleted Projects reject Profile, combined, and policy mutation.
- [x] Public serialization is strict and contains no `matter_type`.

## Gate 1C — Minimal inference policy

- [x] One policy resolves Global, generic Project, and Matter scopes from
  durable state.
- [x] Model location/retention/training/sensitive-data attributes are explicit;
  URL/provider heuristics are forbidden.
- [x] Missing Matter policy and empty location list deny.
- [x] `approval` remains `require_approval`; it is not silently allowed.
- [x] Capability reads use side-effect-free `evaluate` and do not write the
  decision ledger.
- [x] Assistant and Workflow have enqueue plus final provider-boundary checks.
- [x] Tabular has preparation plus final cell-provider-boundary checks.
- [x] Studio has no standalone provider generator; Assistant-created
  suggestions inherit the Assistant boundary, and `studio_suggestion` remains
  reserved for any future direct generator.
- [x] Active/archived/deleted capability matrices and default-model readiness
  are covered.

## Gate 1D — Continuous Matter shell

- [x] `profile_state` supports `profiled`, `ready`,
  `classification_required`, `absent`, and `all`.
- [x] SQL filters before cursor/order/limit; filtered cursors are not reusable
  across streams.
- [x] The UI independently paginates profiled and absent rows and labels counts
  as loaded, not total.
- [x] Matter route adapter keeps reused Documents, Studio, Assistant, Workflow,
  and Tabular navigation in `/matters/:id/**`.
- [x] Dynamic `/projects/:id/**` compatibility routes remain valid.
- [x] Drafts is document-scoped and does not claim a Matter-wide Draft store.
- [x] The current `/review` route is documented as Tabular compatibility;
  backend Review Center capability remains unavailable.
- [x] Chinese/English shell-source checks pass locally.

## Gate 1E — CI and packaged acceptance

- [x] Run 29465212424's two failing root causes are recorded separately from
  non-failing warnings.
- [x] Correct local commands pass for ops readiness and Mike source locks.
- [ ] Full CI passes on the final candidate commit.
- [x] `./scripts/package-desktop-mac.sh` completes from the final source
  worktree in unsigned local-only mode.
- [x] Packaged app startup, migration, interrupted-restore recovery, backup,
  restore fail-closed, OCR, and Workspace E2E pass.
- [x] `packagedWorkspaceE2E.js` is updated from the old `inference` capability
  and denial-only Matter path to the v17 six-field capabilities and a successful
  Matter path: create Matter → declare model privacy → replace Matter Policy →
  complete Assistant turn → restart → verify Matter/Profile/Policy/chat/source.
- [x] Cross-restart Matter create/classify/edit/policy/inference/navigation is
  recorded against the built artifact.
- [x] Artifact SHA, macOS/architecture, local-only/signing/notarization state,
  and logs are retained.
- [ ] The pushed final commit and its remote CI result are bound to the handoff
  evidence.

Gate 2 may start only after the unchecked remote item is resolved. Its first
slice remains Proposal Contract → Review Center; this checklist does not
authorize a broader Review, Work Queue, knowledge, or automation expansion.
