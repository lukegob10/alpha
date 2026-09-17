import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"

import type { TrustedExplorationObservation } from "./BaseTool"

const MAX_COMMAND_LENGTH = 4_096
const MAX_ARGUMENTS = 64
const MAX_ARGUMENT_LENGTH = 4_096
const UNSAFE_UNQUOTED_SYNTAX = /[\\\0\r\n;&|<>`$%!^#*?()[\]{}]/

// Progress observation is independent of Plan-mode command authorization. These
// commands have already run; requiring Plan-only invocation flags loses valid reads.
const GIT_INSPECTIONS = new Set([
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
const GIT_EXTERNAL_OR_WRITE_OPTIONS = new Set([
	"--ext-diff",
	"--filters",
	"--open-files-in-pager",
	"--output",
	"--textconv",
])
const GIT_PRESENTATION_OPTIONS = new Set(["--color", "--no-color", "--no-ext-diff", "--no-textconv"])
const GIT_FORMAT_VALUE_OPTIONS = new Set([
	"--format",
	"--pretty",
	"--date",
	"--src-prefix",
	"--dst-prefix",
	"--line-prefix",
])

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
	["--fixed-strings", "fixed-strings"],
	["-F", "fixed-strings"],
	["--ignore-case", "case:ignore"],
	["-i", "case:ignore"],
	["--case-sensitive", "case:sensitive"],
	["-s", "case:sensitive"],
	["--smart-case", "case:smart"],
	["-S", "case:smart"],
	["--word-regexp", "word-regexp"],
	["-w", "word-regexp"],
	["--line-regexp", "line-regexp"],
	["-x", "line-regexp"],
	["--invert-match", "invert-match"],
	["-v", "invert-match"],
	["--files-with-matches", "output:files-with-matches"],
	["-l", "output:files-with-matches"],
	["--files-without-match", "output:files-without-match"],
	["--count", "output:count"],
	["-c", "output:count"],
	["--count-matches", "output:count-matches"],
	["--multiline", "multiline"],
	["-U", "multiline"],
])

const RG_PRESENTATION_OPTIONS = new Set([
	"-n",
	"--line-number",
	"-N",
	"--no-line-number",
	"-H",
	"--with-filename",
	"-I",
	"--no-filename",
	"--heading",
	"--no-heading",
	"--column",
	"--no-column",
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
	["--regexp", "regexp"],
	["-e", "regexp"],
	["--after-context", "after-context"],
	["-A", "after-context"],
	["--before-context", "before-context"],
	["-B", "before-context"],
	["--context", "context"],
	["-C", "context"],
	["--max-count", "max-count"],
	["-m", "max-count"],
	["--color", "color"],
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
export function tokenizeSingleCommand(command: string): string[] | undefined {
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
		if (UNSAFE_UNQUOTED_SYNTAX.test(character) || (character === "~" && !tokenStarted)) return undefined
		token += character
		tokenStarted = true
	}

	if (quote || tokens.length >= MAX_ARGUMENTS) return undefined
	if (tokenStarted) tokens.push(token)
	return tokens.length > 0 && tokens.length <= MAX_ARGUMENTS ? tokens : undefined
}

async function canonicalGitInspection(
	tokens: readonly string[],
	root: string,
	capturedCwd: string,
): Promise<ParsedInspection | undefined> {
	let index = 1
	let cwd = capturedCwd
	while (index < tokens.length) {
		if (tokens[index] === "--no-pager" || tokens[index] === "-P") {
			index++
		} else if (tokens[index] === "-C") {
			const target = tokens[index + 1]
			if (!target) return undefined
			cwd = await fs.realpath(path.resolve(cwd, target))
			if (!containsPath(root, cwd)) return undefined
			index += 2
		} else {
			break
		}
	}
	const subcommand = tokens[index++]
	if (!GIT_INSPECTIONS.has(subcommand)) return undefined
	const semantics = [normalizedPathIdentity(cwd), subcommand]
	let pathsOnly = false
	for (; index < tokens.length; index++) {
		let token = tokens[index]
		if (!pathsOnly && token === "--") {
			pathsOnly = true
			semantics.push(token)
			continue
		}
		if (!pathsOnly) {
			const option = token.split("=", 1)[0]
			if (GIT_EXTERNAL_OR_WRITE_OPTIONS.has(option)) return undefined
			if (GIT_PRESENTATION_OPTIONS.has(option)) continue
			// A new format string (including arbitrary literal text) is not a new
			// question about the repository. Keep it out of the novelty identity.
			if (GIT_FORMAT_VALUE_OPTIONS.has(option)) {
				if (!token.includes("=")) return undefined
				continue
			}
			if (subcommand === "status" && token === "-s") token = "--short"
			if (subcommand === "diff" && token === "--staged") token = "--cached"
		}
		// Preserve revision/path/query selection. Different negative queries can
		// also advance a review; absence of workspace edits is not proof of a loop.
		semantics.push(token.replace(/^(?:\.\/)+/, ""))
	}
	return { executable: "git", semantics }
}

function validRgOptionValue(kind: string, value: string): boolean {
	if (!value || value.length > MAX_ARGUMENT_LENGTH || /[\0\r\n]/.test(value)) return false
	if (kind === "max-depth") return /^\d{1,3}$/.test(value) && Number(value) <= 256
	if (["after-context", "before-context", "context", "max-count"].includes(kind)) return /^\d{1,9}$/.test(value)
	if (kind === "color") return ["never", "auto", "always", "ansi"].includes(value)
	if (kind === "regexp") return true
	if (kind === "sort" || kind === "sort-reverse") return value.toLowerCase() === "path"
	if (kind === "type" || kind === "type-not") return /^[a-z0-9_-]{1,64}$/i.test(value)
	return kind === "glob"
}

export async function canonicalRgInspection(
	args: readonly string[],
	root: string,
	cwd: string,
): Promise<ParsedInspection | undefined> {
	const options = new Map<string, string>()
	const selectors: string[] = []
	const patterns: string[] = []
	const positionals: string[] = []
	const targets: string[] = []
	let filesMode = false
	let positionalsOnly = false
	const expanded = [...args]

	for (let index = 0; index < expanded.length; index += 1) {
		let token = expanded[index]
		if (!positionalsOnly && token === "--") {
			positionalsOnly = true
			continue
		}
		if (positionalsOnly || !token.startsWith("-")) {
			positionals.push(token)
			continue
		}
		// Split short clusters only while parsing options. A value such as -needle
		// after -e is consumed below without being reinterpreted as options.
		if (/^-[^-].+/.test(token)) {
			const flag = token.slice(0, 2)
			if (RG_VALUE_OPTIONS.has(flag)) {
				expanded.splice(index + 1, 0, token.slice(2))
			} else if (RG_BOOLEAN_OPTIONS.has(flag) || RG_PRESENTATION_OPTIONS.has(flag)) {
				expanded.splice(index + 1, 0, `-${token.slice(2)}`)
			} else return undefined
			if (expanded.length > MAX_ARGUMENTS) return undefined
			token = flag
		}
		if (RG_PRESENTATION_OPTIONS.has(token)) continue
		const booleanOption = RG_BOOLEAN_OPTIONS.get(token)
		if (booleanOption) {
			options.set(booleanOption.split(":", 1)[0], booleanOption)
			filesMode ||= booleanOption === "files"
			continue
		}

		const equalsIndex = token.startsWith("--") ? token.indexOf("=") : -1
		const optionToken = equalsIndex > 0 ? token.slice(0, equalsIndex) : token
		const optionKind = RG_VALUE_OPTIONS.get(optionToken)
		let optionValue = equalsIndex > 0 ? token.slice(equalsIndex + 1) : undefined
		if (optionKind) {
			optionValue ??= expanded[++index]
			if (!validRgOptionValue(optionKind, optionValue ?? "")) return undefined
			if (optionKind === "regexp") patterns.push(optionValue!)
			else if (["glob", "type", "type-not"].includes(optionKind)) selectors.push(`${optionKind}:${optionValue}`)
			else if (optionKind !== "color") options.set(optionKind, `${optionKind}:${optionValue}`)
			continue
		}
		return undefined
	}

	if (!filesMode && patterns.length === 0) {
		const pattern = positionals.shift()
		if (pattern === undefined) return undefined
		patterns.push(pattern)
	}
	if (filesMode && patterns.length > 0) return undefined
	for (const token of positionals) {
		if (token === "-" || token.length > MAX_ARGUMENT_LENGTH || path.isAbsolute(token)) return undefined
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

	return {
		executable: "rg",
		semantics: [
			...Array.from(options.values()).sort(),
			// Glob/type order changes the selected files. Explicit patterns are ORed.
			...selectors.map((selector) => `selector:${selector}`),
			...Array.from(new Set(patterns))
				.sort()
				.map((pattern) => `pattern:${pattern}`),
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
				? await canonicalRgInspection(tokens.slice(1), root, cwd)
				: await canonicalGitInspection(tokens, root, cwd)
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
