import { z } from "zod";

import { DocumentStudioDraftTypeV20Schema } from "./documentStudioDraftMetadataV20";

export const DOCUMENT_STUDIO_TEMPLATE_MAX_CONTENT_CHARS_V21 = 2_000_000;
export const DOCUMENT_STUDIO_TEMPLATE_MAX_CONTENT_BYTES_V21 = 4_000_000;
export const DOCUMENT_STUDIO_TEMPLATE_MAX_SECTIONS_V21 = 24;

const SafeText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .refine((value) => [...value].length <= max)
    .refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value));

export const DocumentStudioDraftPlanSectionV21Schema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    heading: SafeText(120),
    purpose: SafeText(500),
    requiredSources: z.array(SafeText(120)).max(8),
  })
  .strict();

export const DocumentStudioDraftPlanV21Schema = z
  .object({
    title: SafeText(240),
    documentType: DocumentStudioDraftTypeV20Schema,
    sections: z
      .array(DocumentStudioDraftPlanSectionV21Schema)
      .min(1)
      .max(DOCUMENT_STUDIO_TEMPLATE_MAX_SECTIONS_V21),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.sections.map((section) => section.id)).size !==
      value.sections.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sections"],
        message: "Draft Plan section identifiers must be unique.",
      });
    }
  });

export type DocumentStudioDraftPlanV21 = z.infer<
  typeof DocumentStudioDraftPlanV21Schema
>;

export type BuiltinDocumentStudioTemplateV21 = {
  id: string;
  key: string;
  title: string;
  description: string;
  documentType: z.infer<typeof DocumentStudioDraftTypeV20Schema>;
  content: string;
  plan: DocumentStudioDraftPlanV21;
};

function template(
  input: Omit<BuiltinDocumentStudioTemplateV21, "content">,
): BuiltinDocumentStudioTemplateV21 {
  const plan = DocumentStudioDraftPlanV21Schema.parse(input.plan);
  const content = plan.sections
    .map(
      (section) =>
        `## ${section.heading}\n\n[${section.purpose}]\n\n` +
        (section.requiredSources.length > 0
          ? `> 待核验资料：${section.requiredSources.join("；")}\n`
          : ""),
    )
    .join("\n");
  return { ...input, plan, content };
}

