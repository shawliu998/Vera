import { readFileSync } from "node:fs";
import path from "node:path";

type IsolationCheck = {
  id: string;
  ok: boolean;
  severity: "critical" | "warning";
  detail: string;
};

function repoRoot() {
  return path.resolve(process.cwd(), "..");
}

function readText(root: string, relativePath: string) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function hasAll(source: string, values: string[]) {
  return values.every((value) => source.includes(value));
}

function check(
  id: string,
  ok: boolean,
  detail: string,
  severity: "critical" | "warning" = "critical",
): IsolationCheck {
  return { id, ok, severity, detail };
}

function main() {
  const root = repoRoot();
  const localRepository = readText(
    root,
    "backend/src/lib/aletheia/localRepository.ts",
  );
  const domain = readText(root, "backend/src/lib/aletheia/domain.ts");
  const retrievalEval = readText(
    root,
    "backend/src/scripts/aletheiaRetrievalEval.ts",
  );
  const localRegression = readText(
    root,
    "backend/src/scripts/aletheiaLocalRegression.ts",
  );
  const docs = [
    "docs/local_first_runtime.md",
    "docs/local_deployment.md",
    "docs/hybrid_retrieval.md",
    "docs/aletheia_tool_adapter.md",
    "docs/release_notes_local_first_mvp.md",
    "docs/desktop_packaging_checklist.md",
  ]
    .map((file) => readText(root, file))
    .join("\n");

  const checks: IsolationCheck[] = [
    check(
      "local-owned-matter-gate",
      localRepository.includes(
        "select * from aletheia_matters where id = ? and user_id = ?",
      ) &&
        localRepository.includes(
          "const matter = this.loadOwnedMatter(ctx, matterId)",
        ) &&
        localRepository.includes("if (!matter) return null"),
      "Local repository methods must gate matter-scoped operations through loadOwnedMatter.",
    ),
    check(
      "local-keyword-retrieval-matter-filter",
      localRepository.includes("from aletheia_document_chunks_fts f") &&
        localRepository.includes("and f.matter_id = ?") &&
        localRepository.includes(".all(ftsQuery, matterId, limit)"),
      "SQLite FTS5 retrieval must filter by matter_id before ranking results.",
    ),
    check(
      "local-semantic-index-per-matter",
      localRepository.includes(
        "function localSemanticIndexPath(matterId: string)",
      ) &&
        localRepository.includes(
          "`${safeFilePart(matterId) || matterId}.json`",
        ) &&
        localRepository.includes("where c.matter_id = ?") &&
        localRepository.includes(".all(matterId)"),
      "Optional local semantic indexes must be stored and rebuilt per matter.",
    ),
    check(
      "local-memory-playbook-matter-boundary",
      hasAll(localRepository, [
        "aletheia_matter_memory_items",
        "aletheia_playbooks",
        "where id = ? and matter_id = ? and user_id = ?",
        "where matter_id = ? and user_id = ? and status = 'approved'",
      ]),
      "Matter Memory and Playbook reads/writes must remain matter- and user-scoped.",
    ),
    check(
      "runtime-cross-matter-memory-disabled",
      domain.includes('crossMatterMemory: "disabled"') &&
        domain.includes('defaultToolPolicy: "allowlist_per_step"'),
      "Runtime metadata must advertise disabled cross-matter memory and allowlist tool policy.",
    ),
    check(
      "retrieval-eval-cross-matter-case",
      retrievalEval.includes("isolation-alpha-cannot-see-beta") &&
        retrievalEval.includes("expectedFound: false") &&
        retrievalEval.includes("cross-matter") &&
        retrievalEval.includes("failClosedPassed"),
      "Retrieval eval must include a negative cross-matter search case and fail-closed semantic policy.",
    ),
    check(
      "local-regression-matter-scoped-memory-playbooks",
      localRegression.includes("Matter memory should persist") &&
        localRegression.includes(
          "Playbook proposal must not mutate the approved source playbook",
        ) &&
        localRegression.includes(
          "Matter-scoped registry snapshots should persist",
        ),
      "Local regression must cover matter memory, playbook proposal isolation, and matter-scoped snapshots.",
    ),
    check(
      "docs-isolation-posture",
      hasAll(docs, [
        "matter-scoped",
        "cross-matter",
        "Never inject cross-matter memory or vectors",
        "Matter Memory remains matter-scoped",
        "matter memory stays matter-scoped",
      ]),
      "Docs must clearly state matter-scoped memory, retrieval, and Tool Adapter isolation posture.",
    ),
  ];

  const failedCritical = checks.filter(
    (entry) => !entry.ok && entry.severity === "critical",
  );
  const warnings = checks.filter(
    (entry) => !entry.ok && entry.severity === "warning",
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: failedCritical.length === 0,
        suite: "aletheia-matter-isolation-audit-v0",
        checkedAt: new Date().toISOString(),
        isolationBoundaries: [
          "matter_id",
          "user_id",
          "per-matter semantic index",
          "matter-scoped memory",
          "draft playbook proposals",
          "cross-matter retrieval negative eval",
        ],
        warnings: warnings.length,
        checks,
      },
      null,
      2,
    )}\n`,
  );

  if (failedCritical.length > 0) {
    process.exitCode = 1;
  }
}

main();
