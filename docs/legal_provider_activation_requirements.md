# Legal Provider Activation Requirements

Date: 2026-07-16

Status: external activation checklist; no Provider is approved or live

## 1. Current state

Vera's active product is the local general legal workspace on `main` at
`5611699e46552a20bf42ce84396a8e65aa139d16`, Workspace schema v17.

PKULaw (法宝) and YuanDian (元典) are **not activated** in the active Workspace
product. Retained Legacy adapters, response fixtures, contract tests, a saved
configuration, or a successful test double do not establish a licensed live
integration. The code-owned production activation gate remains closed.

Vera must not guess a vendor endpoint, credential type, request field,
pagination rule, response shape, source identifier, or authorization right.
It must not use browser cookies, packet capture, scraping, private interfaces,
or a generic web-search fallback.

## 2. Required vendor materials

For the selected vendor, archive a versioned official package containing:

- the contracting entity, product name, API/service edition and support owner;
- the official production and sandbox/test base endpoints;
- endpoint versioning, deprecation and change-notice policy;
- IP/domain allowlisting requirements and official TLS certificate behavior;
- the credential type, issuance/rotation/revocation workflow, scopes and expiry;
- official search, pagination, filtering and error contracts;
- official source metadata and source content/excerpt retrieval contracts;
- content identifiers, version/effective-date semantics and citation locators;
- throttling, quota, concurrency, timeout and retry guidance;
- response size limits and supported character encodings/content types;
- vendor status, maintenance, support and security-contact procedures.

The archived material must identify its source, issue date/version and
applicable environment. A sales deck, browser UI, undocumented sample, observed
network request or third-party summary is not an API contract.

## 3. Endpoint and transport checklist

The implementation cannot begin vendor wire mapping until official material
provides:

| Item | Required evidence |
| --- | --- |
| Base endpoint | Exact official HTTPS sandbox and production origins |
| Host allowlist | Exact hosts and any regional alternatives |
| Redirect policy | Whether redirects occur and the allowed destinations |
| Search path | Method/path/version and supported query/filter fields |
| Source path | Method/path/version for full text or licensed excerpts |
| Citation path | Optional official citation-resolution contract |
| Health/test path | A documented non-destructive authentication/readiness probe |
| Network limits | Timeout, retry-after, rate, concurrency and body-size guidance |
| TLS/proxy | Certificate, mTLS, proxy and enterprise-network requirements |

Vera will enforce HTTPS, exact host allowlisting, redirect control,
cancellation, bounded timeouts, response-size limits, content-type validation,
safe errors and redacted logs at the backend boundary.

## 4. Credential checklist

The vendor must document the exact credential model, for example API key,
OAuth client credential, signed request, mTLS identity, or a vendor-managed
token. Vera will not infer one from retained code.

Required decisions:

- who owns and provisions the credential;
- whether it is user-, firm-, machine-, tenant- or application-scoped;
- sandbox versus production separation;
- least-privilege scopes for search and source retrieval;
- secret format and maximum length without logging an actual secret;
- rotation, expiry, revocation and compromise response;
- whether endpoint/client/tenant identifiers are sensitive;
- whether the credential may be stored as a Keychain-backed local reference;
- whether a desktop client is an authorized use context;
- connection-test behavior that does not consume or persist licensed content.

Renderer code must never receive the secret. Production credentials must use
the active Workspace Keychain boundary; the retained Legacy application-
envelope store is not accepted as the owner for new active Provider secrets.

## 5. Search contract

Official documentation and contract tests must establish:

- request fields for query, jurisdiction, source type and date range;
- maximum query/filter/list sizes and normalization rules;
- supported authority categories and jurisdiction taxonomy;
- deterministic pagination/cursor behavior and result limits;
- stable vendor result/source identifiers;
- title, court, case number, effective date, status and summary semantics;
- whether summaries are vendor-authored, generated or licensed for model use;
- empty, partial, duplicate, stale-index and malformed-result behavior;
- authentication, authorization, quota, timeout and service-unavailable errors;
- cancellation semantics and whether server work continues after cancellation.

Search results remain bounded metadata. Vera must not treat a result-list
summary as the authoritative source text or create a legal citation from it.

## 6. Source retrieval contract

Official documentation and acceptance data must establish:

- source request identity and its relation to a previous search/session;
- whether full text, official excerpt, metadata-only or document download is
  licensed;
- maximum source/excerpt size and pagination/chunking rules;
- source/version/effective/repeal/supersession status fields;
- court, case number, article/section/paragraph/page locator semantics;
- canonical content encoding, markup and active-content handling;
- stable hash/version fields or Vera's permitted hashing behavior;
- missing, replaced, withdrawn, restricted and license-denied behavior;
- whether a retrieved source may become a local encrypted Source Snapshot;
- whether exact excerpts may be sent to a configured model and shown/exported.

