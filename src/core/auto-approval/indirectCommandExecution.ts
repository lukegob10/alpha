import {
	analyzeShellCommandTokens,
	shellCommandArgumentTokens,
	tokenizeShellCommands,
	type ShellCommandPlatform,
	type ShellCommandToken,
} from "./shellCommand"

const TRANSPARENT_LAUNCHERS = new Set([
	"call",
	"command",
	"doas",
	"env",
	"exec",
	"nice",
	"nohup",
	"setsid",
	"sudo",
	"timeout",
	"busybox",
	"npx",
	"pnpx",
])
const OPAQUE_LAUNCHERS = new Set(["xargs", "start", "time"])
const EVALUATORS = new Set(["eval", "iex", "invoke-expression"])
const SCRIPT_LOADERS = new Set(["source", "."])
const SHELLS = new Set(["sh", "ash", "bash", "dash", "fish", "ksh", "zsh", "csh", "tcsh", "cmd", "powershell", "pwsh"])
const SCRIPT_INTERPRETERS = new Set([
	"node",
	"nodejs",
	"bun",
	"deno",
	"python",
	"py",
	"ruby",
	"perl",
	"lua",
	"php",
	"r",
	"rscript",
])
const DYNAMIC_CODE_OPERAND = /[$`]|%[A-Za-z_][A-Za-z0-9_]*%|![A-Za-z_][A-Za-z0-9_]*!/

function isScriptInterpreter(name: string): boolean {
	return SCRIPT_INTERPRETERS.has(name) || /^python\d+(?:\.\d+)?$/.test(name)
}

function optionConsumesValue(name: string, option: string): boolean {
	return (
		(name === "env" && ["-u", "--unset", "-c", "--chdir", "-a", "--argv0"].includes(option)) ||
		(name === "sudo" && ["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt"].includes(option)) ||
		(name === "exec" && ["-a", "--argv0"].includes(option)) ||
		(name === "nice" && ["-n", "--adjustment"].includes(option)) ||
		(name === "timeout" && ["-s", "--signal", "-k", "--kill-after"].includes(option)) ||
		(["npx", "pnpx"].includes(name) && ["-p", "--package"].includes(option))
	)
}

function executableName(token: string): string {
	return token
		.replace(/\\/g, "/")
		.split("/")
		.pop()!
		.toLowerCase()
		.replace(/\.(?:exe|cmd|bat)$/, "")
}

function inlineCode(tokens: string[]): { code: string; opaque: boolean } | undefined {
	const name = executableName(tokens[0] ?? "")
	const args = tokens.slice(1)
	if (EVALUATORS.has(name) || SCRIPT_LOADERS.has(name)) {
		return { code: args.join(" "), opaque: args.length === 0 }
	}

	for (let index = 0; index < args.length; index++) {
		const option = args[index].toLowerCase()
		if (SHELLS.has(name) && !["cmd", "powershell", "pwsh"].includes(name)) {
			if (/^-[a-z]*c[a-z]*$/.test(option) || option === "--command") {
				return { code: args.slice(index + 1).join(" "), opaque: false }
			}
		}
		if (name === "cmd" && ["/c", "/k"].includes(option)) {
			return { code: args.slice(index + 1).join(" "), opaque: false }
		}
		if (["powershell", "pwsh"].includes(name)) {
			if (["-encodedcommand", "-enc", "-ec"].includes(option)) {
				return { code: args.slice(index + 1).join(" "), opaque: true }
			}
			if (["-command", "-c"].includes(option)) {
				return { code: args.slice(index + 1).join(" "), opaque: false }
			}
		}
		const evalOption = ["node", "nodejs", "bun", "deno", "ruby", "perl", "lua", "r", "rscript"].includes(name)
			? /^(?:-e|-p|--eval|--print)(?:=(.*))?$/
			: /^(?:-c|--command)(?:=(.*))?$/
		if (isScriptInterpreter(name)) {
			if (name === "deno" && option === "eval") return { code: args.slice(index + 1).join(" "), opaque: false }
			if (name === "php" && option === "-r") return { code: args.slice(index + 1).join(" "), opaque: false }
			if (name === "php" && /^-r.+/.test(option)) return { code: args[index].slice(2), opaque: false }
			if (
				["node", "nodejs", "bun", "ruby", "perl", "lua", "r", "rscript"].includes(name) &&
				/^-[ep].+/.test(option)
			) {
				return { code: args[index].slice(2), opaque: false }
			}
			if (/^python/.test(name) && /^-c.+/.test(option)) return { code: args[index].slice(2), opaque: false }
			const match = option.match(evalOption)
			if (match) return { code: match[1] ?? args.slice(index + 1).join(" "), opaque: false }
		}
	}
	return undefined
}

function launcherChild(tokens: string[]): string[] | undefined {
	const name = executableName(tokens[0] ?? "")
	if (["npm", "pnpm", "yarn", "bun", "uv", "pipx"].includes(name)) {
		if (!["exec", "dlx", "run", "runx", "x"].includes(tokens[1]?.toLowerCase() ?? "")) return undefined
		let index = 2
		while (tokens[index]?.startsWith("-")) {
			if (tokens[index] === "--") {
				index++
				break
			}
			index += ["-p", "--package", "-w", "--workspace"].includes(tokens[index].toLowerCase()) ? 2 : 1
		}
		return tokens.slice(index)
	}
	if (!TRANSPARENT_LAUNCHERS.has(name)) return undefined
	let index = 1
	while (index < tokens.length) {
		const token = tokens[index]
		if (token === "--") {
			index++
			break
		}
		if (optionConsumesValue(name, token.toLowerCase())) {
			index += 2
			continue
		}
		if (token.startsWith("-")) {
			index++
			continue
		}
		if (name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
			index++
			continue
		}
		break
	}
	if (name === "timeout") index++
	return tokens.slice(index)
}

function isUnsafePersistentCommandTokens(tokens: string[]): boolean {
	const name = executableName(tokens[0] ?? "")
	if (
		TRANSPARENT_LAUNCHERS.has(name) ||
		OPAQUE_LAUNCHERS.has(name) ||
		EVALUATORS.has(name) ||
		SCRIPT_LOADERS.has(name)
	) {
		return true
	}
	if (SHELLS.has(name)) return true
	if (launcherChild(tokens)) return true
	if (["npm", "pnpm", "yarn", "bun", "uv", "pipx"].includes(name) && tokens.length < 2) return true
	if (name === "deno" && tokens[1]?.toLowerCase() === "run" && tokens.length < 3) return true
	if (isScriptInterpreter(name)) return tokens.length < 2 || tokens[1].startsWith("-") || !!inlineCode(tokens)
	return false
}

/** A saved prefix can grow new arguments, so do not offer one for command dispatchers or inline evaluators. */
export function isUnsafePersistentCommandPrefix(command: string): boolean {
	const tokens = tokenizeShellCommands(command)[0] ?? []
	// The prefix owner admits only static words. Preserve Windows separators that
	// POSIX parsing consumes; original spelling can reject a grant, never create one.
	return isUnsafePersistentCommandTokens(tokens) || isUnsafePersistentCommandTokens(command.trim().split(/[ \t]+/))
}

/** Expose nested commands to deny rules and detect code that the shell supplies at runtime. */
export function analyzeIndirectCommandExecution(
	command: string,
	platform?: ShellCommandPlatform,
): {
	commands: string[]
	tokenCommands: ShellCommandToken[][]
	dynamicCode: boolean
	resolved: boolean
} {
	const commands: string[] = []
	const tokenCommands: ShellCommandToken[][] = []
	const pending: Array<{ tokens: ShellCommandToken[]; depth: number }> = []
	let dynamicCode = false
	let resolved = true

	const enqueue = (source: string, depth: number) => {
		const parsed = analyzeShellCommandTokens(source, platform)
		resolved &&= !parsed.malformed && !parsed.unsupportedSyntax && !parsed.ambiguousSyntax
		for (const group of parsed.commands) {
			// A shared bounded queue/depth covers launcher and inline-shell nesting without evaluating any code.
			if (pending.length >= 64) {
				resolved = false
				break
			}
			pending.push({ tokens: shellCommandArgumentTokens(group.tokens), depth })
		}
	}

	enqueue(command, 0)
	for (let cursor = 0; cursor < pending.length; cursor++) {
		let details = pending[cursor].tokens
		let depth = pending[cursor].depth
		let tokens = details.map(({ value }) => value)
		while (tokens.length) {
			const name = executableName(tokens[0])
			if (name === "env") {
				let splitIndex = -1
				for (let index = 1; index < tokens.length; index++) {
					const option = tokens[index]
					if (option === "--" || (!option.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(option))) break
					const longOption = option.split("=")[0]
					if (
						/^-[^-]*S/.test(option) ||
						(option.startsWith("--") && longOption.length > 2 && "--split-string".startsWith(longOption))
					) {
						splitIndex = index
						break
					}
					if (optionConsumesValue(name, option.toLowerCase())) index++
				}
				if (splitIndex !== -1) {
					const option = tokens[splitIndex]
					const equals = option.indexOf("=")
					const attached = option.startsWith("--")
						? equals === -1
							? undefined
							: option.slice(equals + 1)
						: option.slice(option.indexOf("S") + 1) || undefined
					const splitSource = attached ?? tokens[splitIndex + 1]
					if (splitSource) commands.push(splitSource)
					// GNU env's split-string escapes/expansions differ from shell argv; only known denials can be inferred.
					resolved = false
					break
				}
			}
			const code = inlineCode(tokens)
			if (
				(isScriptInterpreter(name) ||
					SHELLS.has(name) ||
					["npm", "pnpm", "yarn", "uv", "pipx"].includes(name)) &&
				tokens[1] &&
				DYNAMIC_CODE_OPERAND.test(tokens[1])
			) {
				dynamicCode = true
			}
			if (name === "deno" && tokens[1]?.toLowerCase() === "run" && DYNAMIC_CODE_OPERAND.test(tokens[2] ?? "")) {
				dynamicCode = true
			}
			if (code) {
				if (code.code) commands.push(code.code)
				dynamicCode ||= code.opaque || DYNAMIC_CODE_OPERAND.test(code.code)
				if (depth >= 8 || code.opaque || (!SHELLS.has(name) && !EVALUATORS.has(name))) {
					// JavaScript/Python/etc are not shell argv. Finite deny policies need review for opaque inline code.
					resolved = false
				} else if (code.code) enqueue(code.code, depth + 1)
				else resolved = false
				break
			}
			if (OPAQUE_LAUNCHERS.has(name)) {
				resolved = false
				break
			}
			const child = launcherChild(tokens)
			if (!child) break
			if (!child.length || depth >= 8) {
				resolved = false
				break
			}
			// Preserve argument boundaries and expansion evidence through transparent launcher nesting.
			details = details.slice(tokens.length - child.length)
			tokenCommands.push(details)
			dynamicCode ||= details[0]?.dynamic === true
			tokens = child
			depth++
		}
	}
	return { commands, tokenCommands, dynamicCode, resolved }
}
