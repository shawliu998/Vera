"use client";

import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/app/i18n";

type ConfirmStatus = "idle" | "loading" | "complete";

interface ConfirmPopupProps {
    open: boolean;
    title?: ReactNode;
    message?: ReactNode;
    confirmLabel?: ReactNode;
    confirmStatus?: ConfirmStatus;
    cancelLabel?: ReactNode;
    cancelDisabled?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
    confirmDisabled?: boolean;
    className?: string;
}

export function ConfirmPopup({
    open,
    title,
    message,
    confirmLabel,
    confirmStatus = "idle",
    cancelLabel,
    cancelDisabled = false,
    onConfirm,
    onCancel,
    confirmDisabled = false,
    className,
}: ConfirmPopupProps) {
    const { t } = useI18n();
    if (!open) return null;
    const resolvedConfirmText = confirmLabel ?? t("common.actions.confirm");
    const resolvedCancelLabel = cancelLabel ?? t("common.actions.cancel");
    const confirmBusy = confirmStatus === "loading";
    const resolvedConfirmDisabled = confirmDisabled || confirmStatus !== "idle";
    const normalizedConfirmLabel =
        typeof resolvedConfirmText === "string"
            ? resolvedConfirmText
            : t("common.actions.confirm");
    const isDeleteAction =
        normalizedConfirmLabel === t("common.actions.delete") ||
        normalizedConfirmLabel.toLowerCase() === "delete";
    const resolvedConfirmLabel =
        confirmStatus === "loading" ? (
            <span className="inline-flex h-full items-center gap-1.5">
                <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                {resolvedConfirmText}
            </span>
        ) : confirmStatus === "complete" ? (
            resolvedConfirmText
        ) : isDeleteAction ? (
            <span className="inline-flex h-full items-center gap-1.5">
                <Trash2 className="h-3 w-3 shrink-0" />
                {resolvedConfirmText}
            </span>
        ) : (
            resolvedConfirmText
        );

    return createPortal(
        <div className="pointer-events-none fixed inset-x-0 bottom-5 z-[230] flex justify-center px-4">
            <div
                className={cn(
                    "pointer-events-auto w-[min(92vw,520px)] rounded-2xl border border-white/70 bg-white px-4 py-3 text-sm shadow-[0_4px_14px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.92)] backdrop-blur-2xl",
                    className,
                )}
            >
                {title && (
                    <div className="text-sm font-medium text-gray-950 mb-3">
                        {title}
                    </div>
                )}
                {message && (
                    <div
                        className={cn("text-xs text-gray-700", title && "mt-1")}
                    >
                        {message}
                    </div>
                )}
                <div className="mt-3 flex items-center justify-end gap-2">
                    <button
                        type="button"
                        onClick={onCancel}
                        disabled={cancelDisabled}
                        className="px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:text-gray-950 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-gray-700"
                    >
                        {resolvedCancelLabel}
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        disabled={resolvedConfirmDisabled}
                        className={cn(
                            "inline-flex h-7 items-center justify-center rounded-full px-3.5 text-xs font-medium leading-none text-white backdrop-blur-xl transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100",
                            isDeleteAction
                                ? "border border-red-700/35 bg-red-600/90 shadow-[0_3px_9px_rgba(127,29,29,0.16),inset_0_1px_0_rgba(255,255,255,0.22),inset_0_-4px_9px_rgba(127,29,29,0.18)] hover:bg-red-600"
                                : "border border-gray-700/40 bg-gray-950/88 shadow-[0_3px_9px_rgba(15,23,42,0.16),inset_0_1px_0_rgba(255,255,255,0.22),inset_0_-4px_9px_rgba(15,23,42,0.2)] hover:bg-gray-900/90",
                        )}
                        aria-busy={confirmBusy}
                    >
                        {resolvedConfirmLabel}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
