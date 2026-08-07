#!/usr/bin/env node

const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const LOCK_PATH = path.join(__dirname, "mike-workflows.lock.json");
const BACKEND_OUT = path.join(
  REPOSITORY_ROOT,
  "backend/src/lib/systemWorkflows.ts",
);
const COLLECTIONS = [
  { key: "assistant", directory: "assistant-workflows" },
  { key: "tabular", directory: "tabular-review-workflows" },
];
const SKILL_MANIFEST_SCHEMA_VERSION = "skill_manifest_v1";
const CONTRACT_PLAYBOOK_REVIEW_WORKFLOW_ID =
  "builtin-contract-playbook-review";
const LITIGATION_HEARING_PREPARATION_WORKFLOW_ID =
  "builtin-litigation-hearing-preparation";
const LITIGATION_CASE_MAP_WORKFLOW_ID = "builtin-litigation-case-map";
const LITIGATION_JUDGMENT_APPEAL_ASSESSMENT_WORKFLOW_ID =
  "builtin-litigation-judgment-appeal-assessment";
const MATTER_TIMELINE_WORKFLOW_ID = "builtin-matter-timeline";
const PATENT_CLAIM_COMPARISON_WORKFLOW_ID = "builtin-patent-claim-comparison";
const PATENT_FTO_SCREENING_WORKFLOW_ID = "builtin-patent-fto-screening";
const PATENT_INFRINGEMENT_ANALYSIS_WORKFLOW_ID =
  "builtin-patent-infringement-analysis";
const PATENT_INVALIDITY_SEARCH_WORKFLOW_ID =
  "builtin-patent-invalidity-search";
const PATENTABILITY_ASSESSMENT_WORKFLOW_ID =
  "builtin-patentability-assessment";
