/*
 * Compatibility import surface only. The one authoritative implementation is
 * WorkspaceInferencePolicy in the Workspace layer; Matter must not grow a
 * parallel policy evaluator or provider wrapper here.
 */
export {
  assertInferenceAllowed,
  ExecutionLocationSchema,
  INFERENCE_POLICY_APPROVAL_MESSAGE,
  INFERENCE_POLICY_DENIED_MESSAGE,
  InferenceOperationSchema,
  ModelProfilePrivacyRepository,
  ModelRetentionSchema,
  ModelTrainingUseSchema,
  WorkspaceInferencePolicy,
} from "../lib/workspace/inferencePolicy";
export type {
  ExecutionLocation,
  InferenceDecision,
  InferenceOperation,
  InferencePolicyEnforcementPort,
  InferencePolicyInput,
  InferencePolicyPort,
  InferenceScope,
  ModelProfilePrivacy,
  ModelRetention,
  ModelTrainingUse,
} from "../lib/workspace/inferencePolicy";
