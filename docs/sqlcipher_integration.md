# SQLCipher integration

Backend-only deployments keep `ALETHEIA_DATABASE_ENCRYPTION=metadata_plaintext`
as the compatibility default. That default uses `node:sqlite` and is not
encrypted. The packaged macOS desktop app defaults to
`ALETHEIA_DATABASE_ENCRYPTION=sqlcipher_required` and provisions its database
key in the login Keychain. After an explicit offline migration, backend-only
operators may also set required mode to use `@signalapp/sqlcipher` 3.3.9.
Required mode has no plaintext fallback.

The adapter follows the SQLCipher requirement that the key be applied before
the first database operation. It then requires all of the following:

- a non-empty `PRAGMA cipher_version`;
- a successful keyed read from `sqlite_master`;
- an empty `PRAGMA cipher_integrity_check` result for an existing database;
- a dedicated 32-byte key that is not the file-envelope or audit-HMAC key.

The upstream API and migration behavior are documented in the
[official SQLCipher API](https://www.zetetic.net/sqlcipher/sqlcipher-api/).
The binding source and releases are maintained in
[`signalapp/node-sqlcipher`](https://github.com/signalapp/node-sqlcipher).

## Key custody

Backend-only deployments select exactly one independent source:

```bash
export ALETHEIA_DATABASE_KEY_SOURCE=file
export ALETHEIA_DATABASE_KEY_FILE=/secure/operator/aletheia-database-key
```

The key file accepts 32 raw random bytes, base64, or 64 hexadecimal characters,
must be a regular non-symlink file with mode `0600` on POSIX, and must be outside
`ALETHEIA_DATA_DIR`. Environment input is also supported with
`ALETHEIA_DATABASE_KEY_SOURCE=env` and
`ALETHEIA_DATABASE_KEY_BASE64`, but shell/process environments are usually a
weaker custody boundary.

The macOS desktop provisions a separate login-Keychain item when required mode
is selected. Keychain use does not need an Apple Developer account. Before
moving the vault to another Mac, escrow the database key separately from the
database backup:

```bash
ALETHEIA_DATABASE_ENCRYPTION=sqlcipher_required \
ALETHEIA_DATABASE_KEY_SOURCE=macos_keychain \
ALETHEIA_DATABASE_KEY_ESCROW_OUTPUT=/Volumes/EncryptedEscrow/aletheia-database-key \
ALETHEIA_DATABASE_KEY_ESCROW_CONFIRM=export-database-key \
npm run escrow:aletheia:database-key
```

Restore that exact key on the destination Mac before opening the migrated
database:

```bash
ALETHEIA_DATABASE_KEY_SOURCE=file \
ALETHEIA_DATABASE_KEY_FILE=/Volumes/EncryptedEscrow/aletheia-database-key \
ALETHEIA_DATABASE_KEYCHAIN_IMPORT_CONFIRM=replace-database-key \
npm run import:aletheia:database-keychain-key
```

## Offline plaintext migration

Stop every Aletheia backend and desktop process. Choose a separately protected,
owner-only backup directory outside the data directory. Run a non-mutating dry
run first:

```bash
cd backend
ALETHEIA_DATA_DIR=/path/to/aletheia-data \
ALETHEIA_DATABASE_KEY_SOURCE=file \
ALETHEIA_DATABASE_KEY_FILE=/secure/operator/aletheia-database-key \
npm run migrate:aletheia:sqlcipher
```

Then apply only after reviewing the target, key identifier, plaintext hash, and
backup destination:

```bash
ALETHEIA_DATA_DIR=/path/to/aletheia-data \
ALETHEIA_DATABASE_KEY_SOURCE=file \
ALETHEIA_DATABASE_KEY_FILE=/secure/operator/aletheia-database-key \
ALETHEIA_SQLCIPHER_MIGRATION_BACKUP_DIR=/Volumes/EncryptedEscrow/migration-backup \
ALETHEIA_SQLCIPHER_MIGRATION_APPLY=true \
npm run migrate:aletheia:sqlcipher
```

The migration acquires an exclusive cooperative lock, checkpoints the plaintext
WAL, records a table/row manifest, uses `sqlcipher_export()` into an encrypted
temporary database, preserves `user_version` and `application_id`, verifies the
cipher and manifest, creates and hashes an owner-only plaintext rollback backup,
then atomically replaces the database on macOS/Linux. It is idempotent. Direct
in-place replacement is deliberately refused on Windows until its atomic
replacement semantics are verified; the source remains unchanged.

After migration, set `ALETHEIA_DATABASE_ENCRYPTION=sqlcipher_required` (the
packaged desktop app already does this) and run:

```bash
npm run test:aletheia:sqlcipher
npm run check:aletheia:audit-integrity
npm run check:aletheia:backup
npm run check:aletheia:restore
```

Do not delete the plaintext rollback backup until a keyed restore drill succeeds
and the retention owner approves disposal. Protect that backup as plaintext
client data.

## Verified runtime boundary

The maintained integration test verifies that an unkeyed or wrong-key reader
cannot open the migrated database, the correct key reads schema and records,
`cipher_integrity_check` passes, and repeated migration is safe. On the current
macOS arm64 build, the binding reports SQLCipher 4.10.0 with the
`signal-sqlcipher-extension` provider. The installed darwin-arm64 N-API binary
has SHA-256
`2de28dd4791527c44af72c75eddb5ae1ea891bc0d72a1a3f50e8ad4ad799a9c1`,
matching the upstream 3.3.9 release asset. It loads under Node 22 ABI 127 and
Electron 39 ABI 140 because the binding uses N-API.

Re-run the integration and desktop launch tests for every dependency, Node,
Electron, architecture, or packaging change. Linux and Windows packaged builds
must not inherit the macOS verification claim without their own release test.

## Remaining plaintext boundary

SQLCipher covers `aletheia.db`, including SQLite FTS records. It does not cover
source files, exports, temporary files, logs, or the optional semantic JSON
index. Source files/exports use the separate AES-256-GCM envelope. The semantic
index is disabled by default; if enabled, it still needs an application-level
encryption design or an encrypted volume and encrypted backup. SQLCipher also
does not protect data after the correct key is loaded into a compromised logged-
in process.