export const BUILTIN_DOCUMENT_STUDIO_TEMPLATES_V21 = [
  template({
    id: "21000000-0000-4000-8000-000000000001",
    key: "legal_research_memo",
    title: "法律研究备忘录",
    description: "以问题、规则、分析和结论组织可复核的法律研究。",
    documentType: "legal_research_memo",
    plan: {
      title: "法律研究备忘录",
      documentType: "legal_research_memo",
      sections: [
        {
          id: "question",
          heading: "研究问题",
          purpose: "明确待回答的法律问题、法域、基准日期和事实假设",
          requiredSources: [],
        },
        {
          id: "short_answer",
          heading: "简要结论",
          purpose: "给出有保留条件的简明结论，不虚构权威依据",
          requiredSources: [],
        },
        {
          id: "facts",
          heading: "关键事实",
          purpose: "列出已核验事实、争议事实和仍需补充的信息",
          requiredSources: ["Matter 已核验事实材料"],
        },
        {
          id: "authorities",
          heading: "适用规则与权威",
          purpose: "逐项记录法律规则、效力层级、时效状态和精确出处",
          requiredSources: ["有效法律法规或司法解释", "可核验裁判或官方资料"],
        },
        {
          id: "analysis",
          heading: "分析",
          purpose: "把规则适用于事实，并呈现反方观点、例外与不确定性",
          requiredSources: ["前述事实与权威依据"],
        },
        {
          id: "conclusion",
          heading: "结论与后续步骤",
          purpose: "总结结论、风险和需要人工复核或补证的事项",
          requiredSources: [],
        },
      ],
    },
  }),
  template({
    id: "21000000-0000-4000-8000-000000000002",
    key: "legal_opinion",
    title: "法律意见书",
    description: "面向客户交付的范围、依据、意见与保留事项框架。",
    documentType: "legal_opinion",
    plan: {
      title: "法律意见书",
      documentType: "legal_opinion",
      sections: [
        {
          id: "scope",
          heading: "委托事项与意见范围",
          purpose: "界定委托、法域、基准日期和不在意见范围内的事项",
          requiredSources: ["委托说明"],
        },
        {
          id: "materials",
          heading: "审阅材料与假设",
          purpose: "列明已审阅材料、真实性假设及资料缺口",
          requiredSources: ["Matter 文件清单"],
        },
        {
          id: "opinion",
          heading: "法律意见",
          purpose: "按问题给出意见，并把每项意见连接到可核验依据",
          requiredSources: ["有效法律依据", "已核验事实材料"],
        },
        {
          id: "qualifications",
          heading: "限制与保留",
          purpose: "披露适用限制、例外、不确定性及需要专业复核的事项",
          requiredSources: [],
        },
        {
          id: "next_steps",
          heading: "建议措施",
          purpose: "给出可执行的补证、整改或交易步骤",
          requiredSources: [],
        },
      ],
    },
  }),
  template({
    id: "21000000-0000-4000-8000-000000000003",
    key: "contract_review_memo",
    title: "合同审查备忘录",
    description: "按交易背景、条款风险和修改建议组织合同审查。",
    documentType: "contract_review_memo",
    plan: {
      title: "合同审查备忘录",
      documentType: "contract_review_memo",
      sections: [
        {
          id: "context",
          heading: "交易背景与审查范围",
          purpose: "说明交易目标、当事方、审查版本及商业底线",
          requiredSources: ["合同审查版本", "业务需求说明"],
        },
        {
          id: "summary",
          heading: "执行摘要",
          purpose: "按严重程度概括关键风险和待决事项",
          requiredSources: [],
        },
        {
          id: "issues",
          heading: "条款问题清单",
          purpose: "逐项记录条款位置、风险、依据、建议文本和责任人",
          requiredSources: ["合同原文", "适用强制性规则"],
        },
        {
          id: "negotiation",
          heading: "谈判优先级",
          purpose: "区分必须修改、建议修改和可接受风险",
          requiredSources: [],
        },
        {
          id: "open_items",
          heading: "待补充信息",
          purpose: "列出影响结论的事实、附件、授权或审批缺口",
          requiredSources: [],
        },
      ],
    },
  }),
  template({
    id: "21000000-0000-4000-8000-000000000004",
    key: "due_diligence_report",
    title: "法律尽职调查报告",
    description: "以范围、发现、风险分级和整改建议组织尽调结论。",
    documentType: "due_diligence_report",
    plan: {
      title: "法律尽职调查报告",
      documentType: "due_diligence_report",
      sections: [
        {
          id: "scope",
          heading: "项目范围与方法",
          purpose: "说明交易、调查范围、截止日期、方法及限制",
          requiredSources: ["资料清单", "调查范围说明"],
        },
        {
          id: "executive_summary",
          heading: "重大事项摘要",
          purpose: "汇总可能影响交易的重大风险和先决条件",
          requiredSources: [],
        },
        {
          id: "findings",
          heading: "分类调查发现",
          purpose: "按主体、资产、合同、合规、争议等主题记录事实和证据",
          requiredSources: ["已核验尽调材料"],
        },
        {
          id: "risk_matrix",
          heading: "风险分级",
          purpose: "说明风险等级、影响、发生可能性和判断依据",
          requiredSources: [],
        },
        {
          id: "remediation",
          heading: "整改与交易保护",
          purpose: "提出补证、整改、陈述保证、赔偿或交割条件建议",
          requiredSources: [],
        },
      ],
    },
  }),
  template({
    id: "21000000-0000-4000-8000-000000000005",
    key: "litigation_strategy_memo",
    title: "争议解决策略备忘录",
    description: "围绕程序状态、请求权、证据、风险和行动方案制定策略。",
    documentType: "litigation_strategy_memo",
    plan: {
      title: "争议解决策略备忘录",
      documentType: "litigation_strategy_memo",
      sections: [
        {
          id: "posture",
          heading: "案件与程序状态",
          purpose: "记录当事方、请求、管辖、阶段、期限及已采取措施",
          requiredSources: ["程序文书", "案件时间线"],
        },
        {
          id: "issues",
          heading: "争点与请求权基础",
          purpose: "分解实体和程序争点并注明适用依据",
          requiredSources: ["有效法律依据"],
        },
        {
          id: "evidence",
          heading: "证据评估",
          purpose: "区分已掌握、待调取和存在真实性或关联性争议的证据",
          requiredSources: ["Matter 证据材料"],
        },
        {
          id: "scenarios",
          heading: "方案与风险情景",
          purpose: "比较诉讼、仲裁、和解等方案的收益、成本和不确定性",
          requiredSources: [],
        },
        {
          id: "actions",
          heading: "行动计划",
          purpose: "列明负责人、期限、依赖项及需要客户决策的节点",
          requiredSources: [],
        },
      ],
    },
  }),
  template({
    id: "21000000-0000-4000-8000-000000000006",
    key: "lawyer_letter",
    title: "律师函",
    description: "以已核验事实、法律立场、具体要求和期限形成对外函件初稿。",
    documentType: "lawyer_letter",
    plan: {
      title: "律师函",
      documentType: "lawyer_letter",
      sections: [
        {
          id: "addressee",
          heading: "收件人与事项",
          purpose: "准确记录收件主体、送达信息和函件事项",
          requiredSources: ["当事方身份与送达信息"],
        },
        {
          id: "facts",
          heading: "事实陈述",
          purpose: "仅陈述已有材料支持且与主张相关的事实",
          requiredSources: ["已核验事实材料"],
        },
        {
          id: "position",
          heading: "法律立场",
          purpose: "说明权利义务、违约或侵权判断及可核验依据",
          requiredSources: ["合同或其他权利基础", "有效法律依据"],
        },
        {
          id: "demands",
          heading: "具体要求与期限",
          purpose: "列明可执行要求、履行方式和合理期限",
          requiredSources: [],
        },
        {
          id: "reservation",
          heading: "权利保留",
          purpose: "使用克制准确的措辞保留权利并提示后续程序",
          requiredSources: [],
        },
      ],
    },
  }),
  template({
    id: "21000000-0000-4000-8000-000000000007",
    key: "contract_clause",
    title: "合同条款起草",
    description: "以商业目标、定义、义务、例外和执行机制组织单项合同条款。",
    documentType: "contract_clause",
    plan: {
      title: "合同条款起草",
      documentType: "contract_clause",
      sections: [
        {
          id: "objective",
          heading: "商业目标与适用场景",
          purpose: "说明条款要解决的问题、适用主体、触发条件和不可接受结果",
          requiredSources: ["业务需求说明", "合同上下文"],
        },
        {
          id: "definitions",
          heading: "关键定义",
          purpose: "定义必要术语并检查与合同其他条款的一致性",
          requiredSources: ["合同定义条款"],
        },
        {
          id: "clause",
          heading: "建议条款文本",
          purpose: "形成明确、可执行且不依赖未定义概念的条款初稿",
          requiredSources: ["适用强制性规则"],
        },
        {
          id: "alternatives",
          heading: "备选文本与谈判空间",
          purpose: "按风险承受程度提供有解释的备选表述",
          requiredSources: [],
        },
        {
          id: "notes",
          heading: "起草说明与待确认事项",
          purpose: "记录与其他条款的联动、事实假设和需业务确认的问题",
          requiredSources: [],
        },
      ],
    },
  }),
  template({
    id: "21000000-0000-4000-8000-000000000008",
    key: "general_legal_document",
    title: "通用法律文书",
    description: "适用于尚未归入专门类型的法律分析、说明或内部工作文稿。",
    documentType: "general_legal_document",
    plan: {
      title: "通用法律文书",
      documentType: "general_legal_document",
      sections: [
        {
          id: "purpose",
          heading: "目的与范围",
          purpose: "说明文书用途、读者、法域、基准日期和范围限制",
          requiredSources: [],
        },
        {
          id: "background",
          heading: "背景与已知事实",
          purpose: "区分已核验事实、当事方陈述和仍待确认的信息",
          requiredSources: ["Matter 已核验材料"],
        },
        {
          id: "analysis",
          heading: "分析与主要内容",
          purpose: "按主题展开内容，并为法律判断附上可核验依据",
          requiredSources: ["与主题相关的有效依据"],
        },
        {
          id: "risks",
          heading: "风险、限制与保留",
          purpose: "披露不确定性、相反观点、资料缺口和人工复核事项",
          requiredSources: [],
        },
        {
          id: "actions",
          heading: "结论与后续步骤",
          purpose: "总结结论并提出可执行的下一步",
          requiredSources: [],
        },
      ],
    },
  }),
] as const satisfies readonly BuiltinDocumentStudioTemplateV21[];
