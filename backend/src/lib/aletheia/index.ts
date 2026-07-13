import { LocalAletheiaRepository } from "./localRepository";
import type { AletheiaRepository } from "./repository";

export function createAletheiaRepository(): AletheiaRepository {
  return new LocalAletheiaRepository();
}

export type {
  AddReviewInput,
  AletheiaRepository,
  AletheiaUserContext,
  AppendAuditEventInput,
  CreateAgentRunInput,
  GlobalSearchInput,
  GlobalSearchKind,
  GlobalSearchResponse,
  GlobalSearchResult,
  CreateMatterInput,
  CreateWorkProductInput,
} from "./repository";
