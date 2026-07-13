"use client";

import { useCallback, useState } from "react";
import { fetchAletheiaMatterDocumentOriginal } from "@/app/lib/aletheiaApi";

export type OriginalDocumentAccessStatus =
  | "idle"
  | "busy"
  | "canceled"
  | "saved"
  | "opened"
  | "open_failed"
  | "access_failed";

export const originalDocumentAccessMessage: Record<
  OriginalDocumentAccessStatus,
  string
> = {
  idle: "",
  busy: "Checking integrity and preparing the original...",
  canceled: "Save canceled. No comparison was recorded.",
  saved: "Original saved. Open it from Downloads. No comparison was recorded.",
  opened: "Original saved and opened. No comparison was recorded.",
  open_failed:
    "Original saved, but the external viewer did not open. No comparison was recorded.",
  access_failed:
    "Original unavailable. Access or integrity checks failed; no comparison was recorded.",
};

function safeSuggestedName(value: string) {
  const safe = value
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180);
  return safe || "original-evidence";
}

async function sha256Hex(blob: Blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function fetchVerifiedAletheiaOriginal(
  matterId: string,
  documentId: string,
) {
  const download = await fetchAletheiaMatterDocumentOriginal(
    matterId,
    documentId,
  );
  if (
    download.blob.size !== download.size ||
    (await sha256Hex(download.blob)) !== download.sha256
  ) {
    throw new Error("original_integrity_check_failed");
  }
  return download;
}

async function browserDownload(
  matterId: string,
  documentId: string,
  suggestedName: string,
) {
  const download = await fetchVerifiedAletheiaOriginal(matterId, documentId);

  const objectUrl = URL.createObjectURL(download.blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = safeSuggestedName(suggestedName);
    anchor.rel = "noopener";
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  }
}

export function useOriginalDocumentAccess() {
  const [status, setStatus] = useState<OriginalDocumentAccessStatus>("idle");

  const saveAndOpen = useCallback(
    async (input: {
      matterId: string;
      documentId: string;
      suggestedName: string;
    }) => {
      if (status === "busy") return;
      setStatus("busy");
      try {
        const desktop = window.aletheiaDesktop?.saveOriginalMatterDocument;
        if (desktop) {
          const result = await desktop({
            ...input,
            suggestedName: safeSuggestedName(input.suggestedName),
            openAfterSave: true,
          });
          if (result.canceled) {
            setStatus("canceled");
          } else if (!result.saved) {
            setStatus("access_failed");
          } else if (result.opened) {
            setStatus("opened");
          } else if (result.openError) {
            setStatus("open_failed");
          } else {
            setStatus("saved");
          }
          return;
        }

        await browserDownload(
          input.matterId,
          input.documentId,
          input.suggestedName,
        );
        setStatus("saved");
      } catch {
        setStatus("access_failed");
      }
    },
    [status],
  );

  return {
    status,
    message: originalDocumentAccessMessage[status],
    saveAndOpen,
  };
}
