import { createHash, randomBytes } from "crypto"

import type {
	SubagentCommandApprovalPolicy,
	SubagentCommandApprovalRule,
	SubagentCommandApprovalTokenRule,
} from "@alpha-code/types"

import {
	analyzeShellCommands,
	analyzeShellCommandTokens,
	containsDynamicExecutable,
	shellCommandArgumentTokens,
	type ShellCommandPlatform,
	type ShellCommandToken,
} from "./shellCommand"
import { analyzeIndirectCommandExecution } from "./indirectCommandExecution"

const commandPlatform = (): ShellCommandPlatform => (process.platform === "win32" ? "win32" : "posix")

const digestCommandPrefix = (salt: string, prefix: string): string =>
	createHash("sha256").update(salt).update("\0").update(prefix).digest("hex")

const normalizeArgv = (tokens: string[], platform: ShellCommandPlatform): string[] =>
	tokens.map((token, index) =>
		index === 0 && platform === "win32" ? token.replace(/\\/g, "/").toLowerCase() : token,
	)

const digestCommandArgv = (salt: string, tokens: string[]): string => digestCommandPrefix(salt, JSON.stringify(tokens))

/**
 * Freeze complete argv prefix rules without copying their potentially credential-bearing
 * plaintext into durable child manifests.
 */
export function createSubagentCommandApprovalPolicy(
	allowedCommands: string[],
	deniedCommands: string[],
	salt = randomBytes(32).toString("hex"),
): SubagentCommandApprovalPolicy {
	const platform = commandPlatform()
	const buildRules = (
		commands: string[],
	): { wildcard: boolean; unresolved: boolean; rules: SubagentCommandApprovalTokenRule[] } => {
		let wildcard = false
		let unresolved = false
		const rules = new Map<string, SubagentCommandApprovalTokenRule>()
		for (const command of commands) {
			if (!command?.trim()) continue
			if (command === "*") {
				wildcard = true
				continue
			}
			const tokens = parseLiteralPrefix(command, platform)
			if (!tokens) {
				unresolved = true
				continue
			}
			const digest = digestCommandArgv(salt, tokens)
			rules.set(`${tokens.length}:${digest}`, { tokenCount: tokens.length, digest })
		}
		return {
			wildcard,
			unresolved,
			rules: [...rules.values()].sort(
				(left, right) => left.tokenCount - right.tokenCount || left.digest.localeCompare(right.digest),
			),
		}
	}

	const allowed = buildRules(allowedCommands)
	const denied = buildRules(deniedCommands)
	return {
		algorithm: "sha256-salted-argv-v2",
		platform,
		salt,
		allowAll: allowed.wildcard,
		denyAll: denied.wildcard,
		unresolvedDenyRules: denied.unresolved,
		allowed: allowed.rules,
		denied: denied.rules,
	}
}

/** Remove only ceilings whose denials are proven redundant under the newly captured command policy. */
export function compactSubagentCommandApprovalCeilings(
	primary: SubagentCommandApprovalPolicy,
	ceilings: readonly SubagentCommandApprovalPolicy[],
	knownDeniedCommands: string[],
): SubagentCommandApprovalPolicy[] {
	const known = createSubagentCommandApprovalPolicy([], knownDeniedCommands, primary.salt)
	const ruleKey = (rule: SubagentCommandApprovalTokenRule) => `${rule.tokenCount}:${rule.digest}`
	const primaryDenials =
		primary.algorithm === "sha256-salted-argv-v2" ? new Set(primary.denied.map(ruleKey)) : undefined
	const knownIsEnforced =
		primary.algorithm === "sha256-salted-argv-v2" &&
		known.algorithm === "sha256-salted-argv-v2" &&
		primary.platform === known.platform &&
		(!known.denyAll || primary.denyAll) &&
		(!known.unresolvedDenyRules || primary.unresolvedDenyRules) &&
		known.denied.every((rule) => primaryDenials!.has(ruleKey(rule)))
	const covered = (ceiling: SubagentCommandApprovalPolicy) => {
		if (primary.denyAll) return true
		if (
			ceiling.denyAll ||
			!knownIsEnforced ||
			primary.algorithm !== "sha256-salted-argv-v2" ||
			ceiling.algorithm !== "sha256-salted-argv-v2" ||
			primary.platform !== ceiling.platform ||
			(ceiling.unresolvedDenyRules && !primary.unresolvedDenyRules)
		)
			return false
		const replayed = createSubagentCommandApprovalPolicy([], knownDeniedCommands, ceiling.salt)
		if (replayed.algorithm !== "sha256-salted-argv-v2") return false
		const replayedDenials = new Set(replayed.denied.map(ruleKey))
		return ceiling.denied.every((rule) => replayedDenials.has(ruleKey(rule)))
	}
	const unique = new Map<string, SubagentCommandApprovalPolicy>()
	for (const ceiling of ceilings) {
		// A primary with no allowed commands already requires review for every command.
		// Retain the ceiling's denials, which still distinguish denial from review.
		const normalized =
			ceiling.allowAll || (!primary.allowAll && primary.allowed.length === 0)
				? { ...ceiling, allowAll: true, allowed: [] }
				: ceiling
		if (normalized.allowAll && covered(normalized)) continue
		const key = JSON.stringify({
			...normalized,
			allowed: [...normalized.allowed].sort((left, right) => left.digest.localeCompare(right.digest)),
			denied: [...normalized.denied].sort((left, right) => left.digest.localeCompare(right.digest)),
		})
		unique.set(key, normalized)
	}
	return [...unique.values()]
}

