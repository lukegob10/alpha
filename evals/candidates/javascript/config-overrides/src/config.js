export function resolveConfig(defaults, workspace, commandLine) {
	return { ...commandLine, ...workspace, ...defaults }
}
