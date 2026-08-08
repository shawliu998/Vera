export function documentSelectorExcludedProjectId(
    projectId: string | undefined,
    includeCurrentProject: boolean,
) {
    return includeCurrentProject ? undefined : projectId;
}
