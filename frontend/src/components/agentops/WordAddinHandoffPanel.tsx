"use client";

import { useMemo, useState } from "react";
import { FilePenLine } from "lucide-react";
import {
  addAletheiaReview,
  approveAletheiaWordAddinHandoff,
  appendAletheiaAuditEvent,
  createAletheiaWorkProduct,
  resolveAletheiaReview,
  type AletheiaMatterDetail,
} from "@/app/lib/aletheiaApi";
import {
  validateAnduParityContracts,
  type WordAddinHandoffArtifact,
} from "@/aletheia/agentops";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

async function sha256(value: string) {
  if (!globalThis.crypto?.subtle) throw new Error("This browser cannot create the selected-text hash.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

type HandoffAuditDetails = {
  workpaperId?: string;
  handoff?: WordAddinHandoffArtifact;
};

export function WordAddinHandoffPanel({ matterId, detail, onPersisted }: {
  matterId: string;
  detail: AletheiaMatterDetail;
  onPersisted: () => Promise<void>;
}) {
  const [documentId, setDocumentId] = useState("");
  const [selectedText, setSelectedText] = useState("");
  const [suggestedEdit, setSuggestedEdit] = useState("");
  const [saving, setSaving] = useState(false);
  const [actingHandoffId, setActingHandoffId] = useState("");
  const [message, setMessage] = useState("");
  const selectedDocumentId = documentId || detail.documents[0]?.id || "";
  const persisted = useMemo(() => {
    const audits = new Map<string, HandoffAuditDetails>();
    for (const event of detail.auditEvents) {
      if (event.action !== "human_note.word_addin_handoff_persisted") continue;
      const details = event.details as HandoffAuditDetails;
      if (details.workpaperId) audits.set(details.workpaperId, details);
    }
    return detail.workProducts.filter((item) => item.kind === "word_addin_handoff").map((workProduct) => ({
      workProduct,
      audit: audits.get(workProduct.id),
      reviews: detail.reviews.filter((review) => review.work_product_id === workProduct.id),
    }));
  }, [detail.auditEvents, detail.reviews, detail.workProducts]);

  async function recordHandoff() {
    const selected = selectedText.trim();
    const suggestion = suggestedEdit.trim();
    const document = detail.documents.find((item) => item.id === selectedDocumentId);
    setMessage("");
    if (!document || !selected || !suggestion) {
      setMessage("A matter document, selected text, and suggested edit are required.");
      return;
    }
    setSaving(true);
    try {
      const selectedTextHash = await sha256(selected);
      const requestedAudit = await appendAletheiaAuditEvent(matterId, {
        actor: "human",
        action: "human_note.word_addin_handoff_requested",
        workflowVersion: "hermes-word-addin-handoff-v0",
        details: { documentId: document.id, documentName: document.name, selectedTextHash, operation: "tracked_change", wordClientApplied: false },
      });
      const workpaper = await createAletheiaWorkProduct(matterId, {
        kind: "word_addin_handoff",
        title: `Word edit handoff: ${document.name}`,
        status: "needs_review",
        schemaVersion: "hermes-word-addin-handoff-v0",
        generatedBy: "human",
        content: { documentId: document.id, documentName: document.name, selectedText: selected, selectedTextHash, suggestedEdit: suggestion, operation: "tracked_change", wordClientApplied: false, requestAuditEventId: requestedAudit.id, professionalCaveat: "This is a review-only Word handoff. No document mutation or tracked change has been applied by Hermes." },
      });
      const review = await addAletheiaReview(matterId, {
        targetType: "work_product", targetId: workpaper.id, workProductId: workpaper.id,
        tag: "needs_human_judgment",
        comment: "Review the selected text, suggested edit, document context, and tracked-change scope before any Word client applies the edit.",
      });
      const handoff: WordAddinHandoffArtifact = {
        id: `word-handoff:${workpaper.id}`, matter_id: matterId, document_id: document.id,
        operation: "tracked_change", status: "needs_review", selected_text_hash: selectedTextHash,
        tracked_change_ids: [],
        source_refs: [{ id: document.id, type: "matter_document", hash: selectedTextHash, audit_event_id: requestedAudit.id }],
        review_comment_ids: [review.id], audit_event_ids: [requestedAudit.id],
      };
      const validation = validateAnduParityContracts({ wordAddinHandoffs: [handoff] });
      if (validation.some((item) => item.status === "failed")) throw new Error("Word handoff provenance validation failed before persistence.");
      await appendAletheiaAuditEvent(matterId, { actor: "human", action: "human_note.word_addin_handoff_persisted", workflowVersion: "hermes-word-addin-handoff-v0", details: { workpaperId: workpaper.id, reviewCommentId: review.id, requestAuditEventId: requestedAudit.id, handoff, validation, wordClientApplied: false } });
      setSelectedText(""); setSuggestedEdit(""); await onPersisted(); setMessage(`Word Add-in handoff recorded (${workpaper.id}).`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Word Add-in handoff could not be recorded.");
    } finally { setSaving(false); }
  }

  async function acceptHandoffReview(reviewId: string) {
    setMessage(""); setActingHandoffId(reviewId);
    try {
      await resolveAletheiaReview(matterId, reviewId, { status: "accepted", comment: "Reviewer accepted the Word handoff selection and tracked-edit scope.", createEvalCase: false });
      await onPersisted(); setMessage("Word Add-in handoff review accepted. Approval can proceed when all reviews are resolved.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Word Add-in handoff review could not be accepted."); }
    finally { setActingHandoffId(""); }
  }

  async function approveHandoff(handoffId: string) {
    setMessage(""); setActingHandoffId(handoffId);
    try {
      await approveAletheiaWordAddinHandoff(matterId, handoffId);
      await onPersisted(); setMessage("Word Add-in handoff approved. No Word mutation was applied.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Word Add-in handoff could not be approved."); }
    finally { setActingHandoffId(""); }
  }

  return <section data-testid="word-addin-handoff-panel" className="rounded-lg border border-gray-200 bg-white p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><FilePenLine className="h-4 w-4 text-gray-700" /><h2 className="font-semibold text-gray-950">Word Add-in Handoff</h2></div><p className="mt-1 text-sm text-gray-600">Review-only selected-text handoff. Hermes does not apply Word edits or tracked changes directly.</p></div><Badge variant="outline" className="rounded-md border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-600">{persisted.length} recorded</Badge></div><div className="mt-4 grid gap-3"><label className="grid gap-1.5 text-xs font-medium text-gray-700">Matter document<select data-testid="word-handoff-document" value={selectedDocumentId} onChange={(event) => setDocumentId(event.target.value)} className="h-9 rounded-md border border-gray-200 bg-white px-3 text-sm font-normal text-gray-900 outline-none focus:border-gray-400">{detail.documents.map((document) => <option key={document.id} value={document.id}>{document.name}</option>)}</select></label><label className="grid gap-1.5 text-xs font-medium text-gray-700">Selected text<textarea data-testid="word-handoff-selected-text" value={selectedText} onChange={(event) => setSelectedText(event.target.value)} rows={3} maxLength={8000} className="resize-y rounded-md border border-gray-200 px-3 py-2 text-sm font-normal text-gray-900 outline-none focus:border-gray-400" /></label><label className="grid gap-1.5 text-xs font-medium text-gray-700">Suggested tracked edit<textarea data-testid="word-handoff-suggested-edit" value={suggestedEdit} onChange={(event) => setSuggestedEdit(event.target.value)} rows={3} maxLength={8000} className="resize-y rounded-md border border-gray-200 px-3 py-2 text-sm font-normal text-gray-900 outline-none focus:border-gray-400" /></label></div><div className="mt-4 flex flex-wrap items-center gap-3"><Button type="button" size="sm" data-testid="record-word-addin-handoff" disabled={saving || detail.documents.length === 0} onClick={() => void recordHandoff()}><FilePenLine className="h-4 w-4" />Record handoff</Button>{message ? <span data-testid="word-handoff-status" className="text-xs text-gray-600">{message}</span> : null}</div>{persisted.length ? <div className="mt-5 grid gap-2 border-t border-gray-100 pt-4">{persisted.map(({ workProduct, audit, reviews }) => { const openReviews = reviews.filter((review) => review.resolution_status === "open"); const accepted = workProduct.status === "accepted"; return <div key={workProduct.id} data-testid="word-handoff-record" className="rounded-md border border-gray-100 bg-gray-50 p-3"><div className="flex justify-between gap-2"><div><p className="text-sm font-medium text-gray-950">{workProduct.title}</p><p className="mt-1 text-xs text-gray-500">{reviews.length} review item{reviews.length === 1 ? "" : "s"} · no Word mutation applied</p></div><Badge variant="outline" className={accepted ? "rounded-md border-emerald-100 bg-emerald-50 px-2 py-1 text-xs text-emerald-700" : "rounded-md border-amber-100 bg-amber-50 px-2 py-1 text-xs text-amber-700"}>{workProduct.status.replaceAll("_", " ")}</Badge></div><p className="mt-2 text-xs text-gray-600">{audit?.handoff?.operation ?? "tracked_change"} · {audit?.handoff?.document_id ?? "document retained"}</p>{!accepted ? <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-gray-200 pt-3">{openReviews.map((review) => <Button key={review.id} type="button" size="sm" variant="outline" data-testid={`accept-word-handoff-review-${review.id}`} disabled={Boolean(actingHandoffId)} onClick={() => void acceptHandoffReview(review.id)}>Accept review</Button>)}<Button type="button" size="sm" data-testid={`approve-word-handoff-${workProduct.id}`} disabled={Boolean(actingHandoffId) || openReviews.length > 0} onClick={() => void approveHandoff(workProduct.id)}>Approve handoff</Button></div> : null}</div>; })}</div> : null}</section>;
}
