import Link from "next/link";
import { ArrowLeft, BookOpen, FileText, Workflow } from "lucide-react";

const docs = [
    {
        title: "Product Thesis",
        file: "docs/product_thesis.md",
        description:
            "Why high-risk professional services need an agent workspace instead of a chatbot.",
        icon: BookOpen,
    },
    {
        title: "Architecture",
        file: "docs/architecture.md",
        description:
            "Workspace, agent workflow, document, trust, governance, and feedback layers.",
        icon: Workflow,
    },
    {
        title: "Demo Script",
        file: "docs/demo_script.md",
        description: "A 90-second walkthrough for the Legal Matter Review demo.",
        icon: FileText,
    },
];

export default function AletheiaDocsPage() {
    return (
        <main className="min-h-dvh bg-[#ffffff] px-5 py-6 text-[#111827]">
            <div className="mx-auto max-w-5xl">
                <Link href="/aletheia" className="inline-flex items-center gap-2 text-sm text-[#6b7280] hover:text-[#111827]">
                    <ArrowLeft className="h-4 w-4" />
                    Back to Aletheia
                </Link>
                <section className="mt-5 rounded-lg border border-[#e5e7eb] bg-white p-6">
                    <h1 className="text-3xl font-semibold tracking-tight">Aletheia 明证 Product Notes</h1>
                    <p className="mt-3 max-w-3xl text-base leading-7 text-[#6b7280]">
                        These files live in the repository under `docs/` and explain the product thesis,
                        architecture, workflow templates, attribution, and demo script.
                    </p>
                    <div className="mt-6 grid gap-4 md:grid-cols-3">
                        {docs.map((doc) => (
                            <div key={doc.title} className="rounded-lg border border-[#e5e7eb] p-4">
                                <doc.icon className="h-5 w-5 text-[#111827]" />
                                <h2 className="mt-3 font-semibold">{doc.title}</h2>
                                <p className="mt-2 text-sm leading-6 text-[#6b7280]">{doc.description}</p>
                                <p className="mt-3 rounded-md bg-[#f9fafb] px-3 py-2 font-mono text-xs text-[#6b7280]">
                                    {doc.file}
                                </p>
                            </div>
                        ))}
                    </div>
                </section>
            </div>
        </main>
    );
}