const USPTO_OFFICE_ACTION_RESPONSE_WORKFLOW_ID = "builtin-uspto-office-action-response";
const KERNEL_CAPABILITIES = [
  "analyze",
  "create_draft",
  "create_tabular",
  "read_sources",
  "verify",
];
const GOAL_PROFILES = [
  "compare",
  "contract_review",
  "draft",
  "extract",
  "generic",
  "proofread",
  "research",
];
const GOAL_COMPLETION_CHECKS = [
  "citations_relocatable",
  "deliverables_present",
  "goal_covered",
  "source_supported",
  "steps_complete",
];
const AUTHORITY_GRANT_KEYS = new Set([
  "allowed_capabilities",
  "allowed_tools",
  "credentials",
  "filesystem",
  "granted_capabilities",
  "network",
  "permissions",
  "secrets",
  "shell",
  "tool_allowlist",
  "tools",
]);
const FORBIDDEN_SKILL_INSTRUCTIONS = [
  {
    kind: "executable code fence",
    pattern:
      /```[ \t]*(?:ba?sh|zsh|powershell|cmd|bat|python|javascript|typescript|node)\b/i,
  },
  {
    kind: "inline command",
    pattern:
      /`[ \t]*(?:(?:sudo|env)\s+)?(?:(?:bash|zsh|sh|python\d*|node)\s+(?:[-./~]|[A-Za-z]:\\)|(?:npm|pnpm|yarn|pipx?)\s+(?:install|add|exec|run)\b|(?:curl|wget)\s+(?:-[A-Za-z]+\s+)*https?:\/\/|chmod\s+\+x\b)[^`\r\n]*`/i,
  },
  {
    kind: "shell command",
    pattern:
      /(?:^|\n)\s*(?:[-*]\s*)?(?:(?:\$|PS>)\s*)?(?:(?:sudo|env)\s+)?(?:(?:bash|zsh|sh|python\d*|node)\s+(?:[-./~]|[A-Za-z]:\\)|(?:npm|pnpm|yarn|pipx?)\s+(?:install|add|exec|run)\b|(?:curl|wget)\s+(?:-[A-Za-z]+\s+)*https?:\/\/)/i,
  },
  {
    kind: "curl pipe shell",
    pattern:
      /\b(?:curl|wget)\b[^\n|]{0,500}\|\s*(?:ba)?sh\b/i,
  },
  {
    kind: "chmod execution",
    pattern:
      /\bchmod\s+\+x\b[^\n]*(?:&&|;)\s*(?:\.{0,2}\/|~\/|\/)/i,
  },
  {
    kind: "download chmod invoke",
    pattern:
      /(?:^|\n)\s*(?:[-*]\s*)?download\s+https?:\/\/\S+\.(?:sh|py|js|mjs|cjs)\b[^\n]{0,240}\bchmod\s+\+x\b[^\n]{0,240}\b(?:then\s+)?(?:invoke|run|execute)\s+(?:\.{0,2}\/|~\/|\/)\S+/i,
  },
  {
    kind: "path script execution",
    pattern:
      /(?:^|\n)\s*(?:[-*]\s*)?(?:run|execute)\s+(?:(?:with|using)\s+)?(?:(?:bash|zsh|sh|python\d*|node)\s+)?(?:\.{0,2}\/|~\/|\/)[^\s]+\.(?:sh|py|js|mjs|cjs)\b/i,
  },
  {
    kind: "interpreter script execution",
    pattern:
      /(?:^|\n)\s*(?:[-*]\s*)?(?:(?:use|open)\s+(?:the\s+)?terminal\s+to\s+)?(?:invoke|run|execute)\s+(?:bash|zsh|sh|python\d*|node)\s+(?:(?:\.{0,2}\/|~\/|\/)?[^\s]+\.(?:sh|py|js|mjs|cjs))\b/i,
  },
  {
    kind: "installer execution",
    pattern:
      /(?:^|\n)\s*(?:[-*]\s*)?(?:run|download|launch|execute)\s+(?:the\s+|an?\s+)?(?:installer|install(?:ation)?\s+script)\b/i,
  },
  {
    kind: "web login instruction",
    pattern:
      /(?:^|\n)\s*(?:[-*]\s*)?(?:(?:before|after)[^,\n]{0,48},\s*)?(?:log[ -]?in|sign[ -]?in|authenticate)\b.{0,100}\b(?:website|web|browser|portal|account)\b/i,
  },
  {
    kind: "credential configuration",
    pattern:
      /(?:^|\n)\s*(?:[-*]\s*)?(?:enter|provide|store|configure|set|export|paste|supply|load|use)\s+(?:your\s+)?(?:api[ _-]?key|password|credential|secret(?:\s+key)?|access token|refresh token|cookie)\b/i,
  },
  {
    kind: "arbitrary execution instruction",
    pattern:
      /(?:^|\n)\s*(?:[-*]\s*)?(?:execute|run|eval(?:uate)?)\s+(?:any|arbitrary|untrusted|user[- ]supplied)\s+(?:code|command|script)\b|\b(?:child_process|subprocess)\b|\beval\s*\(/i,
  },
  {
    kind: "authority grant",
    pattern:
      /(?:^|\n)\s*(?:[-*]\s*)?(?:(?:you\s+(?:may|can|are allowed to)\s+)?(?:call|invoke|use)|grant(?:ed)?\s+permission\s+to\s+(?:call|invoke|use))\s+(?:any|all)\s+(?:available\s+)?(?:tools?|capabilit(?:y|ies)|connectors?)\b/i,
  },
];
const DEFAULT_MUST_ASK_WHEN = [
  "missing_source",
  "missing_fact",
  "evidence_conflict",
  "legal_judgment",
  "source_version_changed",
  "material_scope_change",
  "consequential_action",
];

function fail(message) {
  throw new Error(message);
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function readJson(filePath) {
  try {
    return JSON.parse(readText(filePath));
  } catch (error) {
    fail(`${filePath} is not valid JSON: ${error.message}`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a non-empty string`);
  }
}

function assertOptionalString(value, label) {
  if (value === undefined || value === null) return;
  if (typeof value !== "string") fail(`${label} must be a string`);
}

function assertOptionalStringArray(value, label) {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(`${label} must be an array of strings`);
  }
}

function assertUniqueStringArray(value, label, { allowEmpty = false } = {}) {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    fail(
      `${label} must be ${allowEmpty ? "an" : "a non-empty"} array of strings`,
    );
  }
  if (new Set(value).size !== value.length) {
    fail(`${label} must not contain duplicates`);
  }
}

function assertRepositoryFixturePath(value, label, repositoryRoot = REPOSITORY_ROOT) {
  if (
    value !== value.trim() ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value === "." ||
    value === ".." ||
    value.startsWith("../") ||
    value.endsWith("/")
  ) {
    fail(`${label} must be a normalized repository-relative path`);
  }

  const fixturePath = path.resolve(repositoryRoot, value);
  const relativePath = path.relative(repositoryRoot, fixturePath);
  const portableRelativePath = relativePath.split(path.sep).join("/");
  if (
    portableRelativePath !== value ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    fail(`${label} must stay inside the repository`);
  }
  if (!fs.existsSync(fixturePath)) {
    fail(`${label} does not exist: ${value}`);
  }
  const stat = fs.lstatSync(fixturePath);
  if (!stat.isFile() && !stat.isDirectory()) {
    fail(`${label} must identify a regular file or directory`);
  }
  return fixturePath;
}

function fixtureSha256(value, label, repositoryRoot = REPOSITORY_ROOT) {
  const fixturePath = assertRepositoryFixturePath(value, label, repositoryRoot);
  const stat = fs.lstatSync(fixturePath);
  if (stat.isFile()) return sha256(fs.readFileSync(fixturePath));

  const entries = [];
  const visit = (directoryPath) => {
    for (const name of fs.readdirSync(directoryPath)) {
      const entryPath = path.join(directoryPath, name);
      const entryStat = fs.lstatSync(entryPath);
      if (entryStat.isSymbolicLink()) {
        fail(`${label} must not contain symbolic links`);
      }
      if (entryStat.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!entryStat.isFile()) {
        fail(`${label} must contain only regular files`);
      }
      const relativePath = path
        .relative(fixturePath, entryPath)
        .split(path.sep)
        .join("/");
      entries.push({
        relativePath,
        digest: sha256(fs.readFileSync(entryPath)),
      });
    }
  };
  visit(fixturePath);
  return sha256(
    entries
      .sort((left, right) =>
        left.relativePath < right.relativePath ? -1 :
        left.relativePath > right.relativePath ? 1 : 0,
      )
      .map(({ relativePath, digest }) => `${relativePath}\0${digest}`)
      .join("\n"),
  );
}

function assertExactObjectKeys(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actualKeys = Object.keys(value).sort((a, b) => a.localeCompare(b));
  const expected = [...expectedKeys].sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(actualKeys) !== JSON.stringify(expected)) {
    fail(`${label} must contain exactly: ${expected.join(", ")}`);
  }
}

function assertNoAuthorityGrant(frontmatter, label) {
  const inspect = (value, pathLabel) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replaceAll("-", "_");
      if (AUTHORITY_GRANT_KEYS.has(normalizedKey)) {
        fail(
          `${pathLabel}.${key} is not allowed: a Skill may declare requirements but cannot grant permissions or tools`,
        );
      }
      inspect(child, `${pathLabel}.${key}`);
    }
  };
  inspect(frontmatter, label);
}

function assertSafeSkillInstructions(value, label) {
  // Deliberately narrow syntax gate: fixed provenance, explicit selection,
  // semantic digests, and human review remain the primary admission controls.
  // Do not turn legal prose into a broad semantic "security" classifier.
  for (const rule of FORBIDDEN_SKILL_INSTRUCTIONS) {
    if (rule.pattern.test(value)) {
      fail(`${label} contains forbidden ${rule.kind} instructions`);
    }
  }
}

function parseScalar(value, label) {
  const trimmed = value.trim();
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      fail(`${label} is not valid inline JSON: ${error.message}`);
    }
  }
  return trimmed;
}

function parseSimpleYaml(source, label) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const result = {};

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (line.startsWith(" ")) {
      fail(`${label}:${i + 1} has unsupported indentation`);
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/);
    if (!match) fail(`${label}:${i + 1} is not valid frontmatter`);
    const key = match[1];
    const rawValue = match[2].trim();

    if (rawValue) {
      result[key] = parseScalar(rawValue, `${label}.${key}`);
      continue;
    }

    const scalarItems = [];
    const objectItems = [];
    const properties = {};
    let mode = null;
    i += 1;
    for (; i < lines.length; i += 1) {
      const child = lines[i];
      if (!child.trim()) continue;
      if (!child.startsWith("  ")) {
        i -= 1;
        break;
      }

      const listMatch = child.match(/^  -(?:\s+(.*))?$/);
      if (listMatch) {
        const itemText = listMatch[1]?.trim() ?? "";
        if (itemText.includes(":")) {
          mode ??= "objects";
          if (mode !== "objects") {
            fail(`${label}.${key} mixes scalar and object list items`);
          }
          const object = {};
          if (itemText) {
            const itemMatch = itemText.match(
              /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/,
            );
            if (!itemMatch) {
              fail(`${label}:${i + 1} is not a valid object list item`);
            }
            object[itemMatch[1]] = parseScalar(
              itemMatch[2],
              `${label}.${key}.${itemMatch[1]}`,
            );
          }
          objectItems.push(object);
          continue;
        }

        mode ??= "scalars";
        if (mode !== "scalars") {
          fail(`${label}.${key} mixes object and scalar list items`);
        }
        scalarItems.push(parseScalar(itemText, `${label}.${key}`));
        continue;
      }

      const childPropMatch = child.match(/^  ([A-Za-z_][A-Za-z0-9_-]*):(.*)$/);
      if (childPropMatch) {
        mode ??= "properties";
        if (mode !== "properties") {
          fail(`${label}.${key} mixes mapping and list values`);
        }
        properties[childPropMatch[1]] = parseScalar(
          childPropMatch[2],
          `${label}.${key}.${childPropMatch[1]}`,
        );
        continue;
      }

      const propMatch = child.match(/^    ([A-Za-z_][A-Za-z0-9_-]*):(.*)$/);
      if (!propMatch || mode !== "objects" || objectItems.length === 0) {
        fail(`${label}:${i + 1} has unsupported frontmatter structure`);
      }
      objectItems[objectItems.length - 1][propMatch[1]] = parseScalar(
        propMatch[2],
        `${label}.${key}.${propMatch[1]}`,
      );
    }

    result[key] =
      mode === "objects"
        ? objectItems
        : mode === "properties"
          ? properties
          : scalarItems;
  }

  return result;
}

function readSkillFile(filePath, sourceRoot) {
  const relativePath = path.relative(sourceRoot, filePath);
  const text = readText(filePath).replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) {
    fail(`${relativePath} must start with YAML frontmatter`);
  }
  const close = text.indexOf("\n---", 4);
  if (close === -1) {
    fail(`${relativePath} is missing closing YAML frontmatter marker`);
  }
  const afterClose = text.slice(close + 4);
  if (afterClose && !afterClose.startsWith("\n")) {
    fail(`${relativePath} has invalid frontmatter closing marker`);
  }
  return {
    metadata: parseSimpleYaml(text.slice(4, close), relativePath),
    body: afterClose.replace(/^\n/, "").trimEnd(),
  };
}

function parseTableColumnsYaml(filePath, sourceRoot) {
  const relativePath = path.relative(sourceRoot, filePath);
  const lines = readText(filePath).replace(/\r\n/g, "\n").split("\n");
  const result = { columns_config: [] };
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      i += 1;
      continue;
    }
    const schemaMatch = line.match(/^\$schema:\s*(.+)$/);
    if (schemaMatch) {
      result.$schema = parseScalar(schemaMatch[1], `${relativePath}.$schema`);
      i += 1;
      continue;
    }
    if (line !== "columns:") {
      fail(`${relativePath}:${i + 1} is not valid table columns YAML`);
    }
    i += 1;
    break;
  }

  let current = null;
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;

    const itemMatch = line.match(/^  - index:\s*(.+)$/);
    if (itemMatch) {
      current = {
        index: parseScalar(
          itemMatch[1],
          `${relativePath}.columns_config.index`,
        ),
      };
      result.columns_config.push(current);
      continue;
    }
    if (!current) {
      fail(`${relativePath}:${i + 1} column entry must start with index`);
    }

    const propMatch = line.match(/^    ([A-Za-z_][A-Za-z0-9_-]*):(.*)$/);
    if (!propMatch) {
      fail(`${relativePath}:${i + 1} is not a valid column property`);
    }
    const key = propMatch[1];
    const rawValue = propMatch[2].trim();

    if (key === "tags" && rawValue === "") {
      const tags = [];
      i += 1;
      for (; i < lines.length; i += 1) {
        const tagMatch = lines[i].match(/^      -\s*(.+)$/);
        if (!tagMatch) {
          i -= 1;
          break;
        }
        tags.push(parseScalar(tagMatch[1], `${relativePath}.${key}`));
      }
      current.tags = tags;
      continue;
    }

    if ([">-", ">", "|-", "|"].includes(rawValue)) {
      const parts = [];
      i += 1;
      for (; i < lines.length; i += 1) {
        if (!lines[i].startsWith("      ")) {
          i -= 1;
          break;
        }
        parts.push(lines[i].slice(6));
      }
      current[key] = rawValue.startsWith("|")
        ? parts.join("\n")
        : parts.join(" ").replace(/\s+/g, " ").trim();
      continue;
    }

    current[key] = parseScalar(rawValue, `${relativePath}.${key}`);
  }

  return result;
}

function assertColumnConfig(columns, label) {
  if (!Array.isArray(columns) || columns.length === 0) {
    fail(`${label}.columns_config must be a non-empty array`);
  }
  columns.forEach((column, index) => {
    const columnLabel = `${label}.columns_config[${index}]`;
    if (!column || typeof column !== "object" || Array.isArray(column)) {
      fail(`${columnLabel} must be an object`);
    }
    if (!Number.isInteger(column.index)) {
      fail(`${columnLabel}.index must be an integer`);
    }
    if (column.index !== index) {
      fail(`${columnLabel}.index must equal ${index}`);
    }
    assertString(column.name, `${columnLabel}.name`);
    assertString(column.prompt, `${columnLabel}.prompt`);
    assertOptionalString(column.format, `${columnLabel}.format`);
    assertOptionalStringArray(column.tags, `${columnLabel}.tags`);
  });
}

function validateLock(lock) {
  if (!lock || typeof lock !== "object" || Array.isArray(lock)) {
    fail("Workflow lock must be an object");
  }
  if (lock.schemaVersion !== 2) fail("Unsupported workflow lock schema");
  assertString(lock.repository, "lock.repository");
  if (!/^[a-f0-9]{40}$/.test(lock.commit ?? "")) {
    fail("lock.commit must be a full lowercase 40-character Git commit");
  }
  if (lock.license !== "MIT") fail("lock.license must be MIT");

  for (const collection of COLLECTIONS) {
    const selected = lock.selection?.[collection.key];
    if (!Array.isArray(selected) || selected.length === 0) {
      fail(`lock.selection.${collection.key} must be a non-empty array`);
    }
    for (const slug of selected) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
        fail(
          `Unsafe workflow slug in lock.selection.${collection.key}: ${slug}`,
        );
      }
    }
    const sorted = [...selected].sort((a, b) => a.localeCompare(b));
    if (JSON.stringify(selected) !== JSON.stringify(sorted)) {
      fail(`lock.selection.${collection.key} must be sorted`);
    }
    if (new Set(selected).size !== selected.length) {
      fail(`lock.selection.${collection.key} contains duplicates`);
    }
  }

  assertExactObjectKeys(
    lock.firstParty,
    ["selection", "workflows"],
    "lock.firstParty",
  );
  assertUniqueStringArray(
    lock.firstParty.selection,
    "lock.firstParty.selection",
  );
  const sortedFirstPartySelection = [...lock.firstParty.selection].sort(
    (a, b) => a.localeCompare(b),
  );
  if (
    JSON.stringify(lock.firstParty.selection) !==
    JSON.stringify(sortedFirstPartySelection)
  ) {
    fail("lock.firstParty.selection must be sorted");
  }
  if (
    !lock.firstParty.workflows ||
    typeof lock.firstParty.workflows !== "object" ||
    Array.isArray(lock.firstParty.workflows)
  ) {
    fail("lock.firstParty.workflows must be an object");
  }
  if (
    JSON.stringify(Object.keys(lock.firstParty.workflows).sort()) !==
    JSON.stringify(sortedFirstPartySelection)
  ) {
    fail(
      "lock.firstParty.workflows must cover the explicit first-party selection exactly",
    );
  }

  const selectedMikeIds = new Set(
    COLLECTIONS.flatMap((collection) =>
      lock.selection[collection.key].map((slug) => `builtin-${slug}`),
    ),
  );
  const selectedFirstPartyIds = new Set();
  for (const slug of lock.firstParty.selection) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      fail(`Unsafe workflow slug in lock.firstParty.selection: ${slug}`);
    }
    const profile = lock.firstParty.workflows[slug];
    const label = `lock.firstParty.workflows.${slug}`;
    assertExactObjectKeys(
      profile,
      [
        "artifactContract",
        "artifactContracts",
        "completionChecks",
        "contentSha256",
        "dependencies",
        "fixtureSha256",
        "fixtures",
        "id",
        "license",
        "minimumDocuments",
        "provenance",
        "requiredCapabilities",
        "sourcePath",
        "sourceStandard",
        "taskFamily",
        "verifierProfile",
        "version",
        "workflowType",
      ],
      label,
    );
    if (!/^builtin-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile.id ?? "")) {
      fail(`${label}.id must be a stable builtin workflow id`);
    }
    if (
      selectedMikeIds.has(profile.id) ||
      selectedFirstPartyIds.has(profile.id)
    ) {
      fail(`${label}.id duplicates another selected workflow`);
    }
    selectedFirstPartyIds.add(profile.id);
    if (profile.workflowType !== "assistant") {
      fail(`${label}.workflowType must be "assistant"`);
    }
    const expectedSourcePath = `scripts/vera-workflows/${slug}/SKILL.md`;
    if (profile.sourcePath !== expectedSourcePath) {
      fail(`${label}.sourcePath must be "${expectedSourcePath}"`);
    }
    if (!/^[a-f0-9]{64}$/.test(profile.contentSha256 ?? "")) {
      fail(`${label}.contentSha256 must be a lowercase SHA-256`);
    }
    if (!/^\d+\.\d+\.\d+$/.test(profile.version ?? "")) {
      fail(`${label}.version must be a fixed semantic version`);
    }
    if (!Number.isInteger(profile.minimumDocuments) || profile.minimumDocuments < 1) {
      fail(`${label}.minimumDocuments must be a positive integer`);
    }
    const expectedMinimumDocuments =
      profile.id === PATENT_CLAIM_COMPARISON_WORKFLOW_ID ? 2 :
      profile.id === PATENT_FTO_SCREENING_WORKFLOW_ID ? 2 :
      profile.id === PATENT_INFRINGEMENT_ANALYSIS_WORKFLOW_ID ? 2 :
      profile.id === PATENT_INVALIDITY_SEARCH_WORKFLOW_ID ? 2 :
      profile.id === PATENTABILITY_ASSESSMENT_WORKFLOW_ID ? 2 :
      profile.id === USPTO_OFFICE_ACTION_RESPONSE_WORKFLOW_ID ? 3 : 1;
    if (profile.minimumDocuments !== expectedMinimumDocuments) {
      fail(`${label}.minimumDocuments must match its fixed input contract`);
    }
    if (profile.license !== "AGPL-3.0-only") {
      fail(`${label}.license must be AGPL-3.0-only`);
    }
    assertExactObjectKeys(
      profile.provenance,
      ["revision", "source"],
      `${label}.provenance`,
    );
    assertString(profile.provenance.source, `${label}.provenance.source`);
    assertString(profile.provenance.revision, `${label}.provenance.revision`);
    if (profile.provenance.revision !== `sha256:${profile.contentSha256}`) {
      fail(
        `${label}.provenance.revision must pin the first-party Skill content SHA-256`,
      );
    }
    if (
      !GOAL_PROFILES.includes(profile.taskFamily) ||
      !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(profile.taskFamily)
    ) {
      fail(`${label}.taskFamily must be an existing GoalProfile`);
    }
    assertUniqueStringArray(
      profile.requiredCapabilities,
      `${label}.requiredCapabilities`,
    );
    for (const capability of profile.requiredCapabilities) {
      if (!KERNEL_CAPABILITIES.includes(capability)) {
        fail(
          `${label}.requiredCapabilities contains non-allowlisted capability "${capability}"`,
        );
      }
    }
    assertExactObjectKeys(
      profile.artifactContract,
      ["artifactType", "format", "kind", "operation", "required"],
      `${label}.artifactContract`,
    );
    const timelineArtifactContract =
      profile.id === MATTER_TIMELINE_WORKFLOW_ID &&
      profile.artifactContract.artifactType === "tabular_review" &&
      profile.artifactContract.kind === "document" &&
      profile.artifactContract.format === "xlsx" &&
      profile.artifactContract.operation === "create" &&
      profile.artifactContract.required === true;
    const draftArtifactContract =
      profile.artifactContract.artifactType === "draft" &&
      profile.artifactContract.kind === "document" &&
      profile.artifactContract.format === "docx" &&
      profile.artifactContract.operation === "create" &&
      profile.artifactContract.required === true;
    if (!timelineArtifactContract && !draftArtifactContract) {
      fail(`${label}.artifactContract must require its fixed created artifact`);
    }
    if (!Array.isArray(profile.artifactContracts)) {
      fail(`${label}.artifactContracts must be an array`);
    }
    const expectedContracts =
      profile.id === CONTRACT_PLAYBOOK_REVIEW_WORKFLOW_ID
        ? [
            ["contract-revision", "draft", "docx"],
            ["contract-clean", "draft", "docx"],
            ["review-opinion", "draft", "docx"],
          ]
          : profile.id === LITIGATION_HEARING_PREPARATION_WORKFLOW_ID
          ? [
              ["evidence-inventory", "tabular_review", "xlsx"],
              ["evidence-objection-opinion", "draft", "docx"],
              ["hearing-outline", "draft", "docx"],
            ]
          : profile.id === LITIGATION_CASE_MAP_WORKFLOW_ID
            ? [
                ["evidence-inventory", "tabular_review", "xlsx"],
                ["first-instance-case-map", "draft", "docx"],
              ]
          : profile.id === LITIGATION_JUDGMENT_APPEAL_ASSESSMENT_WORKFLOW_ID
            ? [["judgment-appeal-assessment", "draft", "docx"]]
          : profile.id === MATTER_TIMELINE_WORKFLOW_ID
            ? [["matter-timeline", "tabular_review", "xlsx"]]
          : profile.id === USPTO_OFFICE_ACTION_RESPONSE_WORKFLOW_ID
            ? [["office-action-response", "draft", "docx"]]
          : profile.id === PATENT_CLAIM_COMPARISON_WORKFLOW_ID
            ? [["claim-comparison-chart", "draft", "docx"]]
          : profile.id === PATENT_FTO_SCREENING_WORKFLOW_ID
            ? [["fto-screening-report", "draft", "docx"]]
          : profile.id === PATENT_INFRINGEMENT_ANALYSIS_WORKFLOW_ID
            ? [["infringement-analysis-report", "draft", "docx"]]
          : profile.id === PATENTABILITY_ASSESSMENT_WORKFLOW_ID
            ? [
                ["patentability-feature-chart", "tabular_review", "xlsx"],
                ["patentability-memo", "draft", "docx"],
              ]
          : profile.id === PATENT_INVALIDITY_SEARCH_WORKFLOW_ID
            ? [
                ["invalidity-claim-chart", "tabular_review", "xlsx"],
                ["invalidity-screening-memo", "draft", "docx"],
              ]
          : [["cited-research-memo", "draft", "docx"]];
    if (profile.artifactContracts.length !== expectedContracts.length) {
      fail(`${label}.artifactContracts must declare the fixed deliverables`);
    }
    for (const [index, contract] of profile.artifactContracts.entries()) {
      assertExactObjectKeys(
        contract,
        ["artifactType", "format", "key", "kind", "operation", "required"],
        `${label}.artifactContracts[${index}]`,
      );
      const [expectedKey, expectedArtifactType, expectedFormat] =
        expectedContracts[index];
      if (
        contract.key !== expectedKey ||
        contract.artifactType !== expectedArtifactType ||
        contract.kind !== "document" ||
        contract.format !== expectedFormat ||
        contract.operation !== "create" ||
        contract.required !== true
      ) {
        fail(`${label}.artifactContracts must declare fixed required outputs`);
      }
    }
    if (
      profile.id !== MATTER_TIMELINE_WORKFLOW_ID &&
      !profile.requiredCapabilities.includes("create_draft")
    ) {
      fail(
        `${label}.requiredCapabilities must declare "create_draft" for its required artifact contract`,
      );
    }
    if (
      profile.id !== LITIGATION_HEARING_PREPARATION_WORKFLOW_ID &&
      profile.id !== LITIGATION_CASE_MAP_WORKFLOW_ID &&
      profile.id !== MATTER_TIMELINE_WORKFLOW_ID &&
      profile.id !== PATENTABILITY_ASSESSMENT_WORKFLOW_ID &&
      profile.id !== PATENT_INVALIDITY_SEARCH_WORKFLOW_ID &&
      profile.requiredCapabilities.includes("create_tabular")
    ) {
      fail(
        `${label}.requiredCapabilities cannot declare unrelated "create_tabular"`,
      );
    }
    if (
      (profile.id === LITIGATION_HEARING_PREPARATION_WORKFLOW_ID ||
        profile.id === LITIGATION_CASE_MAP_WORKFLOW_ID ||
        profile.id === MATTER_TIMELINE_WORKFLOW_ID ||
        profile.id === PATENTABILITY_ASSESSMENT_WORKFLOW_ID ||
        profile.id === PATENT_INVALIDITY_SEARCH_WORKFLOW_ID) &&
      !profile.requiredCapabilities.includes("create_tabular")
    ) {
      fail(
        `${label}.requiredCapabilities must declare "create_tabular" for its Tabular Review`,
      );
    }
    assertExactObjectKeys(
      profile.sourceStandard,
      [
        "authorityAsOfRequired",
        "authorityRequired",
        "materialClaimsRequireCitations",
        "pinnedDocumentVersionsRequired",
      ],
      `${label}.sourceStandard`,
    );
    for (const value of Object.values(profile.sourceStandard)) {
      if (typeof value !== "boolean") {
        fail(`${label}.sourceStandard values must be boolean`);
      }
    }
    if (
      profile.sourceStandard.pinnedDocumentVersionsRequired !== true ||
      profile.sourceStandard.materialClaimsRequireCitations !== true
    ) {
      fail(`${label}.sourceStandard must require pinned cited Matter sources`);
    }
    if (
      profile.id !== CONTRACT_PLAYBOOK_REVIEW_WORKFLOW_ID &&
      profile.id !== LITIGATION_CASE_MAP_WORKFLOW_ID &&
      profile.id !== LITIGATION_HEARING_PREPARATION_WORKFLOW_ID &&
      profile.id !== MATTER_TIMELINE_WORKFLOW_ID &&
      profile.id !== PATENT_CLAIM_COMPARISON_WORKFLOW_ID &&
      profile.id !== PATENT_FTO_SCREENING_WORKFLOW_ID &&
      profile.id !== PATENT_INFRINGEMENT_ANALYSIS_WORKFLOW_ID &&
      profile.id !== PATENT_INVALIDITY_SEARCH_WORKFLOW_ID &&
      profile.id !== PATENTABILITY_ASSESSMENT_WORKFLOW_ID &&
      profile.id !== USPTO_OFFICE_ACTION_RESPONSE_WORKFLOW_ID &&
      (profile.sourceStandard.authorityRequired !== true ||
        profile.sourceStandard.authorityAsOfRequired !== true)
    ) {
      fail(`${label}.sourceStandard must require authority and as-of coverage`);
    }
    if (
      (profile.id === CONTRACT_PLAYBOOK_REVIEW_WORKFLOW_ID ||
        profile.id === LITIGATION_CASE_MAP_WORKFLOW_ID ||
        profile.id === LITIGATION_HEARING_PREPARATION_WORKFLOW_ID ||
        profile.id === MATTER_TIMELINE_WORKFLOW_ID ||
        profile.id === PATENT_CLAIM_COMPARISON_WORKFLOW_ID ||
        profile.id === PATENT_FTO_SCREENING_WORKFLOW_ID ||
        profile.id === PATENT_INFRINGEMENT_ANALYSIS_WORKFLOW_ID ||
        profile.id === PATENT_INVALIDITY_SEARCH_WORKFLOW_ID ||
        profile.id === PATENTABILITY_ASSESSMENT_WORKFLOW_ID ||
        profile.id === USPTO_OFFICE_ACTION_RESPONSE_WORKFLOW_ID) &&
      (profile.sourceStandard.authorityRequired !== false ||
        profile.sourceStandard.authorityAsOfRequired !== false)
    ) {
      fail(`${label}.sourceStandard must not imply unavailable authority research`);
    }
    assertUniqueStringArray(
      profile.completionChecks,
      `${label}.completionChecks`,
    );
    for (const check of profile.completionChecks) {
      if (!GOAL_COMPLETION_CHECKS.includes(check)) {
        fail(`${label}.completionChecks contains unsupported check "${check}"`);
      }
    }
    if (!profile.completionChecks.includes("deliverables_present")) {
      fail(
        `${label}.completionChecks must include deliverables_present for its required artifact`,
      );
    }
    assertString(profile.verifierProfile, `${label}.verifierProfile`);
    assertUniqueStringArray(profile.fixtures, `${label}.fixtures`, {
      allowEmpty: true,
    });
    profile.fixtures.forEach((fixture, index) =>
      assertRepositoryFixturePath(
        fixture,
        `${label}.fixtures[${index}]`,
      ),
    );
    if (
      !profile.fixtureSha256 ||
      typeof profile.fixtureSha256 !== "object" ||
      Array.isArray(profile.fixtureSha256)
    ) {
      fail(`${label}.fixtureSha256 must be an object`);
    }
    const fixtureKeys = Object.keys(profile.fixtureSha256).sort((a, b) =>
      a.localeCompare(b),
    );
    const expectedFixtureKeys = [...profile.fixtures].sort((a, b) =>
      a.localeCompare(b),
    );
    if (JSON.stringify(fixtureKeys) !== JSON.stringify(expectedFixtureKeys)) {
      fail(`${label}.fixtureSha256 must contain exactly the fixture paths`);
    }
    for (const fixture of profile.fixtures) {
      const expectedDigest = profile.fixtureSha256[fixture];
      if (
        typeof expectedDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(expectedDigest)
      ) {
        fail(`${label}.fixtureSha256[${fixture}] must be a lowercase SHA-256`);
      }
      const actualDigest = fixtureSha256(
        fixture,
        `${label}.fixtures[${fixture}]`,
      );
      if (actualDigest !== expectedDigest) {
        fail(`${label}.fixtures[${fixture}] content changed`);
      }
    }
    assertUniqueStringArray(profile.dependencies, `${label}.dependencies`, {
      allowEmpty: true,
    });
  }

  const mikeAssistantCount = lock.selection.assistant.length;
  const mikeTabularCount = lock.selection.tabular.length;
  const firstPartyAssistantCount = lock.firstParty.selection.length;
  if (
    lock.expected?.activeAssistantCount !== mikeAssistantCount ||
    lock.expected?.activeTabularCount !== mikeTabularCount ||
    lock.expected?.activeWorkflowCount !==
      mikeAssistantCount + mikeTabularCount ||
    lock.expected?.assistantCount !==
      mikeAssistantCount + firstPartyAssistantCount ||
    lock.expected?.tabularCount !== mikeTabularCount ||
    lock.expected?.workflowCount !==
      mikeAssistantCount + mikeTabularCount + firstPartyAssistantCount
  ) {
    fail("Workflow lock counts do not match the explicit selection");
  }
  const manifestPolicy = lock.skillManifest;
  if (
    !manifestPolicy ||
    typeof manifestPolicy !== "object" ||
    Array.isArray(manifestPolicy) ||
    manifestPolicy.schemaVersion !== 1
  ) {
    fail("lock.skillManifest.schemaVersion must be 1");
  }
  assertExactObjectKeys(
    manifestPolicy,
    ["allowedCapabilities", "schemaVersion", "workflows"],
    "lock.skillManifest",
  );
  assertUniqueStringArray(
    manifestPolicy.allowedCapabilities,
    "lock.skillManifest.allowedCapabilities",
  );
  const sortedCapabilities = [...manifestPolicy.allowedCapabilities].sort(
    (a, b) => a.localeCompare(b),
  );
  if (
    JSON.stringify(manifestPolicy.allowedCapabilities) !==
      JSON.stringify(sortedCapabilities) ||
    JSON.stringify(manifestPolicy.allowedCapabilities) !==
      JSON.stringify(KERNEL_CAPABILITIES)
  ) {
    fail(
      `lock.skillManifest.allowedCapabilities must equal the sorted Kernel allowlist: ${KERNEL_CAPABILITIES.join(", ")}`,
    );
  }
  if (
    !manifestPolicy.workflows ||
    typeof manifestPolicy.workflows !== "object" ||
    Array.isArray(manifestPolicy.workflows)
  ) {
    fail("lock.skillManifest.workflows must be an object");
  }
  const selectedWorkflowTypes = new Map();
  for (const collection of COLLECTIONS) {
    for (const slug of lock.selection[collection.key]) {
      if (selectedWorkflowTypes.has(slug)) {
        fail(`Workflow "${slug}" is selected in more than one collection`);
      }
      selectedWorkflowTypes.set(slug, collection.key);
    }
  }
  for (const slug of selectedWorkflowTypes.keys()) {
    if (!Object.hasOwn(manifestPolicy.workflows, slug)) {
      fail(`lock.skillManifest.workflows is missing selected workflow "${slug}"`);
    }
  }
  for (const slug of Object.keys(manifestPolicy.workflows)) {
    if (!selectedWorkflowTypes.has(slug)) {
      fail(
        `lock.skillManifest.workflows contains unselected workflow "${slug}"`,
      );
    }
  }
  if (
    Object.keys(manifestPolicy.workflows).length !== selectedWorkflowTypes.size
  ) {
    fail("lock.skillManifest.workflows must cover each selected workflow once");
  }

  for (const [slug, workflowType] of selectedWorkflowTypes) {
    const profile = manifestPolicy.workflows[slug];
    const label = `lock.skillManifest.workflows.${slug}`;
    assertExactObjectKeys(
      profile,
      [
        "artifactContract",
        "completionChecks",
        "requiredCapabilities",
        "taskFamily",
        "verifierProfile",
        "workflowType",
      ],
      label,
    );
    if (profile.workflowType !== workflowType) {
      fail(`${label}.workflowType must be "${workflowType}"`);
    }
    if (
      !GOAL_PROFILES.includes(profile.taskFamily) ||
      !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(profile.taskFamily)
    ) {
      fail(`${label}.taskFamily must be an existing GoalProfile`);
    }
    assertUniqueStringArray(
      profile.requiredCapabilities,
      `${label}.requiredCapabilities`,
    );
    for (const capability of profile.requiredCapabilities) {
      if (!manifestPolicy.allowedCapabilities.includes(capability)) {
        fail(
          `${label}.requiredCapabilities contains non-allowlisted capability "${capability}"`,
        );
      }
    }
    const contract = profile.artifactContract;
    assertExactObjectKeys(
      contract,
      ["artifactType", "format", "kind", "operation", "required"],
      `${label}.artifactContract`,
    );
    if (!["draft", "tabular_review"].includes(contract.artifactType)) {
      fail(`${label}.artifactContract.artifactType is unsupported`);
    }
    const expectedArtifact =
      workflowType === "assistant"
        ? { artifactType: "draft", format: "docx" }
        : { artifactType: "tabular_review", format: "xlsx" };
    if (
      contract.artifactType !== expectedArtifact.artifactType ||
      contract.format !== expectedArtifact.format ||
      contract.kind !== "document" ||
      contract.operation !== "create"
    ) {
      fail(`${label}.artifactContract.format is unsupported`);
    }
    if (typeof contract.required !== "boolean") {
      fail(`${label}.artifactContract.required must be a boolean`);
    }
    const expectedCapability =
      contract.artifactType === "draft" ? "create_draft" : "create_tabular";
    if (
      contract.required &&
      !profile.requiredCapabilities.includes(expectedCapability)
    ) {
      fail(
        `${label}.requiredCapabilities must declare "${expectedCapability}" for its required artifact contract`,
      );
    }
    if (
      !contract.required &&
      profile.requiredCapabilities.includes(expectedCapability)
    ) {
      fail(
        `${label}.requiredCapabilities must not declare "${expectedCapability}" for an optional artifact contract`,
      );
    }
    const unrelatedCreationCapability =
      expectedCapability === "create_draft"
        ? "create_tabular"
        : "create_draft";
    if (profile.requiredCapabilities.includes(unrelatedCreationCapability)) {
      fail(
        `${label}.requiredCapabilities cannot declare unrelated "${unrelatedCreationCapability}"`,
      );
    }
    assertUniqueStringArray(
      profile.completionChecks,
      `${label}.completionChecks`,
    );
    for (const check of profile.completionChecks) {
      if (!GOAL_COMPLETION_CHECKS.includes(check)) {
        fail(`${label}.completionChecks contains unsupported check "${check}"`);
      }
    }
    if (
      contract.required !==
      profile.completionChecks.includes("deliverables_present")
    ) {
      fail(
        `${label}.completionChecks must match whether its artifact is required`,
      );
    }
    assertString(profile.verifierProfile, `${label}.verifierProfile`);
  }

  for (const field of [
    "semanticSha256",
    "systemSemanticSha256",
    "mikeSkillManifestSemanticSha256",
    "skillManifestSemanticSha256",
    "generatedFileSha256",
  ]) {
    if (!/^[a-f0-9]{64}$/.test(lock.expected?.[field] ?? "")) {
      fail(`lock.expected.${field} must be a lowercase SHA-256`);
    }
  }
  return lock;
}

function loadLock(filePath = LOCK_PATH) {
  return validateLock(readJson(filePath));
}

function readWorkflow(sourceRoot, category, collectionDirectory, slug) {
  const workflowDir = path.join(sourceRoot, collectionDirectory, slug);
  const skillPath = path.join(workflowDir, "SKILL.md");
  const relativeSkillPath = path.relative(sourceRoot, skillPath);
  if (!fs.existsSync(skillPath)) fail(`${relativeSkillPath} is required`);

  const { metadata: frontmatter, body: skillMd } = readSkillFile(
    skillPath,
    sourceRoot,
  );
  const label = `${relativeSkillPath} frontmatter`;
  const metadata = frontmatter.metadata;

  assertNoAuthorityGrant(frontmatter, label);
  assertString(frontmatter.name, `${label}.name`);
  if (frontmatter.name !== slug) {
    fail(`${label}.name must match the locked folder name "${slug}"`);
  }
  assertString(frontmatter.description, `${label}.description`);
  if (frontmatter.license !== "MIT") fail(`${label}.license must be MIT`);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    fail(`${label}.metadata must be a mapping`);
  }
  assertString(metadata.author, `${label}.metadata.author`);
  assertString(metadata.language, `${label}.metadata.language`);
  assertString(metadata.version, `${label}.metadata.version`);
  assertString(
    metadata["mike-display-name"],
    `${label}.metadata.mike-display-name`,
  );
  if (metadata["mike-type"] !== category) {
    fail(`${label}.metadata.mike-type must be "${category}"`);
  }
  if (metadata["mike-availability"] !== "system") {
    fail(`${label}.metadata.mike-availability must be "system"`);
  }
  assertString(metadata.practice, `${label}.metadata.practice`);
  assertString(metadata.jurisdictions, `${label}.metadata.jurisdictions`);

  const normalizedMetadata = {
    title: metadata["mike-display-name"],
    description: frontmatter.description,
    type: category,
    contributors: [
      {
        name: metadata.author.trim(),
        organisation: null,
        role: null,
        linkedin: null,
      },
    ],
    language: metadata.language,
    version: metadata.version,
    practice: metadata.practice,
    jurisdictions: metadata.jurisdictions
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  };

  if (category === "assistant") {
    if (!skillMd.trim()) fail(`${relativeSkillPath} must include instructions`);
    assertSafeSkillInstructions(
      [frontmatter.description, skillMd].join("\n"),
      `${relativeSkillPath} compiled instructions`,
    );
    if (fs.existsSync(path.join(workflowDir, "table-columns.yaml"))) {
      fail(`${relativeSkillPath} assistant workflow must not define columns`);
    }
    return {
      id: `builtin-${slug}`,
      slug,
      source_path: relativeSkillPath,
      metadata: normalizedMetadata,
      skill_md: skillMd,
      columns_config: null,
    };
  }

  const tableColumnsPath = path.join(workflowDir, "table-columns.yaml");
  if (!fs.existsSync(tableColumnsPath)) {
    fail(`${path.relative(sourceRoot, tableColumnsPath)} is required`);
  }
  const tableConfig = parseTableColumnsYaml(tableColumnsPath, sourceRoot);
  const expectedSchemaPath = path.join(
    sourceRoot,
    "workflow-schema/table-columns.schema.yaml",
  );
  const actualSchemaPath = path.resolve(workflowDir, tableConfig.$schema ?? "");
  if (actualSchemaPath !== expectedSchemaPath) {
    fail(
      `${path.relative(sourceRoot, tableColumnsPath)}.$schema must point to workflow-schema/table-columns.schema.yaml`,
    );
  }
  assertColumnConfig(
    tableConfig.columns_config,
    path.relative(sourceRoot, tableColumnsPath),
  );
  assertSafeSkillInstructions(
    [
      frontmatter.description,
      skillMd,
      ...tableConfig.columns_config.flatMap((column) => [
        column.name,
        column.prompt,
      ]),
    ]
      .filter(Boolean)
      .join("\n"),
    `${relativeSkillPath} compiled instructions`,
  );
  return {
    id: `builtin-${slug}`,
    slug,
    source_path: relativeSkillPath,
    metadata: normalizedMetadata,
    skill_md: skillMd || null,
    columns_config: tableConfig.columns_config,
  };
}

function readFirstPartyWorkflow(repositoryRoot, slug, profile) {
  const skillPath = path.resolve(repositoryRoot, profile.sourcePath);
  const relativeSkillPath = path.relative(repositoryRoot, skillPath);
  if (
    relativeSkillPath !== profile.sourcePath ||
    relativeSkillPath.startsWith("..") ||
    path.isAbsolute(relativeSkillPath)
  ) {
    fail(
      `lock.firstParty.workflows.${slug}.sourcePath must stay inside the repository`,
    );
  }
  if (!fs.existsSync(skillPath)) fail(`${relativeSkillPath} is required`);
  const actualContentSha256 = sha256(readText(skillPath));
  if (actualContentSha256 !== profile.contentSha256) {
    fail(
      `${relativeSkillPath} content changed: expected ${profile.contentSha256}, received ${actualContentSha256}`,
    );
  }

  const { metadata: frontmatter, body: skillMd } = readSkillFile(
    skillPath,
    repositoryRoot,
  );
  const label = `${relativeSkillPath} frontmatter`;
  assertExactObjectKeys(
    frontmatter,
    ["description", "license", "metadata", "name"],
    label,
  );
  assertNoAuthorityGrant(frontmatter, label);
  if (frontmatter.name !== slug) {
    fail(`${label}.name must match the locked folder name "${slug}"`);
  }
  assertString(frontmatter.description, `${label}.description`);
  if (frontmatter.license !== profile.license) {
    fail(`${label}.license must match the first-party lock`);
  }
  assertExactObjectKeys(
    frontmatter.metadata,
    [
      "author",
      "jurisdictions",
      "language",
      "practice",
      "vera-availability",
      "vera-display-name",
      "vera-type",
      "version",
    ],
    `${label}.metadata`,
  );
  const metadata = frontmatter.metadata;
  if (metadata.version !== profile.version) {
    fail(`${label}.metadata.version must match the first-party lock`);
  }
  assertString(metadata.author, `${label}.metadata.author`);
  assertString(metadata.language, `${label}.metadata.language`);
  assertString(metadata["vera-display-name"], `${label}.metadata.vera-display-name`);
  if (metadata["vera-type"] !== "assistant") {
    fail(`${label}.metadata.vera-type must be "assistant"`);
  }
  if (metadata["vera-availability"] !== "system") {
    fail(`${label}.metadata.vera-availability must be "system"`);
  }
  assertString(metadata.practice, `${label}.metadata.practice`);
  assertString(metadata.jurisdictions, `${label}.metadata.jurisdictions`);
  if (!skillMd.trim()) fail(`${relativeSkillPath} must include instructions`);
  assertSafeSkillInstructions(
    [frontmatter.description, skillMd].join("\n"),
    `${relativeSkillPath} compiled instructions`,
  );

  return {
    id: profile.id,
    slug,
    origin: "vera_first_party",
    source_path: relativeSkillPath,
    metadata: {
      title: metadata["vera-display-name"],
      description: frontmatter.description,
      type: "assistant",
      contributors: [
        {
          name: metadata.author.trim(),
          organisation: null,
          role: null,
          linkedin: null,
        },
      ],
      language: metadata.language,
      version: metadata.version,
      practice: metadata.practice,
      jurisdictions: metadata.jurisdictions
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    },
    skill_md: skillMd,
    columns_config: null,
  };
}

function loadSelectedWorkflows(sourceRoot, lock) {
  const workflows = [];
  const seenIds = new Set();
  for (const collection of COLLECTIONS) {
    for (const slug of lock.selection[collection.key]) {
      const workflow = readWorkflow(
        sourceRoot,
        collection.key,
        collection.directory,
        slug,
      );
      if (seenIds.has(workflow.id))
        fail(`Duplicate workflow id: ${workflow.id}`);
      seenIds.add(workflow.id);
      workflows.push(workflow);
    }
  }
  return workflows.sort((a, b) => a.id.localeCompare(b.id));
}

function loadFirstPartyWorkflows(repositoryRoot, lock) {
  const workflows = lock.firstParty.selection.map((slug) =>
    readFirstPartyWorkflow(
      repositoryRoot,
      slug,
      lock.firstParty.workflows[slug],
    ),
  );
  const ids = workflows.map((workflow) => workflow.id);
  if (new Set(ids).size !== ids.length) {
    fail("First-party workflow ids must be unique");
  }
  return workflows.sort((a, b) => a.id.localeCompare(b.id));
}

function loadAllSelectedWorkflows(
  sourceRoot,
  lock,
  repositoryRoot = REPOSITORY_ROOT,
) {
  const workflows = [
    ...loadSelectedWorkflows(sourceRoot, lock),
    ...loadFirstPartyWorkflows(repositoryRoot, lock),
  ].sort((a, b) => a.id.localeCompare(b.id));
  const ids = workflows.map((workflow) => workflow.id);
  if (new Set(ids).size !== ids.length) {
    fail("Mike and first-party workflow ids must be globally unique");
  }
  return workflows;
}

function formatTs(value) {
  return JSON.stringify(value, null, 4);
}

function buildSkillManifestPayload(workflow, lock) {
  const firstPartyProfile =
    workflow.origin === "vera_first_party"
      ? lock.firstParty.workflows[workflow.slug]
      : null;
  const profile =
    firstPartyProfile ?? lock.skillManifest.workflows[workflow.slug];
  return {
    schema_version: SKILL_MANIFEST_SCHEMA_VERSION,
    id: workflow.id,
    version: workflow.metadata.version,
    title: workflow.metadata.title,
    license: firstPartyProfile?.license ?? lock.license,
    provenance: firstPartyProfile
      ? {
          source: firstPartyProfile.provenance.source,
          revision: firstPartyProfile.provenance.revision,
          path: workflow.source_path,
        }
      : {
          repository: lock.repository,
          commit: lock.commit,
          path: workflow.source_path,
        },
    metadata: workflow.metadata,
    skill_md: workflow.skill_md,
    columns_config: workflow.columns_config,
    task_families: [profile.taskFamily],
    jurisdictions: workflow.metadata.jurisdictions ?? [],
    input_contract: {
      matter_scoped: true,
      minimum_documents: firstPartyProfile?.minimumDocuments ?? 1,
      pinned_document_versions_required: true,
      accepted_document_roles: [
        "source",
        "template",
        "precedent",
        "authority",
      ],
      unfixed_client_content_allowed: false,
    },
    required_capabilities: [...profile.requiredCapabilities],
    capability_effect: "requirements_only",
    artifact_contract: {
      artifact_type: profile.artifactContract.artifactType,
      kind: profile.artifactContract.kind,
      format: profile.artifactContract.format,
      operation: profile.artifactContract.operation,
      required: profile.artifactContract.required,
    },
    ...(firstPartyProfile
      ? {
          artifact_contracts: firstPartyProfile.artifactContracts.map(
            (contract) => ({
              key: contract.key,
              artifact_type: contract.artifactType,
              kind: contract.kind,
              format: contract.format,
              operation: contract.operation,
              required: contract.required,
            }),
          ),
        }
      : {}),
    source_standard: {
      pinned_document_versions_required:
        firstPartyProfile?.sourceStandard.pinnedDocumentVersionsRequired ??
        true,
      material_claims_require_citations:
        firstPartyProfile?.sourceStandard.materialClaimsRequireCitations ??
        true,
      authority_required:
        firstPartyProfile?.sourceStandard.authorityRequired ?? false,
      authority_as_of_required:
        firstPartyProfile?.sourceStandard.authorityAsOfRequired ?? false,
    },
    must_ask_when: [...DEFAULT_MUST_ASK_WHEN],
    completion_checks: [...profile.completionChecks],
    verifier_profile: profile.verifierProfile,
    fixtures: firstPartyProfile ? [...firstPartyProfile.fixtures] : [],
    dependencies: firstPartyProfile
      ? [...firstPartyProfile.dependencies]
      : [],
    deprecation: {
      deprecated: false,
      replacement_id: null,
    },
  };
}

function buildSkillManifest(workflow, lock) {
  const payload = buildSkillManifestPayload(workflow, lock);
  return {
    schema_version: payload.schema_version,
    id: payload.id,
    version: payload.version,
    title: payload.title,
    license: payload.license,
    provenance: payload.provenance,
    content_digest: `sha256:${sha256(JSON.stringify(payload))}`,
    task_families: payload.task_families,
    jurisdictions: payload.jurisdictions,
    input_contract: payload.input_contract,
    required_capabilities: payload.required_capabilities,
    capability_effect: payload.capability_effect,
    artifact_contract: payload.artifact_contract,
    artifact_contracts: payload.artifact_contracts,
    source_standard: payload.source_standard,
    must_ask_when: payload.must_ask_when,
    completion_checks: payload.completion_checks,
    verifier_profile: payload.verifier_profile,
    fixtures: payload.fixtures,
    dependencies: payload.dependencies,
    deprecation: payload.deprecation,
  };
}

function buildArtifacts(activeWorkflows, manifestWorkflows, lock) {
  const systemWorkflows = activeWorkflows.map((workflow) => ({
    user_id: null,
    is_system: true,
    created_at: "",
    id: workflow.id,
    metadata: workflow.metadata,
    skill_md: workflow.skill_md,
    columns_config: workflow.columns_config,
  }));
  const systemAssistantWorkflows = activeWorkflows
    .filter((workflow) => workflow.metadata.type === "assistant")
    .map((workflow) => ({
      id: workflow.id,
      title: workflow.metadata.title,
      skill_md: workflow.skill_md,
    }));
  const skillManifests = manifestWorkflows.map((workflow) =>
    buildSkillManifest(workflow, lock),
  );
  const backendText = `// This file is generated by scripts/build-workflows.js. Do not edit it directly.\n\nexport type SystemWorkflowContributor = {\n    name: string;\n    organisation: string | null;\n    role: string | null;\n    linkedin: string | null;\n};\n\nexport type SystemWorkflowMetadata = {\n    title: string;\n    description: string;\n    type: "assistant" | "tabular";\n    contributors: SystemWorkflowContributor[];\n    language: string;\n    version: string;\n    practice: string | null;\n    jurisdictions: string[] | null;\n};\n\nexport type SystemWorkflow = {\n    id: string;\n    user_id: null;\n    is_system: true;\n    created_at: string;\n    metadata: SystemWorkflowMetadata;\n    skill_md: string | null;\n    columns_config: { index: number; name: string; format?: string; prompt: string; tags?: string[] }[] | null;\n};\n\nexport type SkillManifestCapability = "analyze" | "create_draft" | "create_tabular" | "read_sources" | "verify";\nexport type SkillManifestGoalProfile = "contract_review" | "compare" | "extract" | "draft" | "proofread" | "generic" | "research";\nexport type SkillManifestCompletionCheck = "deliverables_present" | "goal_covered" | "source_supported" | "citations_relocatable" | "steps_complete";\nexport type SkillManifestMustAskReason = "missing_source" | "missing_fact" | "evidence_conflict" | "legal_judgment" | "source_version_changed" | "material_scope_change" | "consequential_action";\n\nexport type SkillManifestV1 = {\n    schema_version: "skill_manifest_v1";\n    id: string;\n    version: string;\n    title: string;\n    license: "MIT" | "AGPL-3.0-only";\n    provenance:\n        | { repository: string; commit: string; path: string }\n        | { source: string; revision: string; path: string };\n    content_digest: \`sha256:\${string}\`;\n    task_families: SkillManifestGoalProfile[];\n    jurisdictions: string[];\n    input_contract: {\n        matter_scoped: true;\n        minimum_documents: number;\n        pinned_document_versions_required: true;\n        accepted_document_roles: ("source" | "template" | "precedent" | "authority")[];\n        unfixed_client_content_allowed: false;\n    };\n    required_capabilities: SkillManifestCapability[];\n    capability_effect: "requirements_only";\n    artifact_contract: {\n        artifact_type: "draft" | "tabular_review";\n        kind: "document";\n        format: "docx" | "xlsx";\n        operation: "create";\n        required: boolean;\n    };\n    artifact_contracts?: {\n        key: string;\n        artifact_type: "draft" | "tabular_review";\n        kind: "document";\n        format: "docx" | "xlsx";\n        operation: "create";\n        required: boolean;\n    }[];\n    source_standard: {\n        pinned_document_versions_required: true;\n        material_claims_require_citations: true;\n        authority_required: boolean;\n        authority_as_of_required: boolean;\n    };\n    must_ask_when: SkillManifestMustAskReason[];\n    completion_checks: SkillManifestCompletionCheck[];\n    verifier_profile: string;\n    fixtures: string[];\n    dependencies: string[];\n    deprecation: { deprecated: boolean; replacement_id: string | null };\n};\n\nexport const SYSTEM_WORKFLOWS: SystemWorkflow[] = ${formatTs(systemWorkflows)};\n\nexport const SYSTEM_WORKFLOW_IDS = new Set(SYSTEM_WORKFLOWS.map((wf) => wf.id));\n\nexport const SYSTEM_ASSISTANT_WORKFLOWS: { id: string; title: string; skill_md: string }[] = ${formatTs(systemAssistantWorkflows)};\n\n// Declarative requirements only. A Task-scoped resolver must intersect these with Kernel, Pack,\n// Provider, Connector, Matter/version, and consequential-action policy; this export grants nothing.\nexport const SYSTEM_SKILL_MANIFESTS: SkillManifestV1[] = ${formatTs(skillManifests)};\n\nexport const SYSTEM_SKILL_MANIFEST_BY_WORKFLOW_ID = new Map(\n    SYSTEM_SKILL_MANIFESTS.map((manifest) => [manifest.id, manifest] as const),\n);\n`;
  return {
    backendText,
    systemWorkflows,
    systemAssistantWorkflows,
    manifestWorkflows,
    skillManifests,
  };
}

function verifyArtifacts(artifacts, lock) {
  const assistantCount = artifacts.systemWorkflows.filter(
    (workflow) => workflow.metadata.type === "assistant",
  ).length;
  const tabularCount = artifacts.systemWorkflows.filter(
    (workflow) => workflow.metadata.type === "tabular",
  ).length;
  if (
    artifacts.systemWorkflows.length !== lock.expected.activeWorkflowCount ||
    assistantCount !== lock.expected.activeAssistantCount ||
    tabularCount !== lock.expected.activeTabularCount
  ) {
    fail(
      `Generated workflow counts changed: ${assistantCount} assistant + ${tabularCount} tabular`,
    );
  }

  const manifestAssistantCount = artifacts.manifestWorkflows.filter(
    (workflow) => workflow.metadata.type === "assistant",
  ).length;
  const manifestTabularCount = artifacts.manifestWorkflows.filter(
    (workflow) => workflow.metadata.type === "tabular",
  ).length;
  if (
    artifacts.skillManifests.length !== lock.expected.workflowCount ||
    manifestAssistantCount !== lock.expected.assistantCount ||
    manifestTabularCount !== lock.expected.tabularCount
  ) {
    fail(
      `Generated manifest counts changed: ${manifestAssistantCount} assistant + ${manifestTabularCount} tabular`,
    );
  }

  const firstPartyIds = new Set(
    lock.firstParty.selection.map(
      (slug) => lock.firstParty.workflows[slug].id,
    ),
  );
  const mikeWorkflows = artifacts.systemWorkflows;
  const mikeSkillManifests = artifacts.skillManifests.filter(
    (manifest) => !firstPartyIds.has(manifest.id),
  );
  const semanticSha256 = sha256(JSON.stringify(mikeWorkflows));
  const systemSemanticSha256 = sha256(
    JSON.stringify(artifacts.systemWorkflows),
  );
  const mikeSkillManifestSemanticSha256 = sha256(
    JSON.stringify(mikeSkillManifests),
  );
  const skillManifestSemanticSha256 = sha256(
    JSON.stringify(artifacts.skillManifests),
  );
  const generatedFileSha256 = sha256(artifacts.backendText);
  if (semanticSha256 !== lock.expected.semanticSha256) {
    fail(
      `Generated workflow semantics changed: expected ${lock.expected.semanticSha256}, received ${semanticSha256}`,
    );
  }
  if (systemSemanticSha256 !== lock.expected.systemSemanticSha256) {
    fail(
      `Generated complete workflow semantics changed: expected ${lock.expected.systemSemanticSha256}, received ${systemSemanticSha256}`,
    );
  }
  if (
    mikeSkillManifestSemanticSha256 !==
    lock.expected.mikeSkillManifestSemanticSha256
  ) {
    fail(
      `Generated Mike Skill manifests changed: expected ${lock.expected.mikeSkillManifestSemanticSha256}, received ${mikeSkillManifestSemanticSha256}`,
    );
  }
  if (generatedFileSha256 !== lock.expected.generatedFileSha256) {
    fail(
      `Generated file changed: expected ${lock.expected.generatedFileSha256}, received ${generatedFileSha256}`,
    );
  }
  if (
    skillManifestSemanticSha256 !==
    lock.expected.skillManifestSemanticSha256
  ) {
    fail(
      `Generated Skill manifests changed: expected ${lock.expected.skillManifestSemanticSha256}, received ${skillManifestSemanticSha256}`,
    );
  }
  return {
    semanticSha256,
    systemSemanticSha256,
    mikeSkillManifestSemanticSha256,
    skillManifestSemanticSha256,
    generatedFileSha256,
  };
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = (
      result.stderr ||
      result.stdout ||
      "unknown Git error"
    ).trim();
    fail(`git ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function verifySourceCommit(sourceRoot, lock) {
  const actual = runGit(["rev-parse", "HEAD"], sourceRoot);
  if (actual !== lock.commit) {
    fail(`Workflow source HEAD must be ${lock.commit}; received ${actual}`);
  }
}

function acquireSource(lock, explicitSource) {
  if (explicitSource) {
    const sourceRoot = path.resolve(explicitSource);
    if (!fs.existsSync(sourceRoot))
      fail(`Workflow source not found: ${sourceRoot}`);
    verifySourceCommit(sourceRoot, lock);
    return { sourceRoot, cleanup: () => {} };
  }

  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "vera-mike-workflows-"),
  );
  const sourceRoot = path.join(temporaryRoot, "source");
  fs.mkdirSync(sourceRoot);
  try {
    runGit(["init", "--quiet"], sourceRoot);
    runGit(["remote", "add", "origin", lock.repository], sourceRoot);
    runGit(
      [
        "fetch",
        "--quiet",
        "--depth=1",
        "--filter=blob:none",
        "--no-tags",
        "origin",
        lock.commit,
      ],
      sourceRoot,
    );
    runGit(["checkout", "--quiet", "--detach", "FETCH_HEAD"], sourceRoot);
    verifySourceCommit(sourceRoot, lock);
  } catch (error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    sourceRoot,
    cleanup: () => fs.rmSync(temporaryRoot, { recursive: true, force: true }),
  };
}

function parseArgs(args) {
  const options = { mode: "check", source: null };
  for (let i = 0; i < args.length; i += 1) {
    const argument = args[i];
    if (argument === "--check") {
      options.mode = "check";
    } else if (argument === "--write") {
      options.mode = "write";
    } else if (argument === "--source") {
      i += 1;
      if (!args[i]) fail("--source requires a path");
      options.source = args[i];
    } else if (argument === "--help") {
      options.help = true;
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function writeAtomically(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, value);
  fs.renameSync(temporaryPath, filePath);
}

function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    console.log(
      "Usage: node scripts/build-workflows.js [--check|--write] [--source PATH]",
    );
    return;
  }

  const lock = loadLock();
  const acquired = acquireSource(lock, options.source);
  try {
    const activeWorkflows = loadSelectedWorkflows(
      acquired.sourceRoot,
      lock,
    );
    const manifestWorkflows = loadAllSelectedWorkflows(
      acquired.sourceRoot,
      lock,
      REPOSITORY_ROOT,
    );
    const artifacts = buildArtifacts(activeWorkflows, manifestWorkflows, lock);
    const digests = verifyArtifacts(artifacts, lock);
    const current = fs.existsSync(BACKEND_OUT) ? readText(BACKEND_OUT) : null;

    if (options.mode === "check") {
      if (current !== artifacts.backendText) {
        fail(
          "backend/src/lib/systemWorkflows.ts is out of sync; run npm run workflows:sync from backend/",
        );
      }
      console.log(
        `Workflow sync check passed: ${activeWorkflows.length} active Mike workflows and ${manifestWorkflows.length} manifests (including ${lock.firstParty.selection.length} Vera first-party); Mike ${lock.commit}; system semantic ${digests.systemSemanticSha256}.`,
      );
      return;
    }

    if (current === artifacts.backendText) {
      console.log(
        `Workflow artifact already current: ${activeWorkflows.length} active Mike workflows and ${manifestWorkflows.length} manifests; zero byte drift.`,
      );
      return;
    }
    writeAtomically(BACKEND_OUT, artifacts.backendText);
    console.log(
      `Generated ${activeWorkflows.length} active Mike workflows and ${manifestWorkflows.length} locked Skill manifests.`,
    );
  } finally {
    acquired.cleanup();
  }
}

module.exports = {
  assertSafeSkillInstructions,
  buildArtifacts,
  buildSkillManifest,
  buildSkillManifestPayload,
  fixtureSha256,
  loadLock,
  loadAllSelectedWorkflows,
  loadFirstPartyWorkflows,
  loadSelectedWorkflows,
  parseArgs,
  sha256,
  validateLock,
  verifyArtifacts,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
