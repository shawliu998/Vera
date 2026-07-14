// Activation boundary for the direct Vera port of Mike
// e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/(pages)/layout.tsx
import type { ReactNode } from "react";
import { VeraShell } from "@/app/components/vera-shell";

export default function VeraPagesLayout({ children }: { children: ReactNode }) {
    return <VeraShell>{children}</VeraShell>;
}