/**
 * Detect dangerous parameter substitutions that could lead to command execution.
 * These patterns are never auto-approved and always require explicit user approval.
 *
 * Detected patterns:
 * - ${var@P} - Prompt string expansion (interprets escape sequences and executes embedded commands)
 * - ${var@Q} - Quote removal
 * - ${var@E} - Escape sequence expansion
 * - ${var@A} - Assignment statement
 * - ${var@a} - Attribute flags
 * - ${var=value} with escape sequences - Can embed commands via \140 (backtick), \x60, or \u0060
 * - ${!var} - Indirect variable references
 * - <<<$(...) or <<<`...` - Here-strings with command substitution
 * - =(...) - Zsh process substitution that executes commands (array assignments like `var=(...)` are excluded)
 * - *(e:...:) or similar - Zsh glob qualifiers with code execution
 *
 * @param source - The command string to analyze
 * @returns true if dangerous substitution patterns are detected, false otherwise
 */
export function containsDangerousSubstitution(source: string): boolean {
	// Check for dangerous parameter expansion operators that can execute commands
	// ${var@P} - Prompt string expansion (interprets escape sequences and executes embedded commands)
	// ${var@Q} - Quote removal
	// ${var@E} - Escape sequence expansion
	// ${var@A} - Assignment statement
	// ${var@a} - Attribute flags
	const dangerousParameterExpansion = /\$\{[^}]*@[PQEAa][^}]*\}/.test(source)

	// Check for parameter expansions with assignments that could contain escape sequences
	// ${var=value} or ${var:=value} can embed commands via escape sequences like \140 (backtick)
	// Also check for ${var+value}, ${var:-value}, ${var:+value}, ${var:?value}
	const parameterAssignmentWithEscapes =
		/\$\{[^}]*[=+\-?][^}]*\\[0-7]{3}[^}]*\}/.test(source) || // octal escapes
		/\$\{[^}]*[=+\-?][^}]*\\x[0-9a-fA-F]{2}[^}]*\}/.test(source) || // hex escapes
		/\$\{[^}]*[=+\-?][^}]*\\u[0-9a-fA-F]{4}[^}]*\}/.test(source) // unicode escapes

	// Check for indirect variable references that could execute commands
	// ${!var} performs indirect expansion which can be dangerous with crafted variable names
	const indirectExpansion = /\$\{![^}]+\}/.test(source)

	// Check for here-strings with command substitution
	// <<<$(...) or <<<`...` can execute commands
	const hereStringWithSubstitution = /<<<\s*(\$\(|`)/.test(source)

	// Check for zsh process substitution =(...) which executes commands
	// =(...) creates a temporary file containing the output of the command, but executes it
	const zshProcessSubstitution = /(?:(?<=^)|(?<=[\s;|&(<]))=\([^)]+\)/.test(source)

	// Check for zsh glob qualifiers with code execution (e:...:)
	// Patterns like *(e:whoami:) or ?(e:rm -rf /:) execute commands during glob expansion
	// This regex matches patterns like *(e:...:), ?(e:...:), +(e:...:), @(e:...:), !(e:...:)
	const zshGlobQualifier = /[*?+@!]\(e:[^:]+:\)/.test(source)

	// Return true if any dangerous pattern is detected
	return (
		dangerousParameterExpansion ||
		parameterAssignmentWithEscapes ||
		indirectExpansion ||
		hereStringWithSubstitution ||
		zshProcessSubstitution ||
		zshGlobQualifier
	)
}

/** Command approval decisions are shared by execution, frozen child ceilings, and presentation. */
export type CommandDecision = "auto_approve" | "auto_deny" | "ask_user"

type ParsedCommand = { source: string; tokens: ShellCommandToken[] }

function parseSingleCommand(
	command: string,
	platform: ShellCommandPlatform,
	literalRule = false,
): ParsedCommand | undefined {
	const parsed = analyzeShellCommandTokens(command.trim(), platform)
	if (
		parsed.malformed ||
		parsed.unsupportedSyntax ||
		(!literalRule && parsed.ambiguousSyntax) ||
		parsed.hasChainOperators ||
		parsed.commands.length !== 1
	) {
		return undefined
	}
	const single = parsed.commands[0]
	const tokens = shellCommandArgumentTokens(single.tokens)
	if (!tokens.length || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0].value)) return undefined
	return { source: single.source, tokens }
}

function parseLiteralPrefix(prefix: string, platform: ShellCommandPlatform): string[] | undefined {
	const parsed = parseSingleCommand(prefix, platform, true)
	if (
		!parsed ||
		parsed.tokens.some((token) => token.dynamic) ||
		analyzeShellCommandTokens(prefix.trim(), platform).commands[0].tokens.some((token) => token.redirection)
	) {
		return undefined
	}
	return normalizeArgv(
		parsed.tokens.map(({ value }) => value),
		platform,
	)
}

function matchesPrefix(tokens: ShellCommandToken[], prefix: string[], platform: ShellCommandPlatform): boolean {
	if (tokens.length < prefix.length) return false
	const argv = normalizeArgv(
		tokens.map(({ value }) => value),
		platform,
	)
	return prefix.every((expected, index) => !tokens[index].dynamic && argv[index] === expected)
}

function compileRules(commands: readonly string[], platform: ShellCommandPlatform) {
	const prefixes: string[][] = []
	let wildcard = false
	let unresolved = false
	for (const command of commands) {
		if (!command?.trim()) continue
		if (command === "*") wildcard = true
		else {
			const prefix = parseLiteralPrefix(command, platform)
			if (prefix) prefixes.push(prefix)
			else unresolved = true
		}
	}
	return { prefixes, wildcard, unresolved }
}

/** Match every executable and apply any matching denial, regardless of allow-prefix specificity. */
export function getCommandDecision(
	command: string,
	allowedCommands: readonly string[],
	deniedCommands?: readonly string[],
): CommandDecision {
	const platform = commandPlatform()
	const allowed = compileRules(allowedCommands ?? [], platform)
	const denied = compileRules(deniedCommands ?? [], platform)
	const hasDeniedRules = denied.wildcard || denied.unresolved || denied.prefixes.length > 0
	return aggregateCommandDecision(
		command,
		({ tokens }) => {
			if (denied.wildcard || denied.prefixes.some((prefix) => matchesPrefix(tokens, prefix, platform))) {
				return "auto_deny"
			}
			if (denied.unresolved) return "ask_user"
			if (allowed.wildcard || allowed.prefixes.some((prefix) => matchesPrefix(tokens, prefix, platform))) {
				return "auto_approve"
			}
			return "ask_user"
		},
		hasDeniedRules,
		allowed.wildcard && !hasDeniedRules,
		platform,
	)
}

function aggregateCommandDecision(
	command: string,
	getDecision: (singleCommand: ParsedCommand) => CommandDecision,
	hasDeniedRules: boolean,
	unrestrictedWildcard: boolean,
	platform: ShellCommandPlatform,
): CommandDecision {
	if (!command?.trim()) return "auto_approve"

	// Work from original source and parsed tokens: joining argv would turn a quoted argument into new commands.
	const shellAnalysis = analyzeShellCommands(command)
	const parsed = [command, ...shellAnalysis.commands].map((source) => analyzeShellCommandTokens(source, platform))
	const commands = parsed.flatMap((analysis) =>
		analysis.commands.map(({ source, tokens }) => ({ source, tokens: shellCommandArgumentTokens(tokens) })),
	)
	const decisions = commands.map(getDecision)
	if (decisions.includes("auto_deny")) return "auto_deny"
	if (!commands.length || parsed.some((analysis) => analysis.malformed) || shellAnalysis.malformedSubstitution) {
		return "ask_user"
	}

	// Preserve explicit global grants for scripts/computed commands after rejecting malformed syntax.
	// Workspace/path protections remain at the execution boundary.
	if (unrestrictedWildcard) return "auto_approve"

	const indirect = analyzeIndirectCommandExecution(command, platform)
	const nestedCommands = indirect.commands.flatMap((source) =>
		analyzeShellCommandTokens(source, platform).commands.map(({ source, tokens }) => ({
			source,
			tokens: shellCommandArgumentTokens(tokens),
		})),
	)
	const nestedDecisions = [
		...nestedCommands.map(getDecision),
		...indirect.tokenCommands.map((tokens) =>
			getDecision({ source: "", tokens: shellCommandArgumentTokens(tokens) }),
		),
	]
	if (nestedDecisions.includes("auto_deny")) return "auto_deny"

	if (
		containsDangerousSubstitution(command) ||
		containsDynamicExecutable(command, platform) ||
		indirect.dynamicCode ||
		(hasDeniedRules && !indirect.resolved) ||
		// Argument expansion may produce a denied prefix even when its raw spelling does not match.
		(hasDeniedRules &&
			([...commands, ...nestedCommands].some(({ tokens }) => tokens.some((token) => token.dynamic)) ||
				indirect.tokenCommands.some((tokens) => tokens.some((token) => token.dynamic)))) ||
		parsed.some((analysis) => analysis.unsupportedSyntax || analysis.ambiguousSyntax) ||
		commands.some(
			({ tokens }) => !tokens.length || tokens[0].dynamic || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0].value),
		)
	) {
		return "ask_user"
	}

	return decisions.every((decision) => decision === "auto_approve") ? "auto_approve" : "ask_user"
}

function matchesHashedArgv(
	tokens: ShellCommandToken[],
	rules: SubagentCommandApprovalTokenRule[],
	salt: string,
	platform: ShellCommandPlatform,
): boolean {
	const argv = normalizeArgv(
		tokens.map(({ value }) => value),
		platform,
	)
	return rules.some(
		(rule) =>
			rule.tokenCount <= tokens.length &&
			!tokens.slice(0, rule.tokenCount).some((token) => token.dynamic) &&
			digestCommandArgv(salt, argv.slice(0, rule.tokenCount)) === rule.digest,
	)
}

function matchesLegacyRawPrefix(command: string, rules: SubagentCommandApprovalRule[], salt: string): boolean {
	const normalized = command.trim().toLowerCase()
	return rules.some(
		(rule) =>
			rule.prefixLength <= normalized.length &&
			digestCommandPrefix(salt, normalized.slice(0, rule.prefixLength)) === rule.digest,
	)
}

function matchesLegacyAllowedPrefix(
	command: ParsedCommand,
	rules: SubagentCommandApprovalRule[],
	salt: string,
	platform: ShellCommandPlatform,
): boolean {
	const raw = command.source.trim()
	const normalized = raw.toLowerCase()
	return rules.some((rule) => {
		if (rule.prefixLength > normalized.length) return false
		if (digestCommandPrefix(salt, normalized.slice(0, rule.prefixLength)) !== rule.digest) return false
		// v1 discarded case and token structure. Only grant a proven complete raw prefix;
		// never infer quoted/normalized variants or mixed-case argument authority from its opaque digest.
		const prefix = parseSingleCommand(raw.slice(0, rule.prefixLength), platform)
		if (!prefix || prefix.tokens.some((token) => token.dynamic)) return false
		if (
			prefix.tokens.some(
				({ value }, index) => (index > 0 || platform === "posix") && value !== value.toLowerCase(),
			)
		) {
			return false
		}
		return matchesPrefix(
			command.tokens,
			normalizeArgv(
				prefix.tokens.map(({ value }) => value),
				platform,
			),
			platform,
		)
	})
}

/** Evaluate a frozen ceiling without persisting or reconstructing plaintext command rules. */
export function getSubagentCommandDecision(command: string, policy: SubagentCommandApprovalPolicy): CommandDecision {
	if (policy.algorithm === "sha256-salted-argv-v2") {
		return aggregateCommandDecision(
			command,
			({ tokens }) => {
				if (policy.denyAll || matchesHashedArgv(tokens, policy.denied, policy.salt, policy.platform)) {
					return "auto_deny"
				}
				if (policy.unresolvedDenyRules) return "ask_user"
				return policy.allowAll || matchesHashedArgv(tokens, policy.allowed, policy.salt, policy.platform)
					? "auto_approve"
					: "ask_user"
			},
			policy.denyAll || policy.unresolvedDenyRules || policy.denied.length > 0,
			policy.allowAll && !policy.denyAll && !policy.unresolvedDenyRules && !policy.denied.length,
			policy.platform,
		)
	}
	if (policy.algorithm !== "sha256-salted-prefix-v1") return "ask_user"
	const platform = commandPlatform()
	return aggregateCommandDecision(
		command,
		(single) => {
			if (policy.denyAll || matchesLegacyRawPrefix(single.source, policy.denied, policy.salt)) return "auto_deny"
			// An opaque v1 deny may use any old quoting/spacing. A raw miss cannot establish exclusion under argv rules.
			if (policy.denied.length) return "ask_user"
			return policy.allowAll || matchesLegacyAllowedPrefix(single, policy.allowed, policy.salt, platform)
				? "auto_approve"
				: "ask_user"
		},
		policy.denyAll || policy.denied.length > 0,
		policy.allowAll && !policy.denyAll && !policy.denied.length,
		platform,
	)
}
