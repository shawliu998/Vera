"use client";

import Script from "next/script";
import { useEffect, useMemo, useState } from "react";
import { ClipboardCheck, RefreshCw } from "lucide-react";
import {
  addAletheiaReview,
  appendAletheiaAuditEvent,
  createAletheiaWorkProduct,
  getAletheiaMatter,
  listAletheiaMatters,
  type AletheiaMatterDetail,
  type AletheiaMatterOverview,
} from "@/app/lib/aletheiaApi";
import {
  validateAnduParityContracts,
  type WordAddinHandoffArtifact,
} from "@/aletheia/agentops";
import { Button } from "@/components/ui/button";

type OfficeSelectionResult = { status: string; value?: unknown; error?: { message?: string } };
type OfficeApi = {
  onReady: () => Promise<unknown>;
  context: {
    document: {
      getSelectedDataAsync: (
        coercionType: string,
        callback: (result: OfficeSelectionResult) => void,
      ) => void;
    };
  };
};

declare global {
  interface Window {
    Office?: OfficeApi;
  }
}

const EMPTY_DOCUMENTS: AletheiaMatterDetail["documents"] = [];

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function readOfficeSelection(office: OfficeApi) {
  return new Promise<string>((resolve, reject) => {
    office.context.document.getSelectedDataAsync("text", (result) => {
      if (result.status === "succeeded") return resolve(String(result.value ?? "").trim());
      reject(new Error(result.error?.message || "Word could not read the current selection."));
    });
  });
}

