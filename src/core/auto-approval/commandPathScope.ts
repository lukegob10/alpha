import os from "node:os"
import path from "node:path"
import { isPathWithinRoot } from "../tools/pathSafety"
import { analyzeShellCommands, tokenizeShellCommandPaths } from "./shellCommand"

export interface CommandPathScope {
	/** Literal destinations, also captured for the scheduler's post-approval identity check. */
	writePaths: string[]
	outsidePaths: string[]
	unresolvedWrite: boolean
}

const WRITE_COMMANDS = new Set([
	"rm",
	"rmdir",
	"rd",
	"del",
	"erase",
	"remove-item",
	"ri",
	"mkdir",
	"md",
	"touch",
	"new-item",
	"ni",
	"set-content",
	"sc",
	"add-content",
	"ac",
	"clear-content",
	"clc",
	"out-file",
	"tee",
	"tee-object",
	"chmod",
	"chown",
	"truncate",
	"mv",
	"move",
	"move-item",
	"mi",
	"ren",
	"rename",
	"rename-item",
	"rni",
])
const COPY_COMMANDS = new Set(["cp", "copy", "copy-item", "cpi", "xcopy", "robocopy"])
const READ_COMMANDS = new Set([
	"pwd",
	"get-location",
	"echo",
	"write-output",
	"write-host",
	"printf",
	"cat",
	"type",
	"get-content",
	"ls",
	"dir",
	"get-childitem",
	"gci",
	"rg",
	"grep",
	"head",
	"tail",
	"wc",
	"stat",
	"test",
	"test-path",
	"get-item",
	"get-itemproperty",
	"get-command",
	"where",
	"which",
	"whoami",
	"hostname",
	"date",
])
const DIRECTORY_COMMANDS = new Set(["cd", "chdir", "set-location", "sl", "pushd", "push-location"])
const PATH_OPTIONS = new Set([
	"-path",
	"-literalpath",
	"-filepath",
	"-destination",
	"-targetdirectory",
	"--target-directory",
	"-t",
])
const VALUE_OPTIONS = new Set([
	"-value",
	"-encoding",
	"-filter",
	"-include",
	"-exclude",
	"-itemtype",
	"-type",
	"-stream",
	"-erroraction",
	"-warningaction",
	"-informationaction",
	"-ea",
	"-ev",
	"-outvariable",
	"-ov",
])
const OUTPUT_OPTIONS = new Set([
	"--output",
	"--out",
	"--out-dir",
	"--outdir",
	"--output-dir",
	"--output-directory",
	"-outfile",
	"-out-file",
])
const MAX_LENGTH = 65_536
const MAX_COMMANDS = 256

function executableName(token: string): string {
	return token
		.replace(/\\/g, "/")
		.split("/")
		.pop()!
		.toLowerCase()
		.replace(/\.(?:exe|cmd|bat)$/, "")
}

/**
 * A bounded preflight for common command destinations, not an OS sandbox or a script interpreter.
 * Unknown programs/scripts retain the user's command approval; unresolved destinations of recognized writes ask.
 */