`read_legal_source` can become available only when the source reference belongs
to the current Matter research session and every applicable authorization and
retention/model-use check passes.

## 7. Rights matrix

Legal/product approval must record an explicit answer for each environment and
content class:

| Right | Decision required |
| --- | --- |
| Display | May Vera show metadata, summaries, excerpts and/or full text to the licensed user? |
| Local retention | What may be stored locally, encrypted or cached, and for how long? |
| Derived snapshots | May Vera hash/version content and keep a source identity or excerpt after expiry? |
| Model use | May queries, metadata, excerpts or full text be sent to which model/provider/region? |
| Training use | Must the selected model guarantee no training or zero retention? |
| Export | May metadata, quotes, citations or full text appear in DOCX/export bundles? |
| Onward distribution | May an exported Draft be shared with clients/courts/third parties, and under what limits? |
| Backup/restore | May retained content enter encrypted backup and be restored later? |
| Deletion | What tombstone/purge/credential-revocation obligations apply? |
| Audit/logging | Which bounded identifiers/metrics may be recorded without retaining licensed text? |

Any unknown, conditional or denied right must map to a fail-closed product
state. `configured_unverified` and `activation_gate_closed` are not `ready`.

## 8. DPA, SLA and data-region checklist

Before production activation, record:

- applicable DPA and roles of each party;
- whether query text, source identifiers, user/account data or telemetry are
  personal/confidential data;
- processing and storage regions and any cross-border transfer terms;
- vendor subprocessors and model/analytics services, if any;
- retention/deletion periods for requests, logs and retrieved content;
- encryption in transit/at rest commitments;
- breach/incident notification timing and contact path;
- availability SLA, planned maintenance, support response and escalation;
- audit/compliance reports available under the agreement;
- suspension, termination, export and post-termination deletion behavior.

These decisions must align with Matter inference policy and Source retention
policy. Endpoint geography alone never proves an execution location or a data
use rule.

## 9. Licensed test account and acceptance data

Required before live acceptance:

- a vendor-authorized sandbox or production test account;
- a credential that may legally be used by this desktop client;
- a named internal owner and expiry/revocation date;
- representative acceptance queries covering statutes/regulations,
  judicial interpretations and cases supported by the contract;
- known expected source IDs/titles/versions/effective dates;
- at least one no-result case;
- authentication failure, license restriction, quota/rate and timeout cases;
- one source allowed for retention/model use/export and, where available, one
  source that exercises each denied/conditional policy;
- Chinese/Unicode and pagination fixtures derived only where the agreement
  permits retaining them;
- a cleanup plan for test queries, local snapshots and credential references.

Acceptance data must not contain an actual secret in the repository, logs,
screenshots, fixture files or reports.

## 10. Required live acceptance

Using the licensed account, separately from deterministic tests:

1. save a Keychain-backed credential reference and verify truthful status;
2. perform the documented non-destructive connection/readiness check;
3. search with a known authorized query;
4. verify pagination and structured metadata;
5. fetch one permitted source/excerpt;
6. create the allowed encrypted Source Snapshot and Citation Anchor;
7. let the Matter Assistant read the snapshot and produce a verifiable legal
   citation alongside a local-document citation;
8. create a new Studio Draft using only permitted source identities;
9. edit through a user-reviewed suggestion and export an allowed DOCX;
10. restart Vera and verify retained content remains readable, or becomes
    unavailable exactly as the vendor retention rule requires;
11. verify cancellation, timeout, license denial and credential revocation;
12. record provider/version/environment, command/test evidence and known limits
    without recording secrets or licensed full text.

Only this non-fixture vertical may change the selected Provider state to
`ready` and support a live-capability claim.

## 11. Deterministic fake Provider boundary

A deterministic fake Provider is allowed only for automated unit, contract and
packaged E2E tests. It must:

- register only in an explicit test environment;
- never appear in production Settings or default runtime composition;
- use synthetic/licensed-for-test content;
- exercise search, read, policy, failure, cancellation and restart behavior;
- be labeled test evidence in every report.

Fake-provider success, mock HTTP success, fixture replay and Legacy adapter
tests are not live Provider acceptance and must never be used to state that
法宝、元典 or another commercial database is connected.

## 12. Activation decision record

Before opening the production gate, the release record must name:

- chosen Provider and contract/API version;
- archived official-material references;
- credential owner and Keychain reference class (never the secret);
- enabled capabilities and denied/conditional capabilities;
- completed rights, DPA, SLA and data-region reviews;
- exact live acceptance environment and timestamp;
- passing test/build/package commands and artifact commit;
- remaining limitations, rollback owner and vendor escalation contact.

If any required item is absent, the correct product state is unavailable,
not configured, configured unverified, license restricted, or activation gate
closed—not ready.
