import path from "path"
import fs from "fs/promises"

import { isCommandDeniedByPolicy, isPathAllowed, type ToolPolicySnapshot } from "../agent/ToolPolicy"
import type { PreparedCommandRead, ToolExecutionContext } from "./ToolRegistry"
import { canonicalRgInspection, tokenizeSingleCommand } from "./CommandExploration"
import { executeCommandTool, type ExecuteCommandParams } from "./ExecuteCommandTool"
import { ToolReadDeniedError, type ToolCallbacks } from "./BaseTool"
import { resolveRipgrepLaunchEnvironment } from "../../integrations/terminal/ripgrepEnvironment"
import { unescapeHtmlEntities } from "../../utils/text-normalization"
import { isPathWithinRoot } from "./pathSafety"
const GIT_OPTIONS: Readonly<Record<string, RegExp>> = {
	status: /^(?:--short|-s|--branch|-b|--porcelain(?:=(?:1|2|v1|v2))?|-z|--untracked-files(?:=(?:no|normal|all))?)$/,
	diff: /^(?:--stat|--numstat|--shortstat|--name-only|--name-status|--patch|-p|--no-patch|-s|--raw|--cached|--staged|--check|--exit-code|--quiet|--no-ext-diff|--no-textconv|--color=never|--unified=\d+|-U\d+|--ignore-space-at-eol|--ignore-all-space|-w)$/,
	log: /^(?:--oneline|--stat|--name-only|--name-status|--no-patch|-s|--patch|-p|--no-ext-diff|--no-textconv|--no-show-signature|--max-count=\d+|-n\d+|--all|--reverse|--first-parent|--no-merges|--merges)$/,
	show: /^(?:--oneline|--stat|--name-only|--name-status|--no-patch|-s|--patch|-p|--no-ext-diff|--no-textconv|--no-show-signature|--unified=\d+|-U\d+)$/,
	"ls-files": /^(?:--cached|-c|--stage|-s|--others|-o|--modified|-m|--deleted|-d|--exclude-standard|-z)$/,
	"ls-tree": /^(?:--name-only|--name-status|--long|-l|-r|-t|-d|-z)$/,
	"rev-parse": /^(?:--verify|--short(?:=\d+)?|--show-toplevel|--is-inside-work-tree|--abbrev-ref)$/,
}

export interface CommandReadInvocation {
	executable: "git" | "rg"
	args: string[]
}

/** Positive argument allow-list. Progress observation alone never authorizes concurrency. */
export async function classifyCommandRead(
	command: string,
	root: string,
	cwd: string,
): Promise<CommandReadInvocation | undefined> {
	const tokens = tokenizeSingleCommand(command)
	if (!tokens || !/^(?:git|rg)(?:\.exe)?$/.test(tokens[0])) return undefined
	const executable = tokens[0].replace(/\.exe$/, "") as "git" | "rg"
	if (executable === "rg") {
		if (!(await canonicalRgInspection(tokens.slice(1), root, cwd))) return undefined
		return { executable, args: ["--no-config", ...tokens.slice(1)] }
	}
	let start = 1
	if (tokens[start] === "--no-pager" || tokens[start] === "-P") start++
	const subcommand = tokens[start++]
	const allowed = GIT_OPTIONS[subcommand]
	if (!allowed) return undefined
	const args = tokens.slice(start)
	let pathsOnly = false
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (!pathsOnly && arg === "--") {
			pathsOnly = true
			continue
		}
		if (!pathsOnly && arg.startsWith("-")) {
			if (subcommand === "log" && arg === "-n" && /^\d+$/.test(args[index + 1] ?? "")) {
				index++
				continue
			}
			if (!allowed.test(arg)) return undefined
		} else if (!arg || path.isAbsolute(arg) || arg.split("/").includes("..")) return undefined
	}
	return {
		executable,
		args: [
			"--no-pager",
			"--no-optional-locks",
			"--no-lazy-fetch",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"core.untrackedCache=false",
			"-c",
			"submodule.recurse=false",
			"-c",
			"format.pretty=medium",
			subcommand,
			...(["diff", "log", "show"].includes(subcommand)
				? ["--no-ext-diff", "--no-textconv", "--submodule=short"]
				: []),
			...(["log", "show"].includes(subcommand) ? ["--no-show-signature"] : []),
			...args,
		],
	}
}

interface CapturedRgRead {
	readonly scope: string
	readonly command: string
	readonly executable: string
	readonly args: readonly string[]
	readonly env: Readonly<Record<string, string>>
	revalidate(): Promise<void>
}