export function assessCommandPaths(command: string, cwd: string, roots: readonly string[]): CommandPathScope {
	const writes = new Set<string>()
	let unresolvedWrite = false
	let commandCount = 0
	const environment = new Map(Object.entries(process.env).map(([key, value]) => [key.toUpperCase(), value]))
	const resolve = (value: string, directory: string | undefined): string | undefined => {
		if (!directory || !value) return undefined
		let missing = false
		const expanded = value
			.replace(/^~(?=$|[\\/])/, os.homedir())
			.replace(/\$\{(?:env:)?([\w]+)\}|\$(?:env:)?([\w]+)|%([\w]+)%/gi, (_match, a, b, c) => {
				const name = a || b || c
				const replacement = name.toUpperCase() === "HOME" ? os.homedir() : environment.get(name.toUpperCase())
				if (replacement === undefined) missing = true
				return replacement ?? ""
			})
		if (missing || /[$`{}\0]/.test(expanded)) return undefined
		if (/^(?:https?|ssh|git):\/\//i.test(expanded)) return undefined
		return path.resolve(directory, expanded)
	}
	const record = (value: string | undefined, directory: string | undefined) => {
		if (writes.size >= 128) {
			unresolvedWrite = true
			return
		}
		if (value && /^(?:nul|\/dev\/null|\$null)$/i.test(value)) return
		const resolved = value === undefined ? undefined : resolve(value, directory)
		if (resolved) writes.add(resolved)
		else unresolvedWrite = true
	}
	const inspect = (source: string, initialCwd: string | undefined, depth: number) => {
		if (source.length > MAX_LENGTH || depth > 4) {
			unresolvedWrite = true
			return
		}
		let directory = initialCwd
		const directoryStack: Array<string | undefined> = []
		const substitutions = analyzeShellCommands(source)
		for (const inner of substitutions.commands) inspect(inner, directory, depth + 1)
		for (const rawTokens of tokenizeShellCommandPaths(source)) {
			if (++commandCount > MAX_COMMANDS) {
				unresolvedWrite = true
				return
			}
			const tokens: string[] = []
			for (let index = 0; index < rawTokens.length; index++) {
				const { value: token, redirection } = rawTokens[index]
				if (!redirection) tokens.push(token)
				else if (/^(?:>|>>|>\|)$/.test(token)) record(rawTokens[++index]?.value, directory)
				else if (/^(?:<|<<)$/.test(token)) index++
			}
			while (/^[\w]+=.*/.test(tokens[0] ?? "")) tokens.shift()
			if (!tokens.length) continue
			let name = executableName(tokens[0])
			// Common transparent launchers retain the inner command's destination checks.
			if (["call", "command", "exec", "env", "sudo"].includes(name)) {
				tokens.shift()
				while (tokens[0]?.startsWith("-") || /^[\w]+=/.test(tokens[0] ?? "")) tokens.shift()
				if (!tokens.length) continue
				name = executableName(tokens[0])
			}
			const args = tokens.slice(1)
			const lower = args.map((arg) => arg.toLowerCase())
			if (["powershell", "pwsh", "bash", "sh", "zsh", "cmd"].includes(name)) {
				const encoded = lower.findIndex((arg) => ["-encodedcommand", "-enc", "-ec"].includes(arg))
				const nested = lower.findIndex((arg) => ["-command", "-c", "-lc", "/c", "/k"].includes(arg))
				if (encoded >= 0 && args[encoded + 1]) {
					inspect(Buffer.from(args[encoded + 1], "base64").toString("utf16le"), directory, depth + 1)
					continue
				}
				if (nested >= 0) {
					inspect(args.slice(nested + 1).join(" "), directory, depth + 1)
					continue
				}
			}
			if (DIRECTORY_COMMANDS.has(name)) {
				if (name === "pushd" || name === "push-location") directoryStack.push(directory)
				const target = args.find((arg) => !arg.startsWith("-") && arg.toLowerCase() !== "/d")
				directory = resolve(target ?? "~", directory)
				continue
			}
			if (name === "popd" || name === "pop-location") {
				directory = directoryStack.pop()
				continue
			}
			let commandCwd = directory
			for (let index = 0; index < args.length; index++) {
				const option = lower[index].split("=")[0]
				if (
					(["git", "make", "tar"].includes(name) && args[index] === "-C") ||
					(["npm", "pnpm", "yarn"].includes(name) && ["--dir", "--cwd", "--prefix", "-c"].includes(option))
				)
					commandCwd = resolve(
						args[index].includes("=") ? args[index].slice(args[index].indexOf("=") + 1) : args[++index],
						commandCwd,
					)
			}
			let gitSubcommand: string | undefined
			if (name === "git") {
				for (let index = 0; index < args.length; index++) {
					if (["-C", "-c", "--git-dir", "--work-tree"].includes(args[index])) {
						index++
						continue
					}
					if (!args[index].startsWith("-")) {
						gitSubcommand = lower[index]
						break
					}
				}
			}
			const gitRead =
				gitSubcommand !== undefined &&
				["status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree"].includes(gitSubcommand)
			if (name === "git" && !gitRead) {
				for (let index = 0; index < args.length; index++) {
					if (/^--(?:git-dir|work-tree)(?:=|$)/.test(args[index]))
						record(
							args[index].includes("=") ? args[index].slice(args[index].indexOf("=") + 1) : args[++index],
							commandCwd,
						)
				}
				if (gitSubcommand === "clone") {
					const cloneArgs = args.slice(lower.indexOf("clone") + 1).filter((arg) => !arg.startsWith("-"))
					if (cloneArgs.length >= 2) record(cloneArgs.at(-1), commandCwd)
				}
				if (gitSubcommand === "worktree" && lower.includes("add")) {
					const addArgs = args.slice(lower.indexOf("add") + 1)
					const destination = addArgs.find(
						(arg, index) => !arg.startsWith("-") && !["-b", "-B"].includes(addArgs[index - 1]),
					)
					record(destination, commandCwd)
				}
			}
			if (!READ_COMMANDS.has(name) && !gitRead) {
				if (!commandCwd) unresolvedWrite = true
				else if (!roots.some((root) => isPathWithinRoot(root, commandCwd))) writes.add(commandCwd)
			}
			const operands: string[] = []
			let namedDestination = false
			for (let index = 0; index < args.length; index++) {
				const option = lower[index].split(/[=:]/)[0]
				const optionValue = () => {
					const separator = args[index].search(/[=:]/)
					return separator >= 0 ? args[index].slice(separator + 1) : args[++index]
				}
				const output =
					OUTPUT_OPTIONS.has(option) || (option === "-o" && ["curl", "wget", "tsc", "esbuild"].includes(name))
				if (output || ((WRITE_COMMANDS.has(name) || COPY_COMMANDS.has(name)) && PATH_OPTIONS.has(option))) {
					const value = optionValue()
					if (
						!COPY_COMMANDS.has(name) ||
						output ||
						["-destination", "--target-directory", "-t"].includes(option)
					) {
						record(value, commandCwd)
						namedDestination = true
					}
					continue
				}
				if (VALUE_OPTIONS.has(option)) {
					optionValue()
					continue
				}
				if (
					args[index].startsWith("-") ||
					(process.platform === "win32" && /^\/[a-z](?::.*)?$/i.test(args[index]))
				)
					continue
				operands.push(args[index])
			}
			if (COPY_COMMANDS.has(name)) {
				if (!namedDestination) record(name === "robocopy" ? operands[1] : (operands.at(-1) ?? "."), commandCwd)
			} else if (WRITE_COMMANDS.has(name)) {
				// Content/mode arguments are data. Their first positional argument is the path.
				const paths = ["set-content", "sc", "add-content", "ac", "out-file", "new-item", "ni"].includes(name)
					? operands.slice(0, namedDestination ? 0 : 1)
					: ["chmod", "chown"].includes(name)
						? operands.slice(1)
						: operands
				for (const operand of paths) record(operand, commandCwd)
				if (!paths.length && !namedDestination && !["tee", "tee-object"].includes(name)) unresolvedWrite = true
			}
		}
	}
	inspect(command, cwd, 0)
	return {
		writePaths: [...writes],
		outsidePaths: [...writes].filter((candidate) => !roots.some((root) => isPathWithinRoot(root, candidate))),
		unresolvedWrite,
	}
}