export default function WordAddinPage() {
  const [officeReady, setOfficeReady] = useState(false);
  const [matters, setMatters] = useState<AletheiaMatterOverview[]>([]);
  const [matterId, setMatterId] = useState("");
  const [detail, setDetail] = useState<AletheiaMatterDetail | null>(null);
  const [documentId, setDocumentId] = useState("");
  const [selectedText, setSelectedText] = useState("");
  const [suggestedEdit, setSuggestedEdit] = useState("");
  const [message, setMessage] = useState("Loading Hermes matters...");
  const [saving, setSaving] = useState(false);

  const documents = detail?.documents ?? EMPTY_DOCUMENTS;
  const selectedDocument = useMemo(
    () => documents.find((document) => document.id === documentId) ?? documents[0],
    [documentId, documents],
  );

  useEffect(() => {
    listAletheiaMatters()
      .then((items) => {
        setMatters(items);
        setMatterId(items[0]?.id ?? "");
        setMessage(items.length ? "Choose a matter document, then capture the Word selection." : "Create a Hermes matter before using this add-in.");
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : "Hermes matters could not be loaded."));
  }, []);

  useEffect(() => {
    if (!matterId) return;
    getAletheiaMatter(matterId)
      .then((nextDetail) => {
        setDetail(nextDetail);
        setDocumentId(nextDetail.documents[0]?.id ?? "");
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : "The matter could not be loaded."));
  }, [matterId]);

  async function captureSelection() {
    setMessage("");
    const office = window.Office;
    if (!officeReady || !office) {
      setMessage("Word is not ready. Open this page from the Hermes Word add-in manifest.");
      return;
    }
    try {
      const selection = await readOfficeSelection(office);
      if (!selection) throw new Error("Select text in Word before capturing it.");
      setSelectedText(selection.slice(0, 8000));
      setMessage("Selected Word text captured. Add a suggested edit for review.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Word selection could not be captured.");
    }
  }

  async function recordHandoff() {
    const selected = selectedText.trim();
    const suggestion = suggestedEdit.trim();
    if (!matterId || !selectedDocument || !selected || !suggestion) {
      setMessage("A matter document, Word selection, and suggested edit are required.");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      const selectedTextHash = await sha256(selected);
      const requestAudit = await appendAletheiaAuditEvent(matterId, {
        actor: "human",
        action: "human_note.word_addin_handoff_requested",
        workflowVersion: "hermes-word-addin-officejs-v1",
        details: {
          documentId: selectedDocument.id,
          documentName: selectedDocument.name,
          selectedTextHash,
          operation: "tracked_change",
          wordClientApplied: false,
          officeRuntime: "Office.js",
        },
      });
      const workpaper = await createAletheiaWorkProduct(matterId, {
        kind: "word_addin_handoff",
        title: `Word edit handoff: ${selectedDocument.name}`,
        status: "needs_review",
        schemaVersion: "hermes-word-addin-officejs-v1",
        generatedBy: "human",
        content: {
          documentId: selectedDocument.id,
          documentName: selectedDocument.name,
          selectedText: selected,
          selectedTextHash,
          suggestedEdit: suggestion,
          operation: "tracked_change",
          wordClientApplied: false,
          officeRuntime: "Office.js",
          requestAuditEventId: requestAudit.id,
          professionalCaveat: "Office.js captured selected text only. Hermes has not written a Word edit or applied a tracked change.",
        },
      });
      const review = await addAletheiaReview(matterId, {
        targetType: "work_product",
        targetId: workpaper.id,
        workProductId: workpaper.id,
        tag: "needs_human_judgment",
        comment: "Review the Word selection, document context, and suggested edit before any human applies a tracked change in Word.",
      });
      const handoff: WordAddinHandoffArtifact = {
        id: `word-handoff:${workpaper.id}`,
        matter_id: matterId,
        document_id: selectedDocument.id,
        operation: "tracked_change",
        status: "needs_review",
        selected_text_hash: selectedTextHash,
        tracked_change_ids: [],
        source_refs: [{ id: selectedDocument.id, type: "matter_document", hash: selectedTextHash, audit_event_id: requestAudit.id }],
        review_comment_ids: [review.id],
        audit_event_ids: [requestAudit.id],
      };
      const validation = validateAnduParityContracts({ wordAddinHandoffs: [handoff] });
      if (validation.some((item) => item.status === "failed")) throw new Error("Word handoff provenance validation failed before persistence.");
      await appendAletheiaAuditEvent(matterId, {
        actor: "human",
        action: "human_note.word_addin_handoff_persisted",
        workflowVersion: "hermes-word-addin-officejs-v1",
        details: { workpaperId: workpaper.id, reviewCommentId: review.id, requestAuditEventId: requestAudit.id, handoff, validation, wordClientApplied: false, officeRuntime: "Office.js" },
      });
      setSelectedText("");
      setSuggestedEdit("");
      setMessage(`Review-only Word handoff recorded (${workpaper.id}).`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Word handoff could not be recorded.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="min-h-screen bg-white p-4 text-gray-950">
      <Script src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js" strategy="afterInteractive" onLoad={() => window.Office?.onReady().then(() => setOfficeReady(true)).catch(() => setMessage("Office.js could not initialize."))} />
      <div className="mx-auto grid max-w-xl gap-4">
        <header className="border-b border-gray-200 pb-3"><h1 className="text-lg font-semibold">Hermes Word Review</h1><p className="mt-1 text-sm text-gray-600">Selection capture and reviewable edit handoff.</p></header>
        <label className="grid gap-1 text-xs font-medium text-gray-700">Matter<select value={matterId} onChange={(event) => setMatterId(event.target.value)} className="h-9 rounded-md border border-gray-200 bg-white px-2 text-sm">{matters.map((matter) => <option key={matter.id} value={matter.id}>{matter.title}</option>)}</select></label>
        <label className="grid gap-1 text-xs font-medium text-gray-700">Matter document<select value={selectedDocument?.id ?? ""} onChange={(event) => setDocumentId(event.target.value)} className="h-9 rounded-md border border-gray-200 bg-white px-2 text-sm">{documents.map((document) => <option key={document.id} value={document.id}>{document.name}</option>)}</select></label>
        <div className="grid gap-2"><Button type="button" variant="outline" disabled={!officeReady} onClick={() => void captureSelection()}><ClipboardCheck className="h-4 w-4" />Capture current Word selection</Button><textarea value={selectedText} readOnly rows={4} placeholder="Captured selection appears here." className="resize-y rounded-md border border-gray-200 px-3 py-2 text-sm" /></div>
        <label className="grid gap-1 text-xs font-medium text-gray-700">Suggested tracked edit<textarea value={suggestedEdit} onChange={(event) => setSuggestedEdit(event.target.value)} rows={4} maxLength={8000} className="resize-y rounded-md border border-gray-200 px-3 py-2 text-sm" /></label>
        <div className="flex flex-wrap items-center gap-2"><Button type="button" disabled={saving || !selectedDocument} onClick={() => void recordHandoff()}><RefreshCw className="h-4 w-4" />Record for review</Button>{message ? <span className="text-xs text-gray-600">{message}</span> : null}</div>
      </div>
    </main>
  );
}
