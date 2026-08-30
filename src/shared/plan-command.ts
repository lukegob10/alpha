export type PlanCommandCategory = "inspection" | "verification"

export type PlanCommandDecision = { allowed: true; category: PlanCommandCategory } | { allowed: false; reason: string }

const MAX_PLAN_COMMAND_LENGTH = 4_096

// Plan commands are deliberately a small, single-process subset. Reject shell
// composition and expansion before command-specific classification; user
// approval and auto-approval settings cannot widen this policy boundary.
const UNSAFE_SHELL_SYNTAX = /[\\\0\r\n;&|<>`$%!^#*?()[\]{}~]/
const UNSAFE_ARGUMENTS = new Set([
	"--allow-write",
	"--basetemp",
	"--cache",
	"--cache-clear",
	"--cache-dir",
	"--cache-directory",
	"--cache-file",
	"--cache-location",
	"--clean",
	"--composite",
	"--config",
	"--config-precedence",
	"--coverage",
	"--coverage-directory",
	"--cov",
	"--cov-report",
	"--create",
	"--delete",
	"--declaration-dir",
	"--declarationdir",
	"--environment",
	"--emitdeclarationonly",
	"--fix",
	"--force",
	"--format",
	"--generate-trace",
	"--generatetrace",
	"--global",
	"--global-setup",
	"--global-teardown",
	"--globalsetup",
	"--globalteardown",
	"--import",
	"--incremental",
	"--init",
	"--install",
	"--interactive",
	"--junit-xml",
	"--junitxml",
	"--loader",
	"--manifest-path",
	"--module-name-mapper",
	"--modulenamemapper",
	"--open",
	"--output",
	"--output-dir",
	"--output-file",
	"--output-path",
	"--outdir",
	"--outputfile",
	"--override-ini",
	"--parser",
	"--parser-options",
	"--plugin",
	"--plugin-search-dir",
	"--plugins",
	"--pool",
	"--project",
	"--coverprofile",
	"--resolve-plugins-relative-to",
	"--resolver",
	"--reporter",
	"--reporters",
	"--rule",
	"--rules",
	"--remove",
	"--root",
	"--rootdir",
	"--rulesdir",
	"--runner",
	"--save",
	"--serve",
	"--setup-files",
	"--setup-files-after-env",
	"--setupfiles",
	"--setupfilesafterenv",
	"--snapshot-update",
	"--snapshot-resolver",
	"--snapshotresolver",
	"--test-environment",
	"--test-environment-options",
	"--test-results-processor",
	"--test-runner",
	"--testenvironment",
	"--testenvironmentoptions",
	"--testresultsprocessor",
	"--testrunner",
	"--target-dir",
	"--toolexec",
	"--transform",
	"--transform-ignore-patterns",
	"--tsbuildinfofile",
	"--ui",
	"--update",
	"--update-snapshots",
	"--updatesnapshot",
	"--watch",
	"--watch-all",
	"--watchall",
	"--watch-plugins",
	"--write",
	"-i",
	"-args",
	"-b",
	"-c",
	"-exec",
	"-f",
	"-modfile",
	"-o",
	"-overlay",
	"-p",
	"-toolexec",
	"-u",
	"-vettool",
	"-w",
	"-workfile",
])

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"cat-file",
	"describe",
	"diff",
	"grep",
	"log",
	"ls-files",
	"ls-tree",
	"name-rev",
	"rev-parse",
	"shortlog",
	"show",
	"status",
])

const UNSAFE_GIT_ARGUMENTS = new Set(["--ext-diff", "--filters", "--open-files-in-pager", "--output", "--textconv"])

function tokenizeSingleCommand(command: string): string[] | undefined {
	const tokens: string[] = []
	let token = ""
	let quote: '"' | "'" | undefined
	let tokenStarted = false

	for (let index = 0; index < command.length; index++) {
		const character = command[index]
		if (quote) {
			if (character === quote) {
				quote = undefined
			} else {
				token += character
			}
			tokenStarted = true
			continue
		}

		if (character === '"' || character === "'") {
			// Escaped quotes have shell-specific semantics; fail closed instead of
			// trying to reproduce the user's active shell parser.
			if (index > 0 && command[index - 1] === "\\") return undefined
			quote = character
			tokenStarted = true
			continue
		}

		if (/\s/.test(character)) {
			if (tokenStarted) {
				tokens.push(token)
				token = ""
				tokenStarted = false
			}
			continue
		}

		token += character
		tokenStarted = true
	}

	if (quote) return undefined
	if (tokenStarted) tokens.push(token)
	return tokens
}

function normalizedExecutable(token: string): string | undefined {
	if (!token || token.includes("/") || token.includes("\\") || token.includes(":")) return undefined
	return token.toLowerCase().replace(/\.(?:cmd|exe)$/i, "")
}

function normalizedFlag(token: string): string {
	return token.toLowerCase().split("=", 1)[0]
}

function hasUnsafeArgument(tokens: readonly string[]): boolean {
	return tokens.some((token) => {
		if (token === "--") return true
		const flag = normalizedFlag(token)
		return UNSAFE_ARGUMENTS.has(flag) || /^-[ciouwp].+/.test(flag) || hasEscapingPath(token)
	})
}

function hasEscapingPath(token: string): boolean {
	const candidate = token.includes("=") ? token.slice(token.indexOf("=") + 1) : token
	const normalized = candidate.replace(/\\/g, "/")
	return (
		normalized.startsWith("/") ||
		/^[a-z]:\//i.test(normalized) ||
		normalized === ".." ||
		normalized.startsWith("../") ||
		normalized.includes("/../") ||
		normalized.startsWith("@")
	)
}

/** Plan command working directories must remain lexically inside the workspace. */
export function isPlanCommandCwdAllowed(cwd: unknown): boolean {
	if (cwd === undefined || cwd === null || cwd === "" || cwd === ".") return true
	if (typeof cwd !== "string" || cwd.includes("\0") || cwd.includes("~")) return false
	return !hasEscapingPath(cwd)
}

function classifyGit(tokens: readonly string[]): PlanCommandDecision {
	if (tokens[1]?.toLowerCase() !== "--no-pager") {
		return { allowed: false, reason: "git inspection requires --no-pager to suppress configured pager helpers" }
	}
	const subcommand = tokens[2]?.toLowerCase()
	if (!subcommand || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
		return { allowed: false, reason: "git subcommand is not in the Plan read-only allow-list" }
	}
	const args = tokens.slice(3)
	if (args.some((token) => UNSAFE_GIT_ARGUMENTS.has(normalizedFlag(token)))) {
		return { allowed: false, reason: "git option may write output or execute a configured helper" }
	}
	if (
		["diff", "log", "show"].includes(subcommand) &&
		(!args.includes("--no-ext-diff") || !args.includes("--no-textconv"))
	) {
		return {
			allowed: false,
			reason: `git ${subcommand} requires --no-ext-diff and --no-textconv to suppress configured helpers`,
		}
	}
	return { allowed: true, category: "inspection" }
}

function classifyVerificationExecutable(executable: string, args: readonly string[]): PlanCommandDecision {
	if (hasUnsafeArgument(args)) {
		return { allowed: false, reason: "verification option can write, watch, or update repository state" }
	}

	switch (executable) {
		case "tsc":
			return args.some((arg) => arg.toLowerCase() === "--noemit")
				? { allowed: true, category: "verification" }
				: { allowed: false, reason: "TypeScript verification requires --noEmit" }
		case "vitest":
			return args[0]?.toLowerCase() === "run"
				? { allowed: true, category: "verification" }
				: { allowed: false, reason: "Vitest verification requires the non-watching run subcommand" }
		case "jest":
		case "eslint":
		case "pytest":
			return { allowed: true, category: "verification" }
		case "prettier":
			return args.some((arg) => arg.toLowerCase() === "--check")
				? { allowed: true, category: "verification" }
				: { allowed: false, reason: "Prettier verification requires --check" }
		case "go":
			return ["test", "vet"].includes(args[0]?.toLowerCase() ?? "")
				? { allowed: true, category: "verification" }
				: { allowed: false, reason: "only go test and go vet are available in Plan" }
		case "cargo":
			return ["check", "clippy", "test"].includes(args[0]?.toLowerCase() ?? "")
				? { allowed: true, category: "verification" }
				: { allowed: false, reason: "only cargo check, clippy, and test are available in Plan" }
		case "python":
		case "python3":
			return args[0] === "-m" && args[1]?.toLowerCase() === "pytest"
				? { allowed: true, category: "verification" }
				: { allowed: false, reason: "Python is available only as python -m pytest in Plan" }
		default:
			return { allowed: false, reason: "command is not in the Plan verification allow-list" }
	}
}

function classifyPnpm(args: readonly string[]): PlanCommandDecision {
	let index = 0
	while (index < args.length && args[index].toLowerCase() === "--dir") {
		if (!args[index + 1] || args[index + 1].startsWith("-")) {
			return { allowed: false, reason: "pnpm working-directory option requires a path" }
		}
		index += 2
	}

	if (args[index]?.toLowerCase() !== "exec") {
		return { allowed: false, reason: "Plan allows pnpm only to execute an installed verification binary" }
	}
	const executable = normalizedExecutable(args[index + 1] ?? "")
	if (!executable) return { allowed: false, reason: "pnpm exec requires a simple executable name" }
	return classifyVerificationExecutable(executable, args.slice(index + 2))
}

/**
 * Classify the narrow command subset that strict Plan mode may execute.
 * The result is independent of user auto-approval settings and is suitable for
 * both model-facing filtering and the final host execution boundary.
 */
export function classifyPlanCommand(command: string): PlanCommandDecision {
	const trimmed = command.trim()
	if (!trimmed) return { allowed: false, reason: "command is empty" }
	if (trimmed.length > MAX_PLAN_COMMAND_LENGTH) {
		return { allowed: false, reason: "command exceeds the Plan command length limit" }
	}
	if (UNSAFE_SHELL_SYNTAX.test(trimmed)) {
		return {
			allowed: false,
			reason: "shell composition, expansion, redirection, and glob syntax are unavailable in Plan",
		}
	}

	const tokens = tokenizeSingleCommand(trimmed)
	if (!tokens?.length) return { allowed: false, reason: "command quoting is invalid" }
	if (hasUnsafeArgument(tokens.slice(1))) {
		return { allowed: false, reason: "command option can write, watch, or update repository state" }
	}

	const executable = normalizedExecutable(tokens[0])
	if (!executable) return { allowed: false, reason: "command must use an allow-listed executable name" }
	if (executable === "git") return classifyGit(tokens)
	if (executable === "pnpm") return classifyPnpm(tokens.slice(1))
	return classifyVerificationExecutable(executable, tokens.slice(1))
}

export function isPlanCommandAllowed(command: string): boolean {
	return classifyPlanCommand(command).allowed
}