function explicitFileTargets(args: readonly string[]): readonly string[] | undefined {
	const flags = new Set([
		"--no-config",
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
		"--no-messages",
		"-F",
		"--fixed-strings",
		"-i",
		"--ignore-case",
		"-s",
		"--case-sensitive",
		"-S",
		"--smart-case",
		"-w",
		"--word-regexp",
		"-x",
		"--line-regexp",
		"-v",
		"--invert-match",
		"-l",
		"--files-with-matches",
		"--files-without-match",
		"-c",
		"--count",
		"--count-matches",
	])
	let explicitPattern = false
	let optionsEnded = false
	const positionals: string[] = []
	for (let index = 0; index < args.length; index++) {
		const value = args[index]
		if (!optionsEnded && value === "--") {
			optionsEnded = true
			continue
		}
		if (!optionsEnded && (value === "-e" || value === "--regexp")) {
			if (args[++index] === undefined) return undefined
			explicitPattern = true
			continue
		}
		if (!optionsEnded && value.startsWith("-")) {
			if (!flags.has(value)) return undefined
			continue
		}
		positionals.push(value)
	}
	// rg accepts -e after positional files. Decide their role only after every
	// regexp option was consumed, so an earlier ignored file cannot disappear.
	const targets = explicitPattern ? positionals : positionals.slice(1)
	return targets.length > 0 && targets.length <= 16 && !targets.includes("-") ? targets : undefined
}

function launchEnvironment(): Record<string, string> | undefined {
	const env: Record<string, string> = {}
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue
		// These settings can execute injected code or change rg configuration.
		// Falling back preserves ordinary intent instead of silently stripping it.
		if (value && /^(?:LD_|DYLD_|RIPGREP_CONFIG_PATH$)/i.test(key)) return undefined
		env[key] = value
	}
	return env
}

async function readIgnoreContent(root: string): Promise<string | undefined> {
	try {
		const target = path.join(root, ".alphaignore")
		if ((await fs.stat(target)).size > 1_048_576) throw new Error("Ignore configuration requires ordinary handling")
		return await fs.readFile(target, "utf8")
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
		throw error
	}
}

