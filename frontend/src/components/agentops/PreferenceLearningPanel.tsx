"use client";

import { useMemo, useState } from "react";
import { BrainCircuit } from "lucide-react";
import {
  addAletheiaMatterMemory,
  addAletheiaReview,
  approveAletheiaPreferenceLearningCandidate,
  appendAletheiaAuditEvent,
  resolveAletheiaReview,
  type AletheiaMatterDetail,
} from "@/app/lib/aletheiaApi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type PreferenceProposalAuditDetails = {
  memoryItemId?: string;
  reviewCommentId?: string;
};

export function PreferenceLearningPanel({ matterId, detail, onPersisted }: {
  matterId: string;
  detail: AletheiaMatterDetail;
  onPersisted: () => Promise<void>;
}) {
  const [proposal, setProposal] = useState("");
  const [optIn, setOptIn] = useState(false);
  const [revocable, setRevocable] = useState(true);
  const [saving, setSaving] = useState(false);
  const [actingProposalId, setActingProposalId] = useState("");
  const [message, setMessage] = useState("");
  const proposals = useMemo(() => {
    const auditByMemoryId = new Map<string, PreferenceProposalAuditDetails>();
    for (const event of detail.auditEvents) {
      if (event.action !== "human_note.preference_learning_proposal_recorded") continue;
      const audit = event.details as PreferenceProposalAuditDetails;
      if (audit.memoryItemId) auditByMemoryId.set(audit.memoryItemId, audit);
    }
    return (detail.matterMemory ?? [])
      .filter((item) => item.category === "output_preference" && item.metadata.preferenceLearningProposal === true)
      .map((memory) => {
        const audit = auditByMemoryId.get(memory.id);
        return {
          memory,
          audit,
          review: audit?.reviewCommentId
            ? detail.reviews.find((item) => item.id === audit.reviewCommentId)
            : undefined,
        };
      });
  }, [detail.auditEvents, detail.matterMemory, detail.reviews]);

  async function recordProposal() {
    const body = proposal.trim();
    setMessage("");
    if (!optIn || !revocable || !body) {
      setMessage("A proposal, explicit opt-in, and revocable scope are required.");
      return;
    }
    setSaving(true);
    try {
      const memory = await addAletheiaMatterMemory(matterId, {
        category: "output_preference",
        title: "Matter-scoped preference proposal",
        body,
        source: "human",
        metadata: { preferenceLearningProposal: true, scopeType: "matter", scopeId: matterId, optIn: true, revocable: true, status: "candidate", autoApply: false },
      });
      const review = await addAletheiaReview(matterId, {
        targetType: "matter", targetId: matterId, tag: "needs_human_judgment",
        comment: `Review preference proposal ${memory.id} before any playbook or output behavior changes.`,
      });
      await appendAletheiaAuditEvent(matterId, {
        actor: "human", action: "human_note.preference_learning_proposal_recorded",
        workflowVersion: "hermes-preference-learning-v0",
        details: { memoryItemId: memory.id, reviewCommentId: review.id, scopeType: "matter", scopeId: matterId, optIn: true, revocable: true, status: "candidate", autoApply: false },
      });
      setProposal(""); setOptIn(false); await onPersisted(); setMessage(`Preference proposal recorded (${memory.id}).`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Preference proposal could not be recorded."); }
    finally { setSaving(false); }
  }

  async function acceptProposalReview(memoryItemId: string, reviewId: string) {
    setActingProposalId(memoryItemId); setMessage("");
    try {
      await resolveAletheiaReview(matterId, reviewId, {
        status: "accepted",
        comment: "Reviewer accepted this matter-scoped, revocable preference for playbook mapping.",
        createEvalCase: false,
      });
      await onPersisted();
      setMessage("Preference review accepted. You can now approve its matter playbook mapping.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Preference review could not be accepted."); }
    finally { setActingProposalId(""); }
  }

  async function approveProposal(memoryItemId: string) {
    setActingProposalId(memoryItemId); setMessage("");
    try {
      await approveAletheiaPreferenceLearningCandidate(matterId, memoryItemId);
      await onPersisted();
      setMessage("Preference mapped to an approved matter playbook. Automatic application remains disabled.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Preference playbook mapping could not be approved."); }
    finally { setActingProposalId(""); }
  }

  return <section data-testid="preference-learning-panel" className="rounded-lg border border-gray-200 bg-white p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><BrainCircuit className="h-4 w-4 text-gray-700" /><h2 className="font-semibold text-gray-950">Preference Learning</h2></div><p className="mt-1 text-sm text-gray-600">Matter-scoped proposals are inspectable and revocable. They never auto-change playbooks or other matters.</p></div><Badge variant="outline" className="rounded-md border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-600">{proposals.length} proposal{proposals.length === 1 ? "" : "s"}</Badge></div><label className="mt-4 grid gap-1.5 text-xs font-medium text-gray-700">Proposed preference<textarea data-testid="preference-learning-proposal" value={proposal} onChange={(event) => setProposal(event.target.value)} rows={4} maxLength={4000} className="resize-y rounded-md border border-gray-200 px-3 py-2 text-sm font-normal text-gray-900 outline-none focus:border-gray-400" /></label><label className="mt-3 flex gap-2 text-sm text-gray-700"><input data-testid="preference-learning-opt-in" type="checkbox" checked={optIn} onChange={(event) => setOptIn(event.target.checked)} className="mt-0.5 h-4 w-4" />I opt in to this matter-scoped preference proposal.</label><label className="mt-2 flex gap-2 text-sm text-gray-700"><input data-testid="preference-learning-revocable" type="checkbox" checked={revocable} onChange={(event) => setRevocable(event.target.checked)} className="mt-0.5 h-4 w-4" />This proposal remains revocable.</label><div className="mt-4 flex flex-wrap items-center gap-3"><Button type="button" size="sm" data-testid="record-preference-learning-proposal" disabled={saving} onClick={() => void recordProposal()}><BrainCircuit className="h-4 w-4" />Record proposal</Button>{message ? <span data-testid="preference-learning-status" className="text-xs text-gray-600">{message}</span> : null}</div>{proposals.length ? <div className="mt-5 grid gap-2 border-t border-gray-100 pt-4">{proposals.map(({ memory, review }) => { const approved = memory.metadata.status === "approved"; const reviewOpen = review?.resolution_status === "open"; return <div key={memory.id} data-testid="preference-learning-record" className="rounded-md border border-gray-100 bg-gray-50 p-3"><p className="text-sm text-gray-900">{memory.body}</p><p className="mt-1 text-xs text-gray-500">matter scope · {approved ? "approved playbook mapping" : "candidate"} · revocable · no automatic application</p>{!approved ? <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-gray-200 pt-3">{reviewOpen && review ? <Button type="button" size="sm" variant="outline" data-testid={`accept-preference-review-${review.id}`} disabled={Boolean(actingProposalId)} onClick={() => void acceptProposalReview(memory.id, review.id)}>Accept review</Button> : null}<Button type="button" size="sm" data-testid={`approve-preference-candidate-${memory.id}`} disabled={Boolean(actingProposalId) || review?.resolution_status !== "accepted"} onClick={() => void approveProposal(memory.id)}>Approve mapping</Button></div> : null}</div>; })}</div> : null}</section>;
}
