import { createHash } from "node:crypto";
import type { LitigationArtifactKind } from "./litigationDomain";

export const DEFAULT_LITIGATION_DOCUMENT_TEMPLATE_ID =
  "cn-litigation-working-paper";
export const DEFAULT_LITIGATION_DOCUMENT_TEMPLATE_VERSION = 1;

type TemplateDefinition = {
  id: string;
  version: number;
  name: string;
  locale: "zh-CN" | "en";
  status: "approved";
  fontFamily: string;
  headingColor: string;
  applicableKinds: LitigationArtifactKind[];
  sectionLabels: Record<string, string>;
};

const ALL_KINDS: LitigationArtifactKind[] = [
  "evidence_catalog",
  "claim_defense_matrix",
  "procedural_clock",
  "litigation_brief",
  "hearing_plan",
  "hearing_bundle_index",
];

const DEFINITIONS: TemplateDefinition[] = [
  {
    id: DEFAULT_LITIGATION_DOCUMENT_TEMPLATE_ID,
    version: DEFAULT_LITIGATION_DOCUMENT_TEMPLATE_VERSION,
    name: "中国民商事诉讼工作底稿",
    locale: "zh-CN",
    status: "approved",
    fontFamily: "PingFang SC",
    headingColor: "111827",
    applicableKinds: ALL_KINDS,
    sectionLabels: {
      facts: "已确认事实",
      factSources: "事实来源",
      positions: "请求权与抗辩",
      issues: "争议焦点",
      gaps: "证据缺口",
      events: "程序事项",
      deadlines: "期限",
      materialFacts: "关键事实",
      proceduralPosture: "程序进展",
      requestedNextActions: "待办事项",
      hearingEvents: "庭审安排",
      issuesForHearing: "庭审争点",
      deadlineChecklist: "期限核对",
      evidenceGaps: "证据缺口",
      hearingBundleEntries: "卷宗目录",
      bundlePagination: "分页规则",
      sourcePolicy: "来源规则",
      unresolvedPositionReviews: "未决复核",
      uncitedLegalPositions: "未引证法律结论",
    },
  },
  {
    id: "neutral-review-memorandum",
    version: 1,
    name: "中性复核备忘录",
    locale: "zh-CN",
    status: "approved",
    fontFamily: "Songti SC",
    headingColor: "374151",
    applicableKinds: ALL_KINDS,
    sectionLabels: {
      facts: "事实记录",
      factSources: "来源核验",
      positions: "各方立场",
      issues: "待复核问题",
      gaps: "缺失材料",
      events: "程序记录",
      deadlines: "期限记录",
      materialFacts: "重要事实",
      proceduralPosture: "程序状态",
      requestedNextActions: "建议复核事项",
      hearingEvents: "庭审记录",
      issuesForHearing: "庭审核对事项",
      deadlineChecklist: "期限核对",
      evidenceGaps: "缺失材料",
      hearingBundleEntries: "材料目录",
      bundlePagination: "分页记录",
      sourcePolicy: "来源规则",
      unresolvedPositionReviews: "未决复核",
      uncitedLegalPositions: "未引证结论",
    },
  },
];

function templateHash(definition: TemplateDefinition) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(definition))
    .digest("hex")}`;
}

export type LitigationDocumentTemplate = TemplateDefinition & {
  templateHash: string;
};

export function listLitigationDocumentTemplates() {
  return DEFINITIONS.map((definition) => ({
    ...definition,
    applicableKinds: [...definition.applicableKinds],
    sectionLabels: { ...definition.sectionLabels },
    templateHash: templateHash(definition),
  }));
}

export function resolveLitigationDocumentTemplate(
  id = DEFAULT_LITIGATION_DOCUMENT_TEMPLATE_ID,
  version = DEFAULT_LITIGATION_DOCUMENT_TEMPLATE_VERSION,
) {
  return (
    listLitigationDocumentTemplates().find(
      (item) => item.id === id && item.version === version,
    ) ?? null
  );
}
