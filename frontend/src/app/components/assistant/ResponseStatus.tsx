"use client";

// Vera-branded replacement for Mike's status glyph; layout follows
// frontend/src/app/components/assistant/message/ResponseStatus.tsx at Mike
// e32daad5a4c64a5561e04c53ee12411e3c5e7238.
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { VeraMark } from "@/app/components/vera-brand";

export function ResponseStatus({
  state,
}: {
  state: "active" | "complete" | "error" | null;
}) {
  return (
    <div className="mb-2 flex h-9 w-full items-center">
      {state === "error" ? (
        <AlertCircle className="h-[22px] w-[22px] text-red-500" />
      ) : state === "complete" ? (
        <CheckCircle2 className="h-[22px] w-[22px] text-emerald-600" />
      ) : (
        <span className={state === "active" ? "animate-spin" : undefined}>
          <VeraMark size={22} decorative />
        </span>
      )}
    </div>
  );
}
