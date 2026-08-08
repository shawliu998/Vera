import { createHash } from "node:crypto";

import { z } from "zod";

import type { createServerSupabase } from "./supabase";
import { downloadFile } from "./storage";
import type { MatterContextManifestV1 } from "./agent-kernel/context/matterContext";
import type {
  AgentRequiredInputResponseV1,
  AgentRequiredInputV1,
} from "./agent-kernel/contracts/requiredInput";
import {
  compileContractPlaybookContext,
  ContractPlaybookContextError,
  parseContractPlaybookContextRequiredInput,
} from "./agent-packs/contract/contractPlaybookContext";
import { extractDocxBodyText } from "./docxTrackedChanges";

type Db = ReturnType<typeof createServerSupabase>;

const playbookRuleSchema = z
  .object({
    rule_id: z.string().trim().min(1).max(120),
    rule_version: z.string().trim().min(1).max(120),
  })
  .passthrough();

const fixedPlaybookSchema = z
  .object({
    schema_version: z.literal("vera_contract_playbook_pack_v1"),
    base_rules: z.array(playbookRuleSchema).max(500),
    packs: z
      .array(
        z
          .object({
            pack_id: z.string().trim().min(1).max(120),
            rules: z.array(playbookRuleSchema).max(500),
          })
          .passthrough(),
      )
      .max(100),
  })
  .passthrough();

const overlayByContractType: Record<string, string> = {
  sale_procurement: "prc-sale-procurement",
  services_commission: "prc-services-commission",
  software_services: "prc-services-commission",
  nda: "prc-confidentiality",
  employment_consulting: "prc-employment-consulting",
};

type FixedRuleIdentity = {
  rule_id: string;
  rule_version: string;
};

function uniqueRuleIdentities(rules: FixedRuleIdentity[]) {
  const identities = rules.map(
    (rule) => `${rule.rule_id}\u0000${rule.rule_version}`,
  );
  return rules.length > 0 && new Set(identities).size === identities.length;
}

function parseDocxRuleIdentities(text: string, expectedOverlayId: string) {
  const lines = text
    .normalize("NFKC")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const overlayMatches = lines.filter(
    (line) => line === expectedOverlayId,
  ).length;
  if (overlayMatches !== 1) return [];

  const rules: FixedRuleIdentity[] = [];
  for (const line of lines) {
    const match = line.match(
      /^([A-Za-z0-9][A-Za-z0-9._:-]{0,119})@([A-Za-z0-9][A-Za-z0-9._:-]{0,119})(?:\s|·|$)/u,
    );
    if (!match) continue;
    rules.push({ rule_id: match[1]!, rule_version: match[2]! });
  }
  return uniqueRuleIdentities(rules) ? rules : [];
}

export async function deriveContractPlaybookRuleSet(input: {
  bytes: Uint8Array;
  reviewMode: "quick" | "deep" | "checklist" | "compare";
  contractType: string;
}) {
  const digest = `sha256:${createHash("sha256").update(input.bytes).digest("hex")}`;
  if (input.reviewMode === "compare") {
    return { digest, expectedRuleCount: 0, expectedRules: [] };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(input.bytes),
    );
  } catch {
    decoded = null;
  }
  const playbook = fixedPlaybookSchema.safeParse(decoded);
  const overlayId = overlayByContractType[input.contractType];
  const overlay = playbook.success
    ? playbook.data.packs.find((candidate) => candidate.pack_id === overlayId)
    : null;
  let rules: FixedRuleIdentity[] =
    playbook.success && overlay
      ? [...playbook.data.base_rules, ...overlay.rules].map((rule) => ({
          rule_id: rule.rule_id,
          rule_version: rule.rule_version,
        }))
      : [];
  if (!rules.length && overlayId) {
    try {
      const docxText = await extractDocxBodyText(Buffer.from(input.bytes));
      rules = parseDocxRuleIdentities(docxText, overlayId);
    } catch {
      rules = [];
    }
  }
  const mechanicallyBound = uniqueRuleIdentities(rules);
  if (input.reviewMode === "checklist" && !mechanicallyBound) {
    throw new ContractPlaybookContextError(
      "contract_playbook_rule_set_invalid",
      "Checklist mode requires a mechanically parseable fixed Playbook and a known contract overlay.",
      {
        schema_valid: playbook.success,
        contract_type: input.contractType,
        overlay_id: overlayId ?? null,
      },
    );
  }
  return {
    digest,
    expectedRuleCount: mechanicallyBound ? rules.length : 0,
    expectedRules: mechanicallyBound ? rules : [],
  };
}

export async function compileContractPlaybookContextFromRequiredInput(input: {
  db: Db;
  matter: MatterContextManifestV1;
  requiredInput: AgentRequiredInputV1;
  responses: AgentRequiredInputResponseV1[];
}) {
  const packInput = parseContractPlaybookContextRequiredInput({
    matter: input.matter,
    requiredInput: input.requiredInput,
    responses: input.responses,
  });
  const reference = input.matter.sources.find(
    (source) => source.document_id === packInput.reference_document_id,
  );
  if (!reference) {
    throw new ContractPlaybookContextError(
      "contract_playbook_source_missing",
      "The selected reference is not present in the fixed Matter context.",
    );
  }
  const { data: version, error } = await input.db
    .from("document_versions")
    .select("id,document_id,storage_path,deleted_at")
    .eq("id", reference.version_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (
    !version ||
    version.document_id !== reference.document_id ||
    typeof version.storage_path !== "string" ||
    !version.storage_path.trim() ||
    version.deleted_at
  ) {
    throw new ContractPlaybookContextError(
      "contract_playbook_source_missing",
      "The selected fixed reference Version is unavailable.",
      {
        document_id: reference.document_id,
        version_id: reference.version_id,
      },
    );
  }
  const raw = await downloadFile(version.storage_path);
  if (!raw) {
    throw new ContractPlaybookContextError(
      "contract_playbook_source_missing",
      "The selected fixed reference Version could not be read.",
      { version_id: reference.version_id },
    );
  }
  return compileContractPlaybookContext({
    matter: input.matter,
    packInput,
    referenceRuleSet: await deriveContractPlaybookRuleSet({
      bytes: new Uint8Array(raw),
      reviewMode: packInput.review_mode,
      contractType: packInput.contract_type,
    }),
  });
}
