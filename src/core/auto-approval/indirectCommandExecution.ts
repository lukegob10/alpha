import { containsDynamicExecutable, tokenizeShellCommands } from "./shellCommand"

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
const OPAQUE_LAUNCHERS = new Set(["xargs", "start"])
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
		(name === "env" && ["-u", "--unset", "-c", "--chdir"].includes(option)) ||
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

/** A saved prefix can grow new arguments, so do not offer one for command dispatchers or inline evaluators. */
export function isUnsafePersistentCommandPrefix(command: string): boolean {
	const tokens = tokenizeShellCommands(command)[0] ?? []
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

/** Expose nested commands to deny rules and detect code that the shell supplies at runtime. */
export function analyzeIndirectCommandExecution(command: string): {
	commands: string[]
	dynamicCode: boolean
	resolved: boolean
} {
	const commands: string[] = []
	let dynamicCode = false
	let resolved = true
	for (const group of tokenizeShellCommands(command)) {
		let tokens = group
		for (let depth = 0; depth < 8 && tokens.length; depth++) {
			const name = executableName(tokens[0])
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
				break
			}
			if (OPAQUE_LAUNCHERS.has(name)) {
				resolved = false
				break
			}
			const child = launcherChild(tokens)
			if (!child) break
			if (!child.length) {
				resolved = false
				break
			}
			commands.push(child.join(" "))
			dynamicCode ||= containsDynamicExecutable(child.join(" "))
			tokens = child
		}
	}
	return { commands, dynamicCode, resolved }
}
