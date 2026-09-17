export function resolveConfig(defaults, file, env, cli) {
	return { ...cli, ...env, ...file, ...defaults }
}
