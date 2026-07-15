"use client";

// UI structure ported from Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/assistant/ModelToggle.tsx
import { AlertCircle, Check, ChevronDown, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useVeraSettings } from "@/app/contexts/VeraSettingsContext";
import type { VeraModelProfile } from "@/app/lib/veraModelSettingsApi";
import { useI18n } from "@/app/i18n";

const PROVIDER_LABELS: Record<VeraModelProfile["provider"], string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google",
  deepseek: "DeepSeek",
  openai_compatible: "OpenAI-compatible",
};

interface Props {
  value: string;
  onChange: (profileId: string) => void;
}

export function ModelToggle({ value, onChange }: Props) {
  const { t } = useI18n();
  const { loadState, models } = useVeraSettings();
  const selectable = models.filter((profile) => profile.availability.selectable);
  const selected = selectable.find((profile) => profile.id === value) ?? null;
  const grouped = new Map<string, VeraModelProfile[]>();
  for (const profile of selectable) {
    const group = PROVIDER_LABELS[profile.provider];
    grouped.set(group, [...(grouped.get(group) ?? []), profile]);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={loadState === "loading" || selectable.length === 0}
          className="flex h-8 max-w-[200px] items-center gap-1.5 rounded-lg px-2 text-sm text-gray-400 transition-colors hover:bg-white/55 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-60"
          title={
            selectable.length === 0
              ? t("assistant.model.requireReady")
              : t("assistant.model.choose")
          }
        >
          {loadState === "loading" ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
          ) : selectable.length === 0 ? (
            <AlertCircle className="h-3 w-3 shrink-0 text-amber-500" />
          ) : null}
          <span className="truncate">
            {selected?.name ??
              (loadState === "loading"
                ? t("assistant.model.loading")
                : t("assistant.model.none"))}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="z-[150] w-64" side="top" align="end">
        {[...grouped.entries()].map(([provider, profiles], index) => (
          <div key={provider}>
            {index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-gray-400">
              {provider}
            </DropdownMenuLabel>
            {profiles.map((profile) => (
              <DropdownMenuItem
                key={profile.id}
                className="cursor-pointer"
                onSelect={() => onChange(profile.id)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{profile.name}</span>
                  <span className="block truncate text-[10px] text-gray-400">
                    {profile.model}
                  </span>
                </span>
                {profile.id === value && (
                  <Check className="ml-1 h-3.5 w-3.5 text-gray-600" />
                )}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
