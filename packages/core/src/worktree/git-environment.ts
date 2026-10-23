const GIT_REPOSITORY_ENV = new Set([
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_CEILING_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_CONFIG",
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_PARAMETERS",
	"GIT_DIR",
	"GIT_DISCOVERY_ACROSS_FILESYSTEM",
	"GIT_GRAFT_FILE",
	"GIT_IMPLICIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_NAMESPACE",
	"GIT_NO_REPLACE_OBJECTS",
	"GIT_OBJECT_DIRECTORY",
	"GIT_PREFIX",
	"GIT_REFERENCE_BACKEND",
	"GIT_REPLACE_REF_BASE",
	"GIT_SHALLOW_FILE",
	"GIT_WORK_TREE",
])

/** Keep host Git wrappers from selecting another repository for service-owned operations. */
export function createWorktreeGitEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {}
	// Keep user identity, credentials and config files; only owned overrides may select repository state.
	for (const [name, value] of Object.entries(process.env)) {
		const key = name.toUpperCase()
		if (!GIT_REPOSITORY_ENV.has(key) && !/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) {
			environment[name] = value
		}
	}
	return { ...environment, ...overrides }
}
