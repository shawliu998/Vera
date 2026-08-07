"use client";

import { useMemo, useState } from "react";
import { Check, Loader2 } from "lucide-react";

import { cn } from "@/app/lib/utils";
import type { Document } from "@/app/components/shared/types";
import type {
  AgentRequiredInput,
  AgentRequiredInputChoice,
} from "@/app/types/agent";
import {
  agentRequiredInputNeedsDocuments,
  buildAgentRequiredInputMessage,
} from "./agentRequiredInput";

export function AgentRequiredInputForm({
  requiredInput,
  documents,
  note,
  submitting,
  error,
  onNoteChange,
  onAttachDocuments,
  onSubmit,
}: {
  requiredInput: AgentRequiredInput;
  documents: Document[];
  note: string;
  submitting: boolean;
  error: string | null;
  onNoteChange: (value: string) => void;
  onAttachDocuments: () => void;
  onSubmit: (message: string) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({});
  const [otherValues, setOtherValues] = useState<Record<string, string>>({});

  const choices = requiredInput.items.filter(
    (item): item is AgentRequiredInputChoice => item.kind === "choice",
  );
  const documentRequests = requiredInput.items.filter(
    (item) => item.kind === "documents",
  );
  const requiredDocumentsMissing =
    agentRequiredInputNeedsDocuments(requiredInput) && documents.length === 0;
  const decisionsComplete = choices.every((item) => answers[item.id]?.trim());
  const submissionMessage = useMemo(
    () =>
      buildAgentRequiredInputMessage({
        requiredInput,
        answers,
        attachedDocumentCount: documents.length,
        note,
      }),
    [answers, documents.length, note, requiredInput],
  );
  const ready = decisionsComplete && !requiredDocumentsMissing;

  function choose(item: AgentRequiredInputChoice, answer: string) {
    setOtherOpen((current) => ({ ...current, [item.id]: false }));
    setAnswers((current) => ({ ...current, [item.id]: answer }));
  }

  function chooseOther(item: AgentRequiredInputChoice) {
    const value = otherValues[item.id] ?? "";
    setOtherOpen((current) => ({ ...current, [item.id]: true }));
    setAnswers((current) => ({ ...current, [item.id]: value }));
  }

  function updateOther(item: AgentRequiredInputChoice, value: string) {
    setOtherValues((current) => ({ ...current, [item.id]: value }));
    setAnswers((current) => ({ ...current, [item.id]: value }));
  }

  return (
    <form
      className="mt-3 border-y border-gray-900/[0.07] py-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (submissionMessage) void onSubmit(submissionMessage);
      }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold text-gray-950">
            Lawyer decisions
          </h3>
          <p className="mt-0.5 text-[11px] leading-4 text-gray-600">
            Choose each position. Vera will retry only the blocked step.
          </p>
        </div>
        {choices.length > 0 && (
          <span className="text-[10px] tabular-nums text-gray-500">
            {choices.filter((item) => answers[item.id]?.trim()).length} of{" "}
            {choices.length} answered
          </span>
        )}
      </div>

      <div className="mt-3 space-y-4">
        {choices.map((item, questionIndex) => (
          <fieldset key={item.id} disabled={submitting}>
            <legend className="max-w-[80ch] break-words text-xs font-medium leading-5 text-gray-900 [overflow-wrap:anywhere]">
              <span className="mr-1.5 text-gray-500">{questionIndex + 1}.</span>
              {item.question}
            </legend>
            <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
              {item.options.map((option, optionIndex) => {
                const selected =
                  !otherOpen[item.id] && answers[item.id] === option.value;
                return (
                  <label
                    key={`${item.id}-${optionIndex}`}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-start gap-2 rounded-lg px-3 py-2 text-xs leading-5 outline-none ring-1 transition-colors focus-within:ring-2 focus-within:ring-blue-500/70",
                      selected
                        ? "bg-gray-100 text-gray-950 ring-gray-900/[0.14]"
                        : "bg-white text-gray-700 ring-gray-900/[0.08] hover:bg-gray-50",
                      submitting && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <input
                      type="radio"
                      name={`required-input-${item.id}`}
                      value={option.value}
                      checked={selected}
                      onChange={() => choose(item, option.value)}
                      className="mt-1 h-3.5 w-3.5 shrink-0 accent-gray-950"
                    />
                    <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
                      {option.value}
                    </span>
                    {selected && (
                      <Check className="mt-1 h-3 w-3 shrink-0 text-gray-700" />
                    )}
                  </label>
                );
              })}
              {item.allow_other && (
                <label
                  className={cn(
                    "flex min-h-11 cursor-pointer items-start gap-2 rounded-lg bg-white px-3 py-2 text-xs text-gray-700 outline-none ring-1 ring-gray-900/[0.08] transition-colors hover:bg-gray-50 focus-within:ring-2 focus-within:ring-blue-500/70",
                    otherOpen[item.id] &&
                      "bg-gray-100 text-gray-950 ring-gray-900/[0.14]",
                    submitting && "cursor-not-allowed opacity-60",
                  )}
                >
                  <input
                    type="radio"
                    name={`required-input-${item.id}`}
                    checked={otherOpen[item.id] === true}
                    onChange={() => chooseOther(item)}
                    className="mt-1 h-3.5 w-3.5 shrink-0 accent-gray-950"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block leading-5">
                      {item.other_label || "Other"}
                    </span>
                    {otherOpen[item.id] && (
                      <textarea
                        autoFocus
                        rows={2}
                        maxLength={1000}
                        value={otherValues[item.id] ?? ""}
                        onChange={(event) =>
                          updateOther(item, event.target.value)
                        }
                        placeholder="Enter the lawyer direction…"
                        className="mt-1 w-full resize-y rounded-md bg-white px-2 py-1.5 text-xs leading-5 text-gray-950 outline-none ring-1 ring-gray-900/[0.1] placeholder:text-gray-500 focus:ring-2 focus:ring-blue-500/70"
                      />
                    )}
                  </span>
                </label>
              )}
            </div>
          </fieldset>
        ))}
      </div>

      {documentRequests.length > 0 && (
        <div className="mt-4 border-t border-gray-900/[0.06] pt-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-xs font-medium text-gray-900">
                {requiredDocumentsMissing
                  ? "Required Matter documents"
                  : "Supporting Matter documents"}
              </p>
              <p className="mt-0.5 max-w-[72ch] break-words text-[11px] leading-4 text-gray-600 [overflow-wrap:anywhere]">
                {documentRequests
                  .flatMap((item) => item.document_types)
                  .join(" · ")}
                {documentRequests.every((item) => item.required === false)
                  ? " · Optional — continue without guessing if unavailable."
                  : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={onAttachDocuments}
              disabled={submitting}
              className="inline-flex h-8 items-center rounded-full bg-white px-3.5 text-xs font-medium text-gray-700 shadow-sm outline-none transition-colors hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-500/70 focus-visible:ring-offset-2 disabled:opacity-45"
            >
              Attach documents
            </button>
          </div>
          {documents.length > 0 && (
            <div className="mt-2 flex min-w-0 flex-wrap gap-1.5">
              {documents.map((document) => (
                <span
                  key={document.id}
                  title={document.filename}
                  className="inline-flex h-6 max-w-full items-center rounded-md bg-gray-100 px-2 text-[11px] text-gray-700"
                >
                  <span className="max-w-[320px] truncate">
                    {document.filename}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <label
        htmlFor={`required-input-note-${requiredInput.request_id}`}
        className="mt-4 block text-xs font-medium text-gray-800"
      >
        Additional note{" "}
        <span className="font-normal text-gray-500">(optional)</span>
      </label>
      <textarea
        id={`required-input-note-${requiredInput.request_id}`}
        value={note}
        onChange={(event) => onNoteChange(event.target.value)}
        maxLength={2000}
        rows={2}
        disabled={submitting}
        placeholder="Add a bounded instruction that is not covered above…"
        className="mt-1.5 w-full resize-y rounded-lg bg-white px-3 py-2 text-sm leading-5 text-gray-950 outline-none ring-1 ring-gray-900/[0.1] placeholder:text-gray-600 focus:ring-2 focus:ring-blue-500/70 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500"
      />

      {error && (
        <p
          role="alert"
          className="mt-2 break-words text-xs leading-4 text-red-700 [overflow-wrap:anywhere]"
        >
          {error}
        </p>
      )}
      {ready && !submissionMessage && (
        <p role="alert" className="mt-2 text-xs leading-4 text-red-700">
          The combined decisions are too long. Shorten the Other response or
          additional note.
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={submitting || !submissionMessage}
          className="inline-flex h-8 items-center gap-1.5 rounded-full bg-gray-950 px-3.5 text-xs font-medium text-white shadow-sm outline-none transition-colors hover:bg-black focus-visible:ring-2 focus-visible:ring-blue-500/70 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Apply decisions and retry step
        </button>
        <span className="text-[10px] text-gray-500">
          Completed effects and fixed source versions are preserved.
        </span>
      </div>
    </form>
  );
}
