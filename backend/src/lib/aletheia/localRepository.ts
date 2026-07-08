import type {
  AddReviewInput,
  AletheiaRepository,
  AletheiaUserContext,
  AppendAuditEventInput,
  CreateAgentRunInput,
  CreateMatterInput,
  CreateWorkProductInput,
} from "./repository";
import { LocalAdapterNotReadyError } from "./repository";

// Local-first storage will use an on-disk application directory such as:
// .data/aletheia/aletheia.db
// .data/aletheia/documents/
// .data/aletheia/exports/
// .data/aletheia/index/
//
// The class exists now so route/service code can target the repository
// contract instead of Supabase directly. It intentionally fails closed until
// the SQLite/filesystem implementation and auth adapter are wired.
export class LocalAletheiaRepository implements AletheiaRepository {
  listMatters(_ctx: AletheiaUserContext): Promise<unknown[]> {
    throw new LocalAdapterNotReadyError();
  }

  createMatter(
    _ctx: AletheiaUserContext,
    _input: CreateMatterInput,
  ): Promise<unknown> {
    throw new LocalAdapterNotReadyError();
  }

  getMatterDetail(
    _ctx: AletheiaUserContext,
    _matterId: string,
  ): Promise<unknown | null> {
    throw new LocalAdapterNotReadyError();
  }

  createWorkProduct(
    _ctx: AletheiaUserContext,
    _matterId: string,
    _input: CreateWorkProductInput,
  ): Promise<unknown | null> {
    throw new LocalAdapterNotReadyError();
  }

  addReview(
    _ctx: AletheiaUserContext,
    _matterId: string,
    _input: AddReviewInput,
  ): Promise<unknown | null> {
    throw new LocalAdapterNotReadyError();
  }

  appendAuditEvent(
    _ctx: AletheiaUserContext,
    _matterId: string,
    _input: AppendAuditEventInput,
  ): Promise<unknown | null> {
    throw new LocalAdapterNotReadyError();
  }

  createAgentRun(
    _ctx: AletheiaUserContext,
    _matterId: string,
    _input: CreateAgentRunInput,
  ): Promise<unknown | null> {
    throw new LocalAdapterNotReadyError();
  }
}
