import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { LocalDatabase } from "./localDatabase";

export type PrincipalTokenMetadata = {
  id: string;
  principalId: string;
  label: string | null;
  email: string | null;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdBy: string;
  createdAt: string;
};

export type IssuedPrincipalToken = PrincipalTokenMetadata & {
  /** Returned exactly once. It is never persisted and cannot be recovered. */
  token: string;
};

export type AuthenticatedPrincipal = {
  principalId: string;
  email: string | null;
  tokenId: string;
};

export type LocalIdentityOptions = {
  databasePath?: string;
  database?: LocalDatabase;
  now?: () => Date;
};

type TokenRow = {
  id: string;
  principal_id: string;
  token_hash: string;
  label: string | null;
  email: string | null;
  expires_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  last_used_at: string | null;
  created_by: string;
  created_at: string;
};

function localDataDir() {
  return path.resolve(
    process.env.ALETHEIA_DATA_DIR ??
      process.env.ALET_HEIA_DATA_DIR ??
      path.resolve(process.cwd(), ".data", "aletheia"),
  );
}

function defaultDatabasePath() {
  const root = localDataDir();
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return path.join(root, "aletheia.db");
}

function tokenHash(token: string) {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

function tokenMetadata(row: TokenRow): PrincipalTokenMetadata {
  return {
    id: row.id,
    principalId: row.principal_id,
    label: row.label,
    email: row.email,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export class LocalIdentityRepository {
  private readonly db: LocalDatabase;
  private readonly ownsDatabase: boolean;
  private readonly clock: () => Date;

  constructor(options: LocalIdentityOptions = {}) {
    this.clock = options.now ?? (() => new Date());
    if (options.database) {
      this.db = options.database;
      this.ownsDatabase = false;
    } else {
      const databasePath = options.databasePath ?? defaultDatabasePath();
      this.db = new LocalDatabase(databasePath);
      this.db.exec("pragma journal_mode = WAL");
      this.db.exec("pragma busy_timeout = 5000");
      if (existsSync(databasePath)) chmodSync(databasePath, 0o600);
      this.ownsDatabase = true;
    }
    this.ensureSchema();
  }

  close() {
    if (this.ownsDatabase) this.db.close();
  }

  private ensureSchema() {
    this.db.exec(`
      create table if not exists aletheia_principal_tokens (
        id text primary key,
        principal_id text not null,
        token_hash text not null unique,
        label text,
        email text,
        expires_at text not null,
        revoked_at text,
        revoked_by text,
        last_used_at text,
        created_by text not null,
        created_at text not null
      );
      create index if not exists idx_principal_tokens_principal
        on aletheia_principal_tokens(principal_id, created_at desc);
      create index if not exists idx_principal_tokens_active_hash
        on aletheia_principal_tokens(token_hash, revoked_at, expires_at);
    `);
  }

  issueToken(input: {
    principalId: string;
    createdBy: string;
    label?: string | null;
    email?: string | null;
    expiresAt?: string;
    expiresInSeconds?: number;
  }): IssuedPrincipalToken {
    const issuedAt = this.clock();
    const defaultSeconds = Number.parseInt(
      process.env.ALETHEIA_PRINCIPAL_TOKEN_TTL_SECONDS ?? "28800",
      10,
    );
    const ttl =
      input.expiresInSeconds === undefined
        ? Number.isSafeInteger(defaultSeconds) && defaultSeconds > 0
          ? defaultSeconds
          : 28_800
        : input.expiresInSeconds;
    if (
      !Number.isSafeInteger(ttl) ||
      Number(ttl) < 60 ||
      Number(ttl) > 31_536_000
    ) {
      throw new Error(
        "Principal token lifetime must be between 60 seconds and 365 days",
      );
    }
    const expiresAt = input.expiresAt
      ? new Date(input.expiresAt)
      : new Date(issuedAt.getTime() + Number(ttl) * 1_000);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= issuedAt) {
      throw new Error("Principal token expiry must be a future ISO timestamp");
    }
    const token = `alp_${randomBytes(32).toString("base64url")}`;
    const id = randomUUID();
    this.db
      .prepare(
        `insert into aletheia_principal_tokens
         (id, principal_id, token_hash, label, email, expires_at, revoked_at,
          revoked_by, last_used_at, created_by, created_at)
         values (?, ?, ?, ?, ?, ?, null, null, null, ?, ?)`,
      )
      .run(
        id,
        input.principalId,
        tokenHash(token),
        input.label?.trim().slice(0, 200) || null,
        input.email?.trim().toLowerCase().slice(0, 320) || null,
        expiresAt.toISOString(),
        input.createdBy,
        issuedAt.toISOString(),
      );
    const row = this.row(id);
    if (!row) throw new Error("Principal token persistence failed");
    return { ...tokenMetadata(row), token };
  }

  authenticate(token: string): AuthenticatedPrincipal | null {
    if (!token.startsWith("alp_") || token.length < 40 || token.length > 128) {
      return null;
    }
    const timestamp = this.clock().toISOString();
    this.db.exec("begin immediate");
    try {
      const row = this.db
        .prepare(
          `select * from aletheia_principal_tokens
           where token_hash = ? and revoked_at is null and expires_at > ?`,
        )
        .get(tokenHash(token), timestamp) as TokenRow | undefined;
      if (!row) {
        this.db.exec("commit");
        return null;
      }
      if (this.principalTableExists()) {
        const principal = this.db
          .prepare(
            "select status from aletheia_principals where id = ? and status = 'active'",
          )
          .get(row.principal_id);
        if (!principal) {
          this.db.exec("commit");
          return null;
        }
      }
      const updated = this.db
        .prepare(
          `update aletheia_principal_tokens set last_used_at = ?
           where id = ? and revoked_at is null and expires_at > ?`,
        )
        .run(timestamp, row.id, timestamp);
      if (Number(updated.changes) !== 1) {
        this.db.exec("commit");
        return null;
      }
      this.db.exec("commit");
      return {
        principalId: row.principal_id,
        email: row.email,
        tokenId: row.id,
      };
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  listTokens(principalId: string) {
    return (
      this.db
        .prepare(
          `select * from aletheia_principal_tokens
           where principal_id = ? order by created_at desc`,
        )
        .all(principalId) as TokenRow[]
    ).map(tokenMetadata);
  }

  revokeToken(input: {
    tokenId: string;
    principalId: string;
    revokedBy: string;
  }) {
    const timestamp = this.clock().toISOString();
    const result = this.db
      .prepare(
        `update aletheia_principal_tokens
         set revoked_at = ?, revoked_by = ?
         where id = ? and principal_id = ? and revoked_at is null`,
      )
      .run(timestamp, input.revokedBy, input.tokenId, input.principalId);
    if (Number(result.changes) !== 1) return null;
    const row = this.row(input.tokenId);
    return row ? tokenMetadata(row) : null;
  }

  private row(tokenId: string) {
    return this.db
      .prepare("select * from aletheia_principal_tokens where id = ?")
      .get(tokenId) as TokenRow | undefined;
  }

  private principalTableExists() {
    return Boolean(
      this.db
        .prepare(
          "select 1 from sqlite_master where type = 'table' and name = 'aletheia_principals'",
        )
        .get(),
    );
  }
}
