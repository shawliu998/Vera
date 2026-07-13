# Compliance Docker deployment

`docker-compose.yml` is an admission-controlled deployment for sensitive local
work. It does not silently downgrade to a writable named Docker volume or a
plaintext database. Its default `ALETHEIA_DEPLOYMENT_PRESET=compliance` requires
all of the following before the backend listens:

- AES-256-GCM application encryption with an independent 32-byte key;
- `sqlcipher_required` with a different independent 32-byte database key;
- `ALETHEIA_REQUIRE_ENCRYPTED_VOLUME=true` and a human-set encrypted-volume
  attestation;
- enabled high-assurance independent Ed25519 audit anchoring; and
- `ALETHEIA_MALWARE_SCAN_MODE=required` with a local ClamAV executable.

The attestation is intentionally `false` in `.env.example`. It is a stop sign,
not a value the product can discover from a container. Set it to `true` only
after the operator has verified the host data directory is protected by
FileVault, BitLocker, LUKS, or an equivalent encrypted volume.

## Provision host custody directories

Create four directories outside the repository. Their parent storage and
backups must satisfy your retention and access-control policy:

```text
/secure/aletheia/data           encrypted data vault (read/write by Docker)
/secure/aletheia/audit-anchors  independently retained journal (read/write)
/secure/aletheia/secrets        owner-only key files (read-only to Docker)
/secure/aletheia/clamav-db      reviewed ClamAV definitions (read-only to Docker)
```

Set the corresponding `ALETHEIA_HOST_*` values in `.env`. Compose rejects a
missing path variable, avoiding an accidental fallback to an unencrypted named
volume. The journal must be separately administered from the data vault. A
separate directory alone is not WORM: retain signed heads/bundles with another
custodian or use actual append-only storage as described in
[audit anchoring](audit_anchoring.md).

Place these regular non-symlink, owner-only files in the secret directory:

```text
aletheia-master-key    32 random bytes, base64, or 64 hex characters (0600)
aletheia-database-key  different 32 random bytes, base64, or 64 hex characters (0600)
anchor-private.pem     Ed25519 PKCS#8 private key (0600)
anchor-public.pem      matching Ed25519 SPKI public key (0644)
```

Generate the encryption keys on a controlled workstation, never in shell
history or source control:

```bash
umask 077
openssl rand -base64 32 > /secure/aletheia/secrets/aletheia-master-key
openssl rand -base64 32 > /secure/aletheia/secrets/aletheia-database-key
chmod 600 /secure/aletheia/secrets/aletheia-*-key
```

Use the anchor-key command from [audit anchoring](audit_anchoring.md) with the
mounted container paths or generate it before starting the container. Retain
the resulting public-key identifier and the first signed journal head outside
the vault. On later starts set `ALETHEIA_AUDIT_ANCHOR_EXPECTED_HEAD_HASH` to the
independently retained prior head.

## ClamAV definitions

The backend image includes `/usr/bin/clamscan`, but deliberately does not fetch
definitions at runtime: this keeps the running agent local and makes definition
updates an explicit reviewed operation. Populate `ALETHEIA_HOST_CLAMAV_DB_DIR`
with a current, signed ClamAV database using your approved offline mirror or
update workflow, mount it read-only, and test it before production. If the
scanner, database, or scan execution fails, required mode rejects the upload;
it never reports the file as clean.

After updating definitions, rebuild/restart the backend and run a harmless
validation file through the same scanner path under your malware-testing policy.
Do not use an EICAR test file in a production client vault unless your security
process explicitly permits it.

## Start and verify

After verifying the encrypted host volume, change only this value in `.env`:

```bash
ALETHEIA_ENCRYPTED_VOLUME_ATTESTED=true
```

Then validate expansion before starting:

```bash
docker compose config
docker compose up --build
curl --fail http://127.0.0.1:3001/health
```

An unavailable key, bad SQLCipher key, missing anchor, unhealthy audit journal,
missing scanner, or false volume attestation is a startup failure. After
startup, high-assurance anchor failure returns health `503` and blocks all
state-changing Aletheia requests. Run the backend checks before an operational
handoff:

```bash
cd backend
npm run check:aletheia:doctor
npm run check:aletheia:backup
npm run check:aletheia:restore
```

Existing plaintext databases must be migrated while every backend/desktop
process is stopped; follow [SQLCipher integration](sqlcipher_integration.md).
Existing plaintext documents likewise need the controlled migration in
[application encryption](application_encryption.md). Do not set a legacy-read
override as a routine production fallback.
