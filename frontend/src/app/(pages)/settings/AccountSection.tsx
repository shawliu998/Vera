// Direct Vera port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/(pages)/account/AccountSection.tsx
import { cn } from "@/lib/utils";
import { accountGlassSectionClassName } from "./accountStyles";

export function AccountSection({
    children,
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement> & {
    children: React.ReactNode;
}) {
    return (
        <div className={cn(accountGlassSectionClassName, className)} {...props}>
            {children}
        </div>
    );
}
