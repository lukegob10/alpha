import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"

import { classifyPlanCommand } from "../../shared/plan-command"
import type { TrustedExplorationObservation } from "./BaseTool"

const MAX_COMMAND_LENGTH = 4_096
const MAX_ARGUMENTS = 64
const MAX_ARGUMENT_LENGTH = 4_096
const UNSAFE_UNQUOTED_SYNTAX = /[\\\0\r\n;&|<>`$%!^#*?()[\]{}~]/

const RG_BOOLEAN_OPTIONS = new Map<string, string>([
	["--files", "files"],
	["--hidden", "hidden"],
	["--no-config", "no-config"],
	["--no-ignore", "no-ignore"],
	["--no-ignore-dot", "no-ignore-dot"],
	["--no-ignore-global", "no-ignore-global"],
	["--no-ignore-parent", "no-ignore-parent"],
	["--no-ignore-vcs", "no-ignore-vcs"],
	["--no-messages", "no-messages"],
	["--no-require-git", "no-require-git"],
	["--null", "null"],
	["--one-file-system", "one-file-system"],
	["-0", "null"],
])

const RG_VALUE_OPTIONS = new Map<string, string>([
	["--glob", "glob"],
	["--max-depth", "max-depth"],
	["--sort", "sort"],
	["--sortr", "sort-reverse"],
	["--type", "type"],
	["--type-not", "type-not"],
	["-g", "glob"],
	["-t", "type"],
	["-T", "type-not"],
])

export interface TrustedCommandExplorationInput {
	command: string
	workspaceRoot: string
	cwd: string
	executionStatus: "running" | "succeeded" | "failed" | "denied" | "cancelled" | "timed_out"
	exitCode?: number
}

interface ParsedInspection {
	executable: "git" | "rg"
	semantics: readonly string[]
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function containsPath(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate)
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

function normalizedExecutable(token: string): string | undefined {
	if (!token || token.includes("/") || token.includes("\\") || token.includes(":")) return undefined
	return token.toLowerCase().replace(/\.(?:cmd|exe)$/i, "")
}

function normalizedPathIdentity(value: string): string {
	const normalized = path.normalize(value).split(path.sep).join("/")
	return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

/** Tokenize one inert shell command without performing expansion. */
function tokenizeSingleCommand(command: string): string[] | undefined {
	const trimmed = command.trim()
	if (!trimmed || trimmed.length > MAX_COMMAND_LENGTH) return undefined

	const tokens: string[] = []
	let token = ""
	let quote: '"' | "'" | undefined
	let tokenStarted = false
	for (const character of trimmed) {
		if (quote) {
			if (character === quote) {
				quote = undefined
			} else if (/[\\\0\r\n`$%^]/.test(character)) {
				return undefined
			} else {
				token += character
			}
			tokenStarted = true
			continue
		}

		if (character === '"' || character === "'") {
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
		if (UNSAFE_UNQUOTED_SYNTAX.test(character)) return undefined
		token += character
		tokenStarted = true
	}

	if (quote || tokens.length >= MAX_ARGUMENTS) return undefined
	if (tokenStarted) tokens.push(token)
	return tokens.length > 0 && tokens.length <= MAX_ARGUMENTS ? tokens : undefined
}

function canonicalGitInspection(command: string, tokens: readonly string[]): ParsedInspection | undefined {
	const classification = classifyPlanCommand(command)
	if (!classification.allowed || classification.category !== "inspection") return undefined

	// Git accepts a broad collection of revision, format, and pathspec operands.
	// Treat the allow-listed subcommand as the stable exploration identity and
	// deliberately collapse its free-form arguments. This may withhold credit from
	// two genuinely different Git reads, but an endless sequence of successful
	// no-op pathspecs or formatting variants cannot manufacture progress.
	return { executable: "git", semantics: [tokens[2].toLowerCase()] }
}

