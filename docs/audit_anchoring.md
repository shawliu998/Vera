# Independent audit anchoring

Aletheia can append signed audit-head snapshots to an operator-controlled
directory outside `ALETHEIA_DATA_DIR`. This provides a verification boundary
separate from the SQLite data, per-matter HMAC key, and application-encryption
master key.

Each JSONL entry contains:

- every current matter's event count, invalid-chain count, last sequence, and
  last HMAC event hash;
- a deterministic chain head over all current deletion tombstones;
- the previous signed anchor hash;
- an Ed25519 operator-key identifier and signature over the canonical body.

The writer validates the complete existing chain before every append. It uses
an exclusive cooperative writer lock, opens the journal with append and
no-follow flags, refuses a size change after verification, writes without an
overwrite/truncate code path, calls `fsync`, and requires owner-only directory
and journal permissions. Symbolic-link anchor targets are rejected.

## Packaged Vera configuration

In `Vera.app`, open **Settings > Safety > Audit anchor**, choose an external
directory, and confirm the native macOS warning. Vera creates a dedicated
owner-only `Vera Audit Anchor Journal` directory, provisions or reuses an
Ed25519 key pair in its owner-only application support directory, writes the
configuration atomically, and restarts both local services. The renderer sees
only the journal location and public-key identifier; it never receives the
private-key path or private-key material.

Desktop-managed anchoring always enables high-assurance mode. If the signed
journal cannot be verified or advanced, startup fails closed; a later anchor
failure blocks HTTP state changes and new durable-agent work until anchoring
recovers. If configuration or restart fails, Vera restores the prior
configuration and attempts to restart the prior service state. Disabling the
control stops future writes but deliberately preserves the key pair and all
existing journal entries.

Launch-environment `ALETHEIA_AUDIT_ANCHOR_*` values take precedence and make
the Settings control read-only. This preserves centrally managed deployments
and prevents the renderer from weakening their policy.

The encrypted workspace backup does not establish an independent witness. Keep
the public-key fingerprint and latest journal head through a separate trusted
channel, and escrow the private key under the operator's recovery procedure.
Losing the private key prevents future continuity; storing the only journal,
key, and expected head with the workspace defeats the independent boundary.

Signed snapshot transitions are forward-only: matter audit counts and sequence
heads cannot regress, a hash cannot change without sequence advancement, and a
matter cannot disappear unless the deletion-tombstone chain advances. Restoring
an older SQLite backup against a newer journal is therefore treated as a
rollback incident rather than silently signed as the new head.

## Generate independent operator keys

Choose paths outside the vault. The private key is written as PKCS#8 with mode
`0600`; the public key is distributable SPKI material and should be copied to a
separate verification workstation or evidence store.

```bash
cd backend
ALETHEIA_DATA_DIR=/path/to/aletheia-data \
ALETHEIA_AUDIT_ANCHOR_PRIVATE_KEY_FILE=/secure/operator/anchor-private.pem \
ALETHEIA_AUDIT_ANCHOR_PUBLIC_KEY_FILE=/secure/operator/anchor-public.pem \
npm run generate:aletheia:audit-anchor-keys
```

Do not reuse `.audit-hmac-key`, the application-encryption key, a download
signing secret, or any model/provider credential.

An existing Ed25519 pair can be validated and copied without overwriting its
destination:

```bash
ALETHEIA_DATA_DIR=/path/to/aletheia-data \
ALETHEIA_AUDIT_ANCHOR_IMPORT_PRIVATE_KEY_FILE=/encrypted-media/private.pem \
ALETHEIA_AUDIT_ANCHOR_IMPORT_PUBLIC_KEY_FILE=/encrypted-media/public.pem \
ALETHEIA_AUDIT_ANCHOR_PRIVATE_KEY_FILE=/secure/operator/anchor-private.pem \
ALETHEIA_AUDIT_ANCHOR_PUBLIC_KEY_FILE=/secure/operator/anchor-public.pem \
ALETHEIA_AUDIT_ANCHOR_KEY_IMPORT_CONFIRM=import-ed25519-keypair \
npm run import:aletheia:audit-anchor-keys
```

## Manual anchor and verification

Configure the common paths, then append and verify:

```bash
export ALETHEIA_DATA_DIR=/path/to/aletheia-data
export ALETHEIA_AUDIT_ANCHOR_DIR=/Volumes/EncryptedAnchors/journal
export ALETHEIA_AUDIT_ANCHOR_PRIVATE_KEY_FILE=/secure/operator/anchor-private.pem
export ALETHEIA_AUDIT_ANCHOR_PUBLIC_KEY_FILE=/secure/operator/anchor-public.pem

ALETHEIA_AUDIT_ANCHOR_REASON=operator_daily \
npm run anchor:aletheia:audit

npm run verify:aletheia:audit-anchors
```

