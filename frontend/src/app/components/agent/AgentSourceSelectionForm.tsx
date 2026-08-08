"use client";

import { useState } from "react";
import { ArrowUpRight, Loader2 } from "lucide-react";

import type { AgentSourceSelection } from "./agentSourceSelection";

export function AgentSourceSelectionForm({
  selection,
  submitting,
  error,
  onSubmit,
}: {
  selection: AgentSourceSelection;
  submitting: boolean;
  error: string | null;
  onSubmit: (discoveryRefs: string[]) => Promise<void>;
}) {
  const [selected, setSelected] = useState<string[]>([]);

  function toggle(discoveryRef: string) {
    setSelected((current) => {
      if (current.includes(discoveryRef)) {
        return current.filter((value) => value !== discoveryRef);
      }
      if (current.length >= selection.maximumSelections) return current;
      return [...current, discoveryRef];
    });
  }

  return (
    <form
      className="mt-3 border-y border-gray-900/[0.07] py-3"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(selected);
      }}
    >
      <fieldset disabled={submitting}>
        <legend className="text-xs font-medium text-gray-800">
          Select publications to import
        </legend>
        <p className="mt-1 text-xs leading-5 text-gray-500">
          Search results are not citable until you select and import them as
          fixed Matter source versions. Choose up to{" "}
          {selection.maximumSelections}.
        </p>
        <div className="mt-2 divide-y divide-gray-900/[0.07] border-y border-gray-900/[0.07]">
          {selection.discoveries.map((discovery) => {
            const checked = selected.includes(discovery.discoveryRef);
            const limitReached =
              !checked && selected.length >= selection.maximumSelections;
            return (
              <div
                key={discovery.discoveryRef}
                className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 py-3"
              >
                <input
                  id={`source-${discovery.discoveryRef}`}
                  type="checkbox"
                  checked={checked}
                  disabled={submitting || limitReached}
                  onChange={() => toggle(discovery.discoveryRef)}
                  className="mt-1 h-4 w-4 rounded border-gray-300 text-gray-950 outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70 focus-visible:ring-offset-2"
                />
                <div className="min-w-0">
                  <label
                    htmlFor={`source-${discovery.discoveryRef}`}
                    className="block cursor-pointer break-words text-sm font-medium leading-5 text-gray-900 [overflow-wrap:anywhere]"
                  >
                    {discovery.title}
                  </label>
                  <p className="mt-0.5 break-words text-xs leading-5 text-gray-500 [overflow-wrap:anywhere]">
                    {discovery.externalId}
                    {discovery.publishedOn
                      ? ` · Published ${discovery.publishedOn}`
                      : " · Publication date unavailable"}
                  </p>
                  <a
                    href={discovery.canonicalUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-gray-700 underline decoration-gray-300 underline-offset-2 outline-none hover:text-gray-950 focus-visible:ring-2 focus-visible:ring-blue-500/70 focus-visible:ring-offset-2"
                  >
                    Open publication source
                    <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      </fieldset>
      {error && (
        <p
          role="alert"
          className="mt-2 break-words text-xs leading-4 text-red-700 [overflow-wrap:anywhere]"
        >
          {error}
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-gray-500">
          {selected.length} of {selection.maximumSelections} selected
        </span>
        <button
          type="submit"
          disabled={submitting || selected.length === 0}
          className="inline-flex h-8 items-center gap-1.5 rounded-full bg-gray-950 px-3.5 text-xs font-medium text-white shadow-sm outline-none transition-colors hover:bg-black focus-visible:ring-2 focus-visible:ring-blue-500/70 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Import selected publications and continue
        </button>
      </div>
    </form>
  );
}
