import {
	analyzeShellCommandTokens,
	shellCommandArgumentTokens,
	type ShellCommandPlatform,
} from "../auto-approval/shellCommand"
import { pythonPytestArguments } from "../../shared/python-command"

type VerificationCategory = "test" | "build" | "lint" | "typecheck"

function executableName(value: string): string {
	return value
		.replace(/\\/g, "/")
		.split("/")
		.at(-1)!
		.toLowerCase()
		.replace(/\.(?:exe|cmd|bat)$/, "")
}

function scriptCategory(script: string): VerificationCategory | undefined {
	if (/^test(?::[\w.-]+)*$/.test(script)) return "test"
	if (/^(?:build|bundle|compile)(?::[\w.-]+)*$/.test(script)) return "build"
	// Formatting scripts commonly write files; only an explicit check names verification.
	if (/^lint(?::[\w.-]+)*$/.test(script) || script === "format:check") return "lint"
	if (/^(?:typecheck|check-types)(?::[\w.-]+)*$/.test(script)) return "typecheck"
	return undefined
}

const PACKAGE_VALUE_FLAGS = new Set(["--dir", "--prefix", "--cwd", "--filter", "--workspace", "-C", "-F"])
const PACKAGE_BOOLEAN_FLAGS = new Set(["--silent", "--no-install", "--yes", "-y", "-s"])

function packageCommandIndex(args: string[], start: number): number | undefined {
	let index = start
	while (args[index]?.startsWith("-")) {
		const [flag, value] = args[index].split("=", 2)
		if (PACKAGE_VALUE_FLAGS.has(flag)) {
			if (value !== undefined) {
				if (!value) return undefined
				index++
			} else {
				if (!args[index + 1] || args[index + 1].startsWith("-")) return undefined
				index += 2
			}
		} else if (PACKAGE_BOOLEAN_FLAGS.has(flag) && value === undefined) index++
		else return undefined
	}
	return args[index] ? index : undefined
}

function classifyInvocation(
	args: string[],
	platform: ShellCommandPlatform,
	depth: number,
): VerificationCategory | undefined {
	if (depth > 4 || !args.length) return undefined
	const executable = executableName(args[0])
	if (["sh", "bash", "zsh", "dash"].includes(executable)) {
		return args.length === 3 && /^-(?:c|lc|cl)$/.test(args[1])
			? classifyVerificationCommand(args[2], "posix", depth + 1)
			: undefined
	}
	if (["pwsh", "powershell", "cmd"].includes(executable)) {
		let index = 1
		const allowed = executable === "cmd" ? ["/d", "/s"] : ["-noprofile", "-noninteractive", "-nologo"]
		while (allowed.includes(args[index]?.toLowerCase())) index++
		const commandFlag = executable === "cmd" ? "/c" : "-command"
		return args[index]?.toLowerCase() === commandFlag && args.length === index + 2
			? classifyVerificationCommand(args[index + 1], "win32", depth + 1)
			: undefined
	}
	if (executable === "env" && platform === "posix") {
		let index = args[1] === "-i" ? 2 : 1
		while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[index] ?? "")) index++
		return args[index] && !args[index].startsWith("-")
			? classifyInvocation(args.slice(index), platform, depth + 1)
			: undefined
	}
	// Help, discovery and optional/no-op invocations do not establish verification.
	if (
		args
			.slice(1)
			.some((argument) =>
				/^(?:--(?:help|version|if-present|ignore-scripts|dry-run|no-run|list|listTests|listFilesOnly|showConfig|collect-only|co|fixtures|markers|init|show-config|show-settings|print-config|env-info)|-[hV])(?:=|$)/i.test(
					argument,
				),
			)
	)
		return undefined

	if (["npm", "pnpm", "yarn", "npx"].includes(executable)) {
		let index = packageCommandIndex(args, 1)
		if (index === undefined) return undefined
		if (executable === "npx") return classifyInvocation(args.slice(index), platform, depth + 1)
		if (args[index] === "exec") {
			index++
			if (args[index] === "--") index++
			return args[index] && !args[index].startsWith("-")
				? classifyInvocation(args.slice(index), platform, depth + 1)
				: undefined
		}
		if (args[index] === "run" || args[index] === "run-script") {
			index = packageCommandIndex(args, index + 1)
			if (index === undefined) return undefined
		}
		return scriptCategory(args[index])
	}
	const normalizedArgs = [executable, ...args.slice(1)]
	if (pythonPytestArguments(normalizedArgs)) return "test"
	if (["vitest", "jest", "mocha", "ava"].includes(executable)) {
		return args[1] === "list" || args[1] === "init" ? undefined : "test"
	}
	if (executable === "node") return args[1] === "--test" ? "test" : undefined
	if (executable === "go") return args[1] === "test" ? "test" : args[1] === "build" ? "build" : undefined
	if (executable === "cargo") return args[1] === "test" ? "test" : args[1] === "build" ? "build" : undefined
	if (executable === "ruff") return args[1] === "check" ? "lint" : undefined
	if (executable === "eslint") return "lint"
	if (executable === "prettier")
		return args.some((arg) => ["--check", "-c", "--list-different", "-l"].includes(arg)) ? "lint" : undefined
	if (executable === "tsc") return "typecheck"
	return undefined
}

/**
 * Codex d4a341bd (2026-11-06), shell-command/parse_command.rs and core/tools/events.rs,
 * separates conservative command summaries from actual execution status. Alpha's
 * additional verification labels likewise require a literal invocation; arbitrary
 * argument/filename text and shell structures that can mask failure are not evidence.
 */
export function classifyVerificationCommand(
	command: string,
	platform: ShellCommandPlatform = process.platform === "win32" ? "win32" : "posix",
	depth = 0,
): VerificationCategory | undefined {
	if (depth > 4 || command.length > 65_536) return undefined
	const analysis = analyzeShellCommandTokens(command, platform)
	if (analysis.malformed || analysis.unsupportedSyntax || analysis.ambiguousSyntax) return undefined
	// Only success-preserving AND chains can supply one aggregate verification receipt.
	if (analysis.chainOperators.some((operator) => operator !== "&&")) return undefined
	const categories: VerificationCategory[] = []
	for (const { tokens: rawTokens } of analysis.commands) {
		const tokens = shellCommandArgumentTokens(rawTokens)
		let index = 0
		if (platform === "posix") {
			while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]?.value ?? "")) index++
		}
		const invocation = tokens.slice(index)
		if (!invocation.length || invocation.some((token) => token.dynamic)) return undefined
		const category = classifyInvocation(
			invocation.map((token) => token.value),
			platform,
			depth,
		)
		if (category) categories.push(category)
		else if (
			analysis.commands.length > 1 &&
			// Unknown chain stages can replace launchers or change execution semantics.
			// Admit only literal directory/output scaffolding alongside recognized checks.
			!["cd", "echo", "pwd"].includes(invocation[0].value.toLowerCase())
		)
			return undefined
	}
	// Retain the existing category priority when an AND chain contains several checks.
	return (["test", "build", "lint", "typecheck"] as const).find((category) => categories.includes(category))
}
