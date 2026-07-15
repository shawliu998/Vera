"use client";

// Adapted from Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/(pages)/account/models/page.tsx::ModelPreferenceDropdown
import { useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { accountGlassInputClassName } from "@/app/(pages)/settings/accountStyles";

export interface SettingsDropdownOption<Value extends string> {
    value: Value;
    label: string;
    group?: string;
    description?: string;
    disabled?: boolean;
}

export function SettingsDropdown<Value extends string>({
    value,
    options,
    onChange,
    isSaving,
    placeholder,
    disabled,
    ariaLabel,
}: {
    value: Value | null;
    options: readonly SettingsDropdownOption<Value>[];
    onChange: (value: Value) => void;
    isSaving?: boolean;
    placeholder: string;
    disabled?: boolean;
    ariaLabel: string;
}) {
    const [isOpen, setIsOpen] = useState(false);
    const selected = options.find((option) => option.value === value);
    const groups = [...new Set(options.map((option) => option.group ?? ""))];

    return (
        <DropdownMenu onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label={ariaLabel}
                    disabled={disabled || isSaving}
                    className={`flex h-9 w-full items-center justify-between gap-2 px-3 text-sm hover:bg-white/78 dark:hover:bg-white/10 ${accountGlassInputClassName}`}
                >
                    <span className="min-w-0 truncate text-gray-900 dark:text-gray-100">
                        {selected?.label ?? placeholder}
                    </span>
                    {isSaving ? (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-gray-500" />
                    ) : (
                        <ChevronDown
                            className={`h-3.5 w-3.5 shrink-0 text-gray-500 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                        />
                    )}
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                className="z-50"
                style={{ width: "var(--radix-dropdown-menu-trigger-width)" }}
                align="start"
            >
                {groups.map((group, groupIndex) => {
                    const items = options.filter(
                        (option) => (option.group ?? "") === group,
                    );
                    return (
                        <div key={group || "default"}>
                            {groupIndex > 0 && <DropdownMenuSeparator />}
                            {group && (
                                <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-gray-400">
                                    {group}
                                </DropdownMenuLabel>
                            )}
                            {items.map((option) => (
                                <DropdownMenuItem
                                    key={option.value}
                                    className="cursor-pointer"
                                    disabled={option.disabled}
                                    onSelect={() => onChange(option.value)}
                                >
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate">
                                            {option.label}
                                        </span>
                                        {option.description && (
                                            <span className="block truncate text-[11px] text-gray-400">
                                                {option.description}
                                            </span>
                                        )}
                                    </span>
                                    {option.value === value && (
                                        <Check className="ml-1 h-3.5 w-3.5 text-gray-600" />
                                    )}
                                </DropdownMenuItem>
                            ))}
                        </div>
                    );
                })}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
