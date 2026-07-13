# P6 Restore-Interruption Recovery

## Scope

P6 hardens the existing encrypted workspace restore. It does not add a new
product surface. The acceptance risk is process or power loss after the active
data directory has moved but before Vera confirms that restored services are
healthy.

## Transaction Contract

1. The restore utility authenticates and validates the backup in an owner-only
   same-filesystem staging directory.
2. Before the first directory rename, it atomically writes and fsyncs an
   owner-only pending record containing only the exact active and rollback
   directory paths.
3. The prior workspace is retained until the restored backend and frontend are
   healthy and the HMAC-chained restore journal entry is durable.
4. Vera clears the pending record only after that commit, or after the prior
   workspace has been reinstated.
5. Every application launch reconciles a pending record before starting local
   services. Paths outside the expected parent, symlinks, permissive record
   modes, malformed records, and missing ambiguous state fail closed.

## Verification

- `cd backend && npm run build`
- `cd backend && npm run test:desktop-backup`
- `./scripts/package-desktop-mac.sh`
- `cd desktop && npm run test:packaged-backup`
- `cd desktop && npm run test:packaged-restore-fail-closed`

`test:desktop-backup` is part of the macOS CI backend gate. The packaging
script runs legacy migration, isolated packaged startup, and packaged backup
interruption recovery after creating `Vera.app`; a failure stops the script
before checksums or release verification are produced.

The packaged fail-closed audit also proves that an out-of-bound rollback path,
a group/world-readable pending record, and a transaction with both workspaces
missing keep backend and frontend services offline and preserve the record for
operator recovery.

Packaging runs startup and backup audits on dedicated loopback ports 44960 and
44961. A normally running Vera client on 43760 and 43761 therefore does not have
to be stopped and cannot be mistaken for the isolated audit application.

The macOS CI workflow now runs the complete unsigned local package script in a
separate parallel job. It builds `Vera.app`, executes the migration and recovery
gates, and does not upload the unsigned result as a distributable release. The
script removes legacy `Aletheia-*` files before packaging and fails if any
remain when the current Vera checksums are complete.

The packaged audit creates a real SQLCipher matter and encrypted document,
backs them up, adds a second matter, and exits Vera immediately after the
restore directory swap. Relaunch must recover the second matter before service
startup. A subsequent normal restore must preserve the backed-up matter,
document, and searchable chunks while removing the second matter. Tampered
ciphertext remains rejected.

## Remaining Boundary

The generated app is unsigned and unnotarized because no Developer ID
credentials are available. P6 does not replace external backup rotation,
separate key escrow, FileVault, or a real hardware power-loss test.
