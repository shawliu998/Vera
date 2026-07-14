export interface WorkspaceStatement {
  run(...parameters: unknown[]): unknown;
  get(...parameters: unknown[]): Record<string, unknown> | undefined;
  all(...parameters: unknown[]): Array<Record<string, unknown>>;
}

export interface WorkspaceDatabaseAdapter {
  exec(sql: string): void;
  prepare(sql: string): WorkspaceStatement;
}

export type WorkspaceDatabaseCapabilities = {
  jsonTextChecks: boolean;
  fts5: boolean;
};

export type WorkspaceMigration = {
  version: number;
  name: string;
  checksumMaterial: string;
  apply(
    database: WorkspaceDatabaseAdapter,
    capabilities: WorkspaceDatabaseCapabilities,
  ): void;
};

export type AppliedWorkspaceMigration = {
  version: number;
  name: string;
  checksum: string;
  appliedAt: string;
};

export type WorkspaceMigrationRun = {
  applied: AppliedWorkspaceMigration[];
  currentVersion: number;
  capabilities: WorkspaceDatabaseCapabilities;
  preflight: {
    foreignKeysEnabled: true;
    integrityCheck: "ok";
    foreignKeyViolations: 0;
  };
};
