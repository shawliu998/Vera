"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { useI18n, type BackendErrorDescriptor } from "@/app/i18n";
import { toVeraSettingsFailure } from "@/app/contexts/VeraSettingsContext";
import { accountGlassInputClassName } from "@/app/(pages)/settings/accountStyles";
import {
  submitVeraCredentialInput,
  VERA_CREDENTIAL_MAX_BYTES,
  VeraCredentialInputError,
} from "./modelCredentialSubmission";

export function ModelCredentialForm({
  profileId,
  disabled,
  onStore,
}: {
  profileId: string;
  disabled: boolean;
  onStore: (secret: string) => Promise<void>;
}) {
  const { t, errorMessage } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<BackendErrorDescriptor | null>(null);
  const inputId = `vera-model-credential-${profileId}`;

  useEffect(() => {
    if (disabled && inputRef.current) inputRef.current.value = "";
  }, [disabled]);

  useEffect(
    () => () => {
      if (inputRef.current) inputRef.current.value = "";
    },
    [],
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || submitting) return;
    const field = inputRef.current;
    if (!field) return;
    setSubmitting(true);
    setFailure(null);
    try {
      await submitVeraCredentialInput(field, onStore);
    } catch (error) {
      setFailure(
        error instanceof VeraCredentialInputError
          ? { code: "VALIDATION_ERROR" }
          : toVeraSettingsFailure(error),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3">
      <div>
        <label
          htmlFor={inputId}
          className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-200"
        >
          {t("settings.models.credential.apiKey")}
        </label>
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
            <input
              ref={inputRef}
              id={inputId}
              type="password"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={VERA_CREDENTIAL_MAX_BYTES}
              disabled={disabled || submitting}
              className={`${accountGlassInputClassName} h-9 w-full pl-9 text-sm`}
              placeholder={t("settings.models.credential.placeholder")}
            />
          </div>
          <button
            type="submit"
            disabled={disabled || submitting}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 hover:text-gray-950 disabled:cursor-not-allowed disabled:opacity-45 dark:text-gray-300 dark:hover:bg-white/10 dark:hover:text-white"
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t("settings.models.credential.store")}
          </button>
        </div>
        <p className="mt-2 text-xs text-gray-400">
          {t("settings.models.credential.description")}
        </p>
      </div>
      {failure && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {errorMessage(failure)}
        </p>
      )}
    </form>
  );
}
