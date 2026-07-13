# Local application encryption

Aletheia can encrypt uploaded source files and persisted local exports with a
versioned AES-256-GCM envelope. Encryption is authenticated, uses a fresh
96-bit nonce per write, and binds the envelope to both its file purpose and its
path relative to `ALETHEIA_DATA_DIR`. Moving an encrypted file to another
matter or storage path, changing its header, or modifying its ciphertext causes
decryption to fail.

This feature has no embedded default key. Backend-only operators select an
independent key source:

```bash
export ALETHEIA_APPLICATION_ENCRYPTION=required
export ALETHEIA_MASTER_KEY_SOURCE=env
export ALETHEIA_MASTER_KEY_BASE64="$(openssl rand -base64 32)"
```

For unattended deployments, `ALETHEIA_MASTER_KEY_SOURCE=file` and
`ALETHEIA_MASTER_KEY_FILE=/secure/operator/aletheia-master-key` are supported.
The key file must contain 32 raw random bytes, base64, or 64 hexadecimal
characters and must be owner-only (`0600`) on POSIX hosts. It must not be stored
inside `ALETHEIA_DATA_DIR`, copied into an export, or committed to source
control.

The macOS desktop app defaults file encryption to `required`. It creates a
random 32-byte key in the current user's login Keychain under the fixed
`com.aletheia.desktop.application-encryption` service. Keychain does not require
an Apple Developer account. Failure to create or read the item prevents the
desktop services from starting; the key is never written to application logs or
sent to the renderer. Initial Keychain provisioning supplies the secret over
the `security` process's standard input, not in its command-line arguments. The
backend caches the Keychain value in its private process after startup to avoid
repeated synchronous Keychain reads.

## Existing plaintext migration

Back up the data directory and independently escrow the master key first. Run a
dry run, review every candidate, then explicitly apply the migration:

```bash
cd backend
ALETHEIA_DATA_DIR=/path/to/aletheia-data \
ALETHEIA_APPLICATION_ENCRYPTION=required \
ALETHEIA_MASTER_KEY_SOURCE=file \
ALETHEIA_MASTER_KEY_FILE=/secure/operator/aletheia-master-key \
npm run migrate:aletheia:encrypt-files

ALETHEIA_ENCRYPTION_MIGRATION_APPLY=true \
ALETHEIA_DATA_DIR=/path/to/aletheia-data \
ALETHEIA_APPLICATION_ENCRYPTION=required \
ALETHEIA_MASTER_KEY_SOURCE=file \
ALETHEIA_MASTER_KEY_FILE=/secure/operator/aletheia-master-key \
npm run migrate:aletheia:encrypt-files
```

The migration walks `documents/` and matter-data files under `exports/`
without following symbolic links. It excludes `exports/local-packages/`, which
contains distributable application packaging rather than matter data. It is
atomic per file and idempotent. Already encrypted files are authenticated on
every run. Required mode rejects legacy plaintext reads unless
the operator deliberately sets `ALETHEIA_ALLOW_LEGACY_PLAINTEXT_READ=true` for
a short migration window.

## Controlled recovery

Recovery writes plaintext to an explicit owner-only output file and never to
stdout:

```bash
ALETHEIA_DATA_DIR=/path/to/aletheia-data \
ALETHEIA_APPLICATION_ENCRYPTION=required \
ALETHEIA_MASTER_KEY_SOURCE=file \
ALETHEIA_MASTER_KEY_FILE=/secure/operator/aletheia-master-key \
ALETHEIA_RECOVERY_INPUT=/path/to/aletheia-data/exports/matter/file.json \
ALETHEIA_RECOVERY_OUTPUT=/secure/recovery/file.json \
npm run recover:aletheia:decrypt-file
```

Losing the master key makes encrypted files unrecoverable. Data backups and key
escrow must therefore be separate, tested processes. The current format does
not provide automatic key rotation.

Before moving a vault to another Mac, export the current key only to an
encrypted, access-controlled operator escrow destination. This command writes
32 raw bytes with owner-only permissions and never prints the key:

```bash
ALETHEIA_APPLICATION_ENCRYPTION=required \
ALETHEIA_MASTER_KEY_SOURCE=macos_keychain \
ALETHEIA_KEY_ESCROW_OUTPUT=/Volumes/EncryptedEscrow/aletheia-master-key \
ALETHEIA_KEY_ESCROW_CONFIRM=export-master-key \
npm run escrow:aletheia:master-key
```

On the destination Mac, restore the data directory, then import that exact key
into the fixed desktop Keychain item. Import sends the key to `security` over
standard input rather than argv:

```bash
ALETHEIA_MASTER_KEY_SOURCE=file \
ALETHEIA_MASTER_KEY_FILE=/Volumes/EncryptedEscrow/aletheia-master-key \
ALETHEIA_KEYCHAIN_IMPORT_CONFIRM=replace-keychain-key \
npm run import:aletheia:keychain-key
```

Run a decryption recovery test before declaring the migration complete. Keep
the escrow copy separate from data backups and restrict both operations to an
authorized operator. Any process controlling the unlocked OS account can still
invoke the same Keychain identity; application encryption does not defend
against a fully compromised logged-in account.

The desktop **Create backup** action derives a separate backup key from this
application master key with HKDF-SHA256 and writes an authenticated AES-256-GCM
archive. **Check backup** is non-destructive: it verifies the envelope, archive
structure, required paths, and manifest hashes but does not extract or replace
the active workspace. Because the archive contains a SQLCipher database, a
cross-Mac recovery also requires the independent database key described below.
Escrow both keys separately from the backup; the application does not embed a
recovery key in the archive.

## SQLite boundary

Backend-only deployments retain the compatibility default
`ALETHEIA_DATABASE_ENCRYPTION=metadata_plaintext`, which uses `node:sqlite`.
The packaged macOS desktop app defaults to `sqlcipher_required` and provisions
its independent database key in the login Keychain. In plaintext-metadata mode,
the database contains readable matter/document metadata, parsed document chunks
and FTS terms, work-product content, audit details, and workflow records. File-
envelope encryption must not be represented as whole-application or whole-
database encryption.

`ALETHEIA_DATABASE_ENCRYPTION=sqlcipher_required` selects the bundled
`@signalapp/sqlcipher` adapter. Required mode loads an independent database
key, requires a non-empty `cipher_version`, performs a keyed schema read, runs
`cipher_integrity_check` for an existing database, and refuses startup on any
failure. It never falls back to `node:sqlite`. Existing plaintext databases
must be migrated offline before this mode is enabled; the packaged desktop app
intentionally fails closed rather than performing an implicit migration. See
[SQLCipher integration](sqlcipher_integration.md) for key custody, migration,
verification, backup, and rollback instructions.

The optional local semantic JSON index is stored outside SQLite. SQLCipher does
not encrypt it. It is disabled in desktop defaults; if enabled, the index needs
its own application-encryption design or an encrypted volume and backup.

Run `npm run test:aletheia:encryption` to verify round-trip encryption, tamper,
relocation, wrong-key rejection, and plaintext file migration. Run
`npm run test:aletheia:sqlcipher` to verify a real cipher version, wrong/no-key
rejection, plaintext-to-encrypted export, integrity checks, idempotence, and
owner-only migration backup handling.
