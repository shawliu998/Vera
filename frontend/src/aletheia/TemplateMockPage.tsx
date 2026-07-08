import Link from "next/link";
import { ArrowLeft, CheckCircle2, ClipboardList, Layers3 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    complianceMatter,
    complianceObligations,
    dealMatter,
    dealRedFlags,
    templateById,
} from "./mockData";
import type { AletheiaTemplate } from "./types";

function riskClass(risk: "low" | "medium" | "high") {
    if (risk === "high") return "border-red-200 bg-red-50 text-red-700";
    if (risk === "medium") return "border-amber-200 bg-amber-50 text-amber-700";
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
}

export function TemplateMockPage({ templateId }: { templateId: AletheiaTemplate }) {
    const template = templateById(templateId);
    const isCompliance = templateId === "compliance_impact_review";
    const matter = isCompliance ? complianceMatter : dealMatter;

    return (
        <main className="min-h-dvh bg-[#ffffff] px-5 py-6 text-[#111827]">
            <div className="mx-auto max-w-6xl">
                <Link href="/aletheia" className="inline-flex items-center gap-2 text-sm text-[#6b7280] hover:text-[#111827]">
                    <ArrowLeft className="h-4 w-4" />
                    Back to Aletheia
                </Link>

                <section className="mt-5 rounded-lg border border-[#e5e7eb] bg-white p-6">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                        <div>
                            <div className="flex items-center gap-2">
                                <div className="flex h-9 w-9 items-center justify-center rounded-md bg-[#111827] text-white">
                                    <Layers3 className="h-4 w-4" />
                                </div>
                                <span className="text-sm font-semibold text-[#6b7280]">Aletheia 明证 Template</span>
                            </div>
                            <h1 className="mt-4 text-3xl font-semibold tracking-tight">{template.name}</h1>
                            <p className="mt-3 max-w-3xl text-base leading-7 text-[#6b7280]">{template.description}</p>
                        </div>
                        <Badge variant="outline" className="rounded-md border-[#e5e7eb] text-[#374151]">
                            mock workflow
                        </Badge>
                    </div>
                </section>

                <section className="mt-4 grid gap-4 lg:grid-cols-[320px_1fr]">
                    <aside className="space-y-4">
                        <div className="rounded-lg border border-[#e5e7eb] bg-white p-4">
                            <p className="text-xs font-semibold uppercase text-[#9ca3af]">Demo Matter</p>
                            <h2 className="mt-2 text-xl font-semibold">{matter.title}</h2>
                            <p className="mt-2 text-sm leading-6 text-[#6b7280]">{matter.objective}</p>
                            <Badge variant="outline" className={`mt-3 rounded-md ${riskClass(matter.riskLevel ?? "medium")}`}>
                                {matter.riskLevel} risk
                            </Badge>
                        </div>
                        <div className="rounded-lg border border-[#e5e7eb] bg-white p-4">
                            <p className="text-sm font-semibold">Workflow</p>
                            <div className="mt-3 space-y-3">
                                {template.workflow.map((step, index) => (
                                    <div key={step} className="flex gap-3">
                                        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#111827] text-xs text-white">
                                            {index + 1}
                                        </div>
                                        <p className="text-sm text-[#374151]">{step}</p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </aside>

                    <div className="space-y-4">
                        <div className="rounded-lg border border-[#e5e7eb] bg-white p-4">
                            <div className="flex items-center gap-2">
                                <ClipboardList className="h-4 w-4 text-[#111827]" />
                                <h2 className="font-semibold">
                                    {isCompliance ? "Obligation Register" : "Red Flag Dashboard"}
                                </h2>
                            </div>
                            <div className="mt-4 overflow-hidden rounded-md border border-[#e5e7eb]">
                                <table className="w-full text-left text-sm">
                                    <thead className="bg-[#f9fafb] text-xs uppercase text-[#9ca3af]">
                                        <tr>
                                            <th className="px-3 py-2">Item</th>
                                            <th className="px-3 py-2">Assessment</th>
                                            <th className="px-3 py-2">Owner / Action</th>
                                            <th className="px-3 py-2">Risk</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-[#e5e7eb]">
                                        {isCompliance
                                            ? complianceObligations.map((item) => (
                                                  <tr key={item.id}>
                                                      <td className="px-3 py-3 align-top font-medium">{item.obligation}</td>
                                                      <td className="px-3 py-3 align-top text-[#6b7280]">{item.gap}</td>
                                                      <td className="px-3 py-3 align-top text-[#6b7280]">{item.owner}: {item.remediation}</td>
                                                      <td className="px-3 py-3 align-top">
                                                          <Badge variant="outline" className={`rounded-md ${riskClass(item.riskLevel)}`}>
                                                              {item.riskLevel}
                                                          </Badge>
                                                      </td>
                                                  </tr>
                                              ))
                                            : dealRedFlags.map((item) => (
                                                  <tr key={item.id}>
                                                      <td className="px-3 py-3 align-top font-medium">{item.title}</td>
                                                      <td className="px-3 py-3 align-top text-[#6b7280]">{item.summary}</td>
                                                      <td className="px-3 py-3 align-top text-[#6b7280]">{item.recommendedAction}</td>
                                                      <td className="px-3 py-3 align-top">
                                                          <Badge variant="outline" className={`rounded-md ${riskClass(item.severity)}`}>
                                                              {item.severity}
                                                          </Badge>
                                                      </td>
                                                  </tr>
                                              ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        <div className="grid gap-4 md:grid-cols-2">
                            <div className="rounded-lg border border-[#e5e7eb] bg-white p-4">
                                <h2 className="font-semibold">Mock Work Product</h2>
                                <div className="mt-3 space-y-2">
                                    {template.outputs.map((output) => (
                                        <div key={output} className="flex items-center gap-2 rounded-md border border-[#e5e7eb] p-3 text-sm">
                                            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                                            {output}
                                        </div>
                                    ))}
                                </div>
                            </div>
                            <div className="rounded-lg border border-[#e5e7eb] bg-white p-4">
                                <h2 className="font-semibold">Next Implementation Step</h2>
                                <p className="mt-3 text-sm leading-6 text-[#6b7280]">
                                    This template currently uses deterministic sample output. The same Matter Workspace,
                                    evidence mapping, human review, and audit primitives can be connected to a real
                                    document registry and model provider.
                                </p>
                                <Button asChild className="mt-4 bg-[#111827] text-white hover:bg-[#1f2937]">
                                    <Link href="/aletheia/matters/matter-demo-legal-001">
                                        Open Complete Legal Demo
                                    </Link>
                                </Button>
                            </div>
                        </div>
                    </div>
                </section>
            </div>
        </main>
    );
}
