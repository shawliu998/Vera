import { UpdateWorkspaceSettingsRequestSchema } from "../contracts";
import { WorkspaceApiError } from "../errors";
import { ModelProfilesRepository } from "../repositories/modelProfiles";
import { ProjectsRepository } from "../repositories/projects";
import { SettingsRepository } from "../repositories/settings";

export type SettingsServiceOptions = {
  runtimeWired?: boolean;
};

export class SettingsService {
  private readonly runtimeWired: boolean;

  constructor(
    private readonly settings: SettingsRepository,
    private readonly projects: ProjectsRepository,
    private readonly profiles: ModelProfilesRepository,
    private readonly clock: () => Date = () => new Date(),
    options: SettingsServiceOptions = {},
  ) {
    this.runtimeWired = options.runtimeWired ?? false;
  }

  get() {
    return this.settings.get();
  }
  update(value: unknown) {
    const v = UpdateWorkspaceSettingsRequestSchema.parse(value);
    if (
      v.defaultModelProfileId !== undefined &&
      v.defaultModelProfileId !== null
    ) {
      if (!this.runtimeWired) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Workspace default model selection is unavailable until model runtime wiring is completed.",
        );
      }
    }
    return this.settings.update({ ...v, now: this.clock().toISOString() });
  }
}
