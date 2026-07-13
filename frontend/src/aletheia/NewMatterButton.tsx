"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    createAletheiaMatter,
    type AletheiaRiskLevel,
} from "@/app/lib/aletheiaApi";
import { emitAletheiaNotification } from "./AletheiaNotificationCenter";

const riskLevels: { value: AletheiaRiskLevel; label: string }[] = [
    { value: "high", label: "高" },
    { value: "medium", label: "中" },
    { value: "low", label: "低" },
];

const representationRoles = [
    "原告",
    "被告",
    "第三人",
    "申请人",
    "被申请人",
    "其他",
] as const;

const procedureStages = [
    "立案前",
    "立案审查",
    "一审",
    "二审",
    "再审",
    "执行",
    "其他",
] as const;

const fieldClassName =
    "h-10 w-full rounded-md border border-gray-200 bg-[#f7f8fa] px-3 text-sm font-normal outline-none transition-colors focus:border-gray-400 focus:bg-white";
const labelClassName = "grid min-w-0 gap-1.5 text-sm font-medium text-gray-800";

export function NewMatterButton({ initialOpen = false }: { initialOpen?: boolean }) {
    const router = useRouter();
    const [open, setOpen] = useState(initialOpen);
    const [title, setTitle] = useState("");
    const [objective, setObjective] = useState("");
    const [clientOrProject, setClientOrProject] = useState("");
    const [representationRole, setRepresentationRole] = useState("");
    const [opposingParties, setOpposingParties] = useState("");
    const [court, setCourt] = useState("");
    const [caseNumber, setCaseNumber] = useState("");
    const [procedureStage, setProcedureStage] = useState("");
    const [intakeDate, setIntakeDate] = useState("");
    const [riskLevel, setRiskLevel] = useState<AletheiaRiskLevel>("medium");
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const required = [
            [title, "案件名称"],
            [objective, "办案目标"],
            [clientOrProject, "客户/委托人"],
            [representationRole, "我方诉讼地位"],
            [procedureStage, "程序阶段"],
            [intakeDate, "收案日期"],
        ] as const;
        const missing = required.filter(([value]) => !value.trim()).map(([, label]) => label);
        if (missing.length > 0) {
            setError(`请填写：${missing.join("、")}`);
            return;
        }

        setError("");
        setSaving(true);
        try {
            const matter = await createAletheiaMatter({
                title: title.trim(),
                objective: objective.trim(),
                template: "civil_litigation",
                riskLevel,
                clientOrProject: clientOrProject.trim(),
                status: "draft",
                metadata: {
                    representationRole,
                    opposingParties: opposingParties.trim() || null,
                    court: court.trim() || null,
                    caseNumber: caseNumber.trim() || null,
                    procedureStage,
                    intakeDate,
                },
            });
            setOpen(false);
            emitAletheiaNotification({
                title: "案件已创建",
                body: `${title.trim()}已进入案件工作台。`,
                tag: "matter-created",
            });
            router.push(`/aletheia/matters/${matter.id}/litigation?view=overview`);
        } catch (reason) {
            setError(
                `创建失败：${reason instanceof Error ? reason.message : "本地服务未完成创建，请稍后重试。"}`,
            );
        } finally {
            setSaving(false);
        }
    }

    return (
        <>
            <Button
                onClick={() => setOpen(true)}
                className="h-9 rounded-md bg-gray-950 px-4 text-sm font-medium text-white shadow-none hover:bg-gray-800"
            >
                <Plus className="h-3.5 w-3.5" />
                新建案件
            </Button>

            {open && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/20 px-3 py-4 sm:px-4">
                    <form
                        onSubmit={submit}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="new-matter-title"
                        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-[0_18px_60px_rgba(15,23,42,0.18)]"
                    >
                        <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-5 py-4 sm:px-6 sm:py-5">
                            <div className="min-w-0">
                                <div className="text-xs font-medium text-gray-500">民商事诉讼</div>
                                <h2
                                    id="new-matter-title"
                                    className="mt-1 text-[22px] font-semibold leading-7 text-gray-950"
                                >
                                    新建案件
                                </h2>
                                <p className="mt-1 text-xs leading-5 text-gray-500">
                                    先记录接案所需信息，创建后进入统一案件工作台。
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setOpen(false)}
                                className="shrink-0 rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                                aria-label="关闭新建案件"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>

                        <div className="grid gap-4 overflow-y-auto px-5 py-5 sm:px-6">
                            <div className="grid gap-4 sm:grid-cols-2">
                                <label className={labelClassName}>
                                    案件名称 <span className="sr-only">必填</span>
                                    <input
                                        value={title}
                                        onChange={(event) => setTitle(event.target.value)}
                                        className={fieldClassName}
                                        autoFocus
                                    />
                                </label>
                                <div className={labelClassName}>
                                    案件类型
                                    <div className="flex h-10 items-center border-b border-gray-200 px-1 text-sm font-normal text-gray-700">
                                        民商事诉讼
                                    </div>
                                </div>
                            </div>

                            <label className={labelClassName}>
                                办案目标 <span className="sr-only">必填</span>
                                <textarea
                                    value={objective}
                                    onChange={(event) => setObjective(event.target.value)}
                                    className="min-h-20 w-full resize-y rounded-md border border-gray-200 bg-[#f7f8fa] px-3 py-2 text-sm font-normal outline-none transition-colors focus:border-gray-400 focus:bg-white"
                                />
                            </label>

                            <div className="grid gap-4 sm:grid-cols-2">
                                <label className={labelClassName}>
                                    客户/委托人 <span className="sr-only">必填</span>
                                    <input
                                        value={clientOrProject}
                                        onChange={(event) => setClientOrProject(event.target.value)}
                                        className={fieldClassName}
                                    />
                                </label>
                                <label className={labelClassName}>
                                    我方诉讼地位 <span className="sr-only">必填</span>
                                    <select
                                        value={representationRole}
                                        onChange={(event) => setRepresentationRole(event.target.value)}
                                        className={fieldClassName}
                                    >
                                        <option value="">请选择</option>
                                        {representationRoles.map((role) => (
                                            <option key={role} value={role}>{role}</option>
                                        ))}
                                    </select>
                                </label>
                            </div>

                            <div className="grid gap-4 sm:grid-cols-2">
                                <label className={labelClassName}>
                                    对方当事人 <span className="text-xs font-normal text-gray-400">选填</span>
                                    <input
                                        value={opposingParties}
                                        onChange={(event) => setOpposingParties(event.target.value)}
                                        className={fieldClassName}
                                    />
                                </label>
                                <label className={labelClassName}>
                                    受理法院 <span className="text-xs font-normal text-gray-400">选填</span>
                                    <input
                                        value={court}
                                        onChange={(event) => setCourt(event.target.value)}
                                        className={fieldClassName}
                                    />
                                </label>
                            </div>

                            <div className="grid gap-4 sm:grid-cols-2">
                                <label className={labelClassName}>
                                    案号 <span className="text-xs font-normal text-gray-400">选填</span>
                                    <input
                                        value={caseNumber}
                                        onChange={(event) => setCaseNumber(event.target.value)}
                                        placeholder="尚未立案可留空"
                                        className={fieldClassName}
                                    />
                                </label>
                                <label className={labelClassName}>
                                    程序阶段 <span className="sr-only">必填</span>
                                    <select
                                        value={procedureStage}
                                        onChange={(event) => setProcedureStage(event.target.value)}
                                        className={fieldClassName}
                                    >
                                        <option value="">请选择</option>
                                        {procedureStages.map((stage) => (
                                            <option key={stage} value={stage}>{stage}</option>
                                        ))}
                                    </select>
                                </label>
                            </div>

                            <div className="grid gap-4 sm:grid-cols-2">
                                <label className={labelClassName}>
                                    收案日期 <span className="sr-only">必填</span>
                                    <input
                                        type="date"
                                        value={intakeDate}
                                        onChange={(event) => setIntakeDate(event.target.value)}
                                        className={fieldClassName}
                                    />
                                </label>
                                <label className={labelClassName}>
                                    风险等级
                                    <select
                                        value={riskLevel}
                                        onChange={(event) => setRiskLevel(event.target.value as AletheiaRiskLevel)}
                                        className={fieldClassName}
                                    >
                                        {riskLevels.map((item) => (
                                            <option key={item.value} value={item.value}>{item.label}</option>
                                        ))}
                                    </select>
                                </label>
                            </div>
                        </div>

                        {error && (
                            <p role="alert" className="mx-5 border-l-2 border-red-600 bg-red-50 px-3 py-2 text-sm text-red-700 sm:mx-6">
                                {error}
                            </p>
                        )}

                        <div className="mt-4 flex shrink-0 justify-end gap-2 border-t border-gray-100 px-5 py-4 sm:px-6">
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => setOpen(false)}
                                className="rounded-md border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100"
                            >
                                取消
                            </Button>
                            <Button
                                type="submit"
                                disabled={saving}
                                className="rounded-md bg-gray-950 px-5 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
                            >
                                {saving ? "创建中..." : "创建案件"}
                            </Button>
                        </div>
                    </form>
                </div>
            )}
        </>
    );
}
