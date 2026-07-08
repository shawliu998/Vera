import { LocalAletheiaRepository } from "./localRepository";
import type { AletheiaRepository } from "./repository";
import { SupabaseAletheiaRepository } from "./supabaseRepository";

export function createAletheiaRepository(): AletheiaRepository {
  if (process.env.ALETHEIA_STORAGE_DRIVER === "local") {
    return new LocalAletheiaRepository();
  }
  return new SupabaseAletheiaRepository();
}

export type {
  AddReviewInput,
  AletheiaRepository,
  AletheiaUserContext,
  AppendAuditEventInput,
  CreateAgentRunInput,
  CreateMatterInput,
  CreateWorkProductInput,
} from "./repository";
