import type { WorkspaceDatabaseAdapter } from "../../lib/workspace/migrations";
import {
  WorkspaceInferencePolicy,
  type InferencePolicyPort,
} from "../../lib/workspace/inferencePolicy";
import type { WorkspaceInferenceActivityScope } from "../../lib/workspace/jobs/types";
import { ProjectsRepository } from "../../lib/workspace/repositories/projects";
import {
  createMatterProfileV1Router,
  type MatterProfileV1Port,
  type MatterProfileV1RouterOptions,
} from "./router";
import { MatterOverviewRepository } from "./overviewRepository";
import { MatterProfileRepository } from "./repository";
import { MatterPolicyRepository } from "./policyRepository";
import {
  MatterCapabilityProjector,
  type MatterModelRuntimeCapabilityPort,
} from "./capabilities";
import {
  createProjectInferenceActivityPort,
  MatterProfileService,
  type MatterProfileServiceOptions,
} from "./service";

export { WORKSPACE_TYPES } from "./contracts";
export type { WorkspaceType } from "./contracts";
export type {
  MatterProfileV1Port,
  MatterProfileV1RouterOptions,
} from "./router";

/**
 * Bounded Matter Profile composition seam. The caller must inject the same
 * canonical ProjectsRepository instance used by the Workspace Project service;
 * this module never opens a database or reimplements Project persistence.
 */
export function createMatterProfileModule(
  database: WorkspaceDatabaseAdapter,
  projects: ProjectsRepository,
  options: MatterProfileServiceOptions & {
    activeInferenceScopes: () => readonly WorkspaceInferenceActivityScope[];
    inferencePolicy?: InferencePolicyPort;
    modelRuntimeCapabilities?: MatterModelRuntimeCapabilityPort;
  },
) {
  const profiles = new MatterProfileRepository(database);
  const policies = options.policyRepository ?? new MatterPolicyRepository(database);
  const inferencePolicy =
    options.inferencePolicy ?? new WorkspaceInferencePolicy(database);
  const overview = new MatterOverviewRepository(
    database,
    new MatterCapabilityProjector(
      inferencePolicy,
      options.modelRuntimeCapabilities ?? null,
    ),
  );
  const inferenceActivity = createProjectInferenceActivityPort(
    projects,
    options.activeInferenceScopes,
  );
  const service = new MatterProfileService(
    database,
    projects,
    profiles,
    overview,
    inferenceActivity,
    { ...options, policyRepository: policies },
  );
  const api: MatterProfileV1Port = Object.freeze({
    listMatters: service.listMatters.bind(service),
    createMatter: service.createMatter.bind(service),
    getMatter: service.getMatter.bind(service),
    updateMatter: service.updateMatter.bind(service),
    getMatterPolicy: service.getMatterPolicy.bind(service),
    replaceMatterPolicy: service.replaceMatterPolicy.bind(service),
    getProjectMatterProfile: service.getProjectMatterProfile.bind(service),
    createProjectMatterProfile:
      service.createProjectMatterProfile.bind(service),
    updateProjectMatterProfile:
      service.updateProjectMatterProfile.bind(service),
  });
  return Object.freeze({
    api,
    health: () => service.health(),
    createRouter: (routerOptions: MatterProfileV1RouterOptions = {}) =>
      createMatterProfileV1Router(api, routerOptions),
  });
}

export type MatterProfileModule = ReturnType<typeof createMatterProfileModule>;
