import { notFound } from "next/navigation";
import { TemplatePreviewPage } from "@/aletheia/TemplatePreviewPage";
import { templates } from "@/aletheia/mockData";
import type { AletheiaTemplate } from "@/aletheia/types";

export default async function MatterTemplatePage({
  params,
}: {
  params: Promise<{ template: string }>;
}) {
  const { template } = await params;
  const exists = templates.some((item) => item.id === template);
  if (!exists || template === "legal_matter_review") notFound();
  return <TemplatePreviewPage templateId={template as AletheiaTemplate} />;
}