function validRgOptionValue(kind: string, value: string): boolean {
	if (!value || value.length > MAX_ARGUMENT_LENGTH || /[\0\r\n]/.test(value)) return false
	if (kind === "max-depth") return /^\d{1,3}$/.test(value) && Number(value) <= 256
	if (kind === "sort" || kind === "sort-reverse") return value.toLowerCase() === "path"
	if (kind === "type" || kind === "type-not") return /^[a-z0-9_-]{1,64}$/i.test(value)
	return kind === "glob"
}

async function canonicalRgFilesInspection(
	args: readonly string[],
	root: string,
	cwd: string,
): Promise<ParsedInspection | undefined> {
	const options: string[] = []
	const targets: string[] = []
	let filesMode = false

	for (let index = 0; index < args.length; index += 1) {
		const token = args[index]
		const booleanOption = RG_BOOLEAN_OPTIONS.get(token)
		if (booleanOption) {
			options.push(booleanOption)
			filesMode ||= booleanOption === "files"
			continue
		}

		const equalsIndex = token.startsWith("--") ? token.indexOf("=") : -1
		const optionToken = equalsIndex > 0 ? token.slice(0, equalsIndex) : token
		let optionKind = RG_VALUE_OPTIONS.get(optionToken)
		let optionValue = equalsIndex > 0 ? token.slice(equalsIndex + 1) : undefined
		if (!optionKind && /^-[gtT].+/.test(token)) {
			optionKind = RG_VALUE_OPTIONS.get(token.slice(0, 2))
			optionValue = token.slice(2)
		}
		if (optionKind) {
			optionValue ??= args[++index]
			if (!validRgOptionValue(optionKind, optionValue ?? "")) return undefined
			options.push(`${optionKind}:${optionValue}`)
			continue
		}

		if (token.startsWith("-") || token.length > MAX_ARGUMENT_LENGTH || path.isAbsolute(token)) return undefined
		const absolute = path.resolve(cwd, token)
		if (!containsPath(root, absolute)) return undefined
		let realTarget: string
		try {
			realTarget = await fs.realpath(absolute)
		} catch {
			return undefined
		}
		if (!containsPath(root, realTarget)) return undefined
		targets.push(normalizedPathIdentity(realTarget))
	}

	if (!filesMode) return undefined
	return {
		executable: "rg",
		semantics: [
			...new Set(options.sort()),
			...new Set((targets.length > 0 ? targets : [normalizedPathIdentity(cwd)]).sort()),
		],
	}
}

/**
 * Issue progress-only metadata for a completed, host-supported repository
 * inspection. This does not classify approval, mutation, or verification.
 */
export async function getTrustedCommandExploration(
	input: TrustedCommandExplorationInput,
): Promise<TrustedExplorationObservation | undefined> {
	if (input.executionStatus !== "succeeded" || input.exitCode !== 0) return undefined

	const tokens = tokenizeSingleCommand(input.command)
	const executable = tokens ? normalizedExecutable(tokens[0]) : undefined
	if (!tokens || (executable !== "rg" && executable !== "git")) return undefined

	try {
		const [root, cwd] = await Promise.all([fs.realpath(input.workspaceRoot), fs.realpath(input.cwd)])
		if (!containsPath(root, cwd)) return undefined
		const inspection =
			executable === "rg"
				? await canonicalRgFilesInspection(tokens.slice(1), root, cwd)
				: canonicalGitInspection(input.command, tokens)
		if (!inspection) return undefined

		// A Git inspection can observe the repository above cwd, while an explicit
		// rg target can observe any in-workspace subtree. Report the canonical
		// workspace boundary conservatively so cwd/path spelling cannot split scope.
		const scope = path.normalize(root)
		return {
			scope,
			semanticFingerprint: digest({
				version: 1,
				scope: normalizedPathIdentity(scope),
				executable: inspection.executable,
				semantics: inspection.semantics,
			}),
		}
	} catch {
		// Observation is optional and progress-only. Unavailable canonical state
		// must withhold credit without changing the already completed command.
		return undefined
	}
}
