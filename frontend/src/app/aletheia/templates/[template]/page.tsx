import { notFound } from "next/navigation";
import { TemplateMockPage } from "@/aletheia/TemplateMockPage";
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
    return <TemplateMockPage templateId={template as AletheiaTemplate} />;
}
