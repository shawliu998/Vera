const EXTERNAL_AUDIT_ACTION_PATTERNS = {
  agent: /^agent_note(?:\.[a-z0-9][a-z0-9._-]{0,95})?$/,
  human: /^human_note(?:\.[a-z0-9][a-z0-9._-]{0,95})?$/,
} as const;

export type ExternalAuditActor = keyof typeof EXTERNAL_AUDIT_ACTION_PATTERNS;

/**
 * Public audit append surfaces are notes only. Domain/security lifecycle events
 * must be emitted by the backend method that actually performed the action.
 */
export function isAllowedExternalAuditAction(
  actor: ExternalAuditActor,
  action: string,
) {
  return EXTERNAL_AUDIT_ACTION_PATTERNS[actor].test(action);
}

export function externalAuditActionHelp(actor: ExternalAuditActor) {
  return `Public ${actor} audit events must use the ${actor}_note or ${actor}_note.<name> namespace`;
}