Verification compares the latest signed snapshot to the current SQLite state by
default. Retain a known journal head on another system and pass it during later
verification to detect deletion of the current tail:

```bash
ALETHEIA_AUDIT_ANCHOR_EXPECTED_HEAD_HASH=sha256:... \
npm run verify:aletheia:audit-anchors
```

Without an independently retained head or witness, deleting the newest journal
tail cannot be distinguished from a system that simply stopped producing
anchors. Middle deletion, reordering, record edits, truncation, and wrong-key
verification are detected by the internal chain.

The running process remembers its last successful head and rejects same-process
tail deletion on the next append. Across a restart, configure the independently
retained value as `ALETHEIA_AUDIT_ANCHOR_EXPECTED_HEAD_HASH`; otherwise the new
process has no external fact with which to distinguish a deliberately removed
tail from the last available journal state.

## Portable verification bundle

The bundle contains the signed entries and public key plus a signed bundle
manifest. It is owner-only and must be written outside the vault because matter
identifiers and audit-head metadata can be sensitive.

```bash
ALETHEIA_AUDIT_ANCHOR_BUNDLE_OUT=/secure/evidence/anchors-2026-07-10.json \
npm run export:aletheia:audit-anchor-bundle

ALETHEIA_AUDIT_ANCHOR_BUNDLE_FILE=/secure/evidence/anchors-2026-07-10.json \
npm run verify:aletheia:audit-anchors
```

Recipients must compare the included public key identifier to a public key
obtained through a trusted independent channel. A self-contained bundle whose
public key has never been trusted cannot establish operator identity by itself.

## Periodic and high-assurance mode

```bash
ALETHEIA_AUDIT_ANCHOR_ENABLED=true
ALETHEIA_AUDIT_ANCHOR_HIGH_ASSURANCE=true
ALETHEIA_AUDIT_ANCHOR_INTERVAL_MS=900000
```

When enabled, the backend anchors at startup, on the configured interval, and
after workers stop during shutdown. Failures appear in `/health` and the
authenticated `/aletheia/security-policy`. In high-assurance mode, a startup
failure prevents the backend from listening; a later failure blocks HTTP state
changes and prevents the durable worker from claiming new runs until a signed
runtime anchor succeeds again. A step already executing when storage fails may
still reach its local error/completion path before the guard is observed, so
operational monitoring should stop the process promptly on a degraded health
signal.

The minimum interval is 60 seconds. Periodic anchoring is not a substitute for
anchoring after every transaction, and the journal contains state heads rather
than full event content.

## WORM and administrator boundary

An ordinary external directory, encrypted USB volume, NAS share, or read/write
filesystem is not automatically WORM. The application refuses overwrite and
truncation, but an administrator controlling the unlocked OS account, signing
private key, vault, and ordinary journal storage can rewrite all of them. Strong
assurance requires the operator to provide one or more of:

- storage that independently enforces append-only/WORM retention;
- a remote transparency or timestamping service;
- offline signed bundles and journal heads held by a separate custodian;
- separation of duties around the private key and vault administration.

A read-only medium must be made append-capable for a manual anchor, or receive a
bundle through its approved ingestion workflow. The backend does not infer WORM
semantics from a filesystem path or mount label.

Run `npm run test:aletheia:audit-anchors` to exercise tamper, deletion,
reordering, truncation, wrong-public-key, symlink, inside-vault-path, bundle, and
restart-continuation checks.

## Litigation sign-off coverage

When the anchor runtime is enabled, Vera can bind an immutable litigation
matter-audit sign-off to its exact HMAC audit event and ask a global
administrator to append an external Ed25519 anchor. Direct anchoring is allowed
only while that sign-off event remains the exact matter audit head. The proof
endpoint revalidates the sign-off/event binding, complete matter HMAC chain,
signed external journal and independently configured expected head before it
reports coverage.

The receipt UI preserves a verified historical anchor after later matter
changes mark the underlying package stale. It does not present historical
coverage as proof that the package is still current. Counsel and audit readers
may inspect coverage; only a global administrator can append the anchor.

This is an operator-key-signed local audit-head inclusion proof. It is not a
qualified electronic signature, trusted timestamp, digital certificate,
independent notarization or proof of the signer's legal identity. A recipient
must obtain the public-key fingerprint and latest expected journal head through
an independent channel; otherwise an administrator who controls the vault,
ordinary anchor storage and key can replace the trust root and tail together.