async function captureRgRead(
	task: ToolExecutionContext["task"],
	args: Readonly<Record<string, unknown>>,
	policy: ToolPolicySnapshot,
): Promise<CapturedRgRead | undefined> {
	// Historical command/timeout spellings retain their configured transport.
	if (
		typeof args.cmd !== "string" ||
		args.tty === true ||
		args.shell != null ||
		args.login != null ||
		args.verification != null
	)
		return undefined
	if (task.abort || !policy.allowedTools.includes("exec_command") || policy.disabledTools.includes("exec_command"))
		return undefined
	const command = unescapeHtmlEntities(args.cmd)
	const taskId = task.taskId
	if (isCommandDeniedByPolicy(policy, command)) return undefined
	const environment = launchEnvironment()
	if (!environment) return undefined
	const environmentIdentity = JSON.stringify(environment)
	const root = await fs.realpath(task.cwd)
	const requestedCwd = typeof args.workdir === "string" ? args.workdir : typeof args.cwd === "string" ? args.cwd : "."
	const cwd = await fs.realpath(path.resolve(task.cwd, requestedCwd))
	if (!isPathWithinRoot(root, cwd) || !isPathAllowed(policy, cwd, root)) return undefined
	const roots = await Promise.all(policy.execution.workspaceRoots.map((directory) => fs.realpath(directory)))
	if (roots.length === 0 || !roots.some((directory) => isPathWithinRoot(directory, cwd))) return undefined
	const invocation = await classifyCommandRead(command, root, cwd)
	if (!invocation || invocation.executable !== "rg") return undefined
	const targetArguments = explicitFileTargets(invocation.args)
	if (!targetArguments) return undefined
	const semantics = await canonicalRgInspection(invocation.args, root, cwd)
	if (!semantics) return undefined
	const ignore = task.alphaIgnoreController
	if (ignore?.validateCommand(command)) return undefined
	const ignoreContent = ignore?.alphaIgnoreContent
	const diskIgnoreContent = await readIgnoreContent(root)
	if (diskIgnoreContent !== ignoreContent) return undefined
	if (ignoreContent?.trim() && typeof ignore?.validateAccess !== "function") return undefined
	const protectedFiles = task.alphaProtectedController
	const captureTargets = async () => {
		const targets: Array<readonly [string, string, number, number]> = []
		for (const argument of targetArguments) {
			const lexical = path.resolve(cwd, argument)
			const real = await fs.realpath(lexical)
			const stat = await fs.stat(real)
			if (
				!stat.isFile() ||
				!isPathWithinRoot(root, lexical) ||
				!isPathWithinRoot(root, real) ||
				!isPathAllowed(policy, lexical, root) ||
				!isPathAllowed(policy, real, root) ||
				ignore?.validateAccess?.(lexical) === false ||
				ignore?.validateAccess?.(real) === false ||
				protectedFiles?.isWriteProtected(lexical) ||
				protectedFiles?.isWriteProtected(real)
			) {
				throw new ToolReadDeniedError("Prepared command file scope requires ordinary policy handling")
			}
			targets.push([lexical, real, stat.dev, stat.ino])
		}
		return targets
	}
	const targetsIdentity = JSON.stringify(await captureTargets())
	const policyIdentity = JSON.stringify(policy)
	const { resolution, overlay } = await resolveRipgrepLaunchEnvironment(environment)
	if (!resolution || resolution.source === "system" || !path.isAbsolute(resolution.path)) return undefined
	const executable = await fs.realpath(resolution.path)
	if (isPathWithinRoot(root, executable) || roots.some((directory) => isPathWithinRoot(directory, executable)))
		return undefined
	const executableStat = await fs.stat(executable)
	if (!executableStat.isFile()) return undefined
	const binaryIdentity = JSON.stringify([
		executableStat.dev,
		executableStat.ino,
		executableStat.size,
		executableStat.mtimeMs,
		executableStat.ctimeMs,
	])
	const inspectionIdentity = JSON.stringify(semantics)
	const env = Object.freeze({ ...environment, ...overlay, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" })
	const provider = task.providerRef.deref()
	if (!provider) return undefined
	const mode = typeof task.getTaskMode === "function" ? await task.getTaskMode() : "code"
	return Object.freeze({
		scope: cwd,
		command,
		executable,
		args: Object.freeze([...invocation.args]),
		env,
		revalidate: async () => {
			const currentEnvironment = launchEnvironment()
			const currentMode = typeof task.getTaskMode === "function" ? await task.getTaskMode() : "code"
			const currentIgnoreContent = await readIgnoreContent(root)
			const currentLaunch = currentEnvironment
				? await resolveRipgrepLaunchEnvironment(currentEnvironment)
				: undefined
			if (
				currentMode !== mode ||
				JSON.stringify(policy) !== policyIdentity ||
				task.alphaIgnoreController !== ignore ||
				ignore?.alphaIgnoreContent !== ignoreContent ||
				currentIgnoreContent !== diskIgnoreContent ||
				task.alphaProtectedController !== protectedFiles ||
				ignore?.validateCommand(command)
			) {
				throw new ToolReadDeniedError("Prepared command policy changed before launch")
			}
			if (
				task.abort ||
				task.taskId !== taskId ||
				JSON.stringify(currentEnvironment) !== environmentIdentity ||
				task.providerRef.deref() !== provider ||
				!currentLaunch?.resolution ||
				currentLaunch.resolution.path !== resolution.path ||
				currentLaunch.resolution.source !== resolution.source ||
				JSON.stringify(currentLaunch.overlay) !== JSON.stringify(overlay)
			) {
				throw new Error("Prepared command authority or environment changed before launch")
			}
			if (await task.getTaskCommandDenialReason?.(command, requestedCwd))
				throw new ToolReadDeniedError("Prepared command authority was revoked")
			const [currentRoot, currentCwd, currentExecutable, currentRoots] = await Promise.all([
				fs.realpath(task.cwd),
				fs.realpath(path.resolve(task.cwd, requestedCwd)),
				fs.realpath(resolution.path),
				Promise.all(policy.execution.workspaceRoots.map((directory) => fs.realpath(directory))),
			])
			const currentStat = await fs.stat(currentExecutable)
			const currentIdentity = JSON.stringify([
				currentStat.dev,
				currentStat.ino,
				currentStat.size,
				currentStat.mtimeMs,
				currentStat.ctimeMs,
			])
			const currentInspection = await canonicalRgInspection(invocation.args, currentRoot, currentCwd)
			const currentTargetsIdentity = JSON.stringify(await captureTargets())
			if (
				currentRoot !== root ||
				currentCwd !== cwd ||
				currentExecutable !== executable ||
				currentIdentity !== binaryIdentity ||
				JSON.stringify(currentRoots) !== JSON.stringify(roots) ||
				JSON.stringify(currentInspection) !== inspectionIdentity ||
				currentTargetsIdentity !== targetsIdentity
			) {
				throw new Error("Prepared command executable or workspace scope changed before launch")
			}
		},
	})
}

/** Readiness never approves or launches; unsupported commands retain the ordinary executor. */
export async function isParallelCommandReadReady(
	task: ToolExecutionContext["task"],
	args: Readonly<Record<string, unknown>>,
	policy: ToolPolicySnapshot,
): Promise<boolean> {
	try {
		return (await captureRgRead(task, args, policy)) !== undefined
	} catch {
		return false
	}
}

export async function prepareParallelCommand(
	context: ToolExecutionContext,
	policy: ToolPolicySnapshot,
	invocation?: { readonly params: ExecuteCommandParams; readonly callbacks: ToolCallbacks },
): Promise<PreparedCommandRead | undefined> {
	if (!invocation) return undefined
	const args = context.call.nativeArgs
	if (!args || typeof args !== "object") return undefined
	let captured: CapturedRgRead | undefined
	try {
		captured = await captureRgRead(context.task, { ...args }, policy)
	} catch {
		return undefined
	}
	if (!captured || context.signal?.aborted) return undefined
	const approved = await executeCommandTool.prepareApprovedRead(
		invocation.params,
		context.task,
		invocation.callbacks,
		{
			directCommand: { executable: captured.executable, args: captured.args, env: captured.env },
			beforeLaunch: captured.revalidate,
		},
	)
	return approved
		? {
				scope: captured.scope,
				run: approved.run,
				dispose: approved.dispose,
				commit: approved.commit,
				settleRejectedRun: approved.settleRejectedRun,
			}
		: undefined
}
