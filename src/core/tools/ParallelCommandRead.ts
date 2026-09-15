import fs from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"
import { execa } from "execa"

import type { CommandExecutionStatus } from "@alpha-code/types"
import { DEFAULT_TERMINAL_OUTPUT_PREVIEW_SIZE } from "@alpha-code/types"
import { OutputInterceptor } from "../../integrations/terminal/OutputInterceptor"
import { prepareSandboxedCommand } from "../../integrations/terminal/CommandSandbox"
import { unescapeHtmlEntities } from "../../utils/text-normalization"
import { getTaskDirectoryPath } from "../../utils/storage"
import { ToolReadDeniedError } from "./BaseTool"
import type { PreparedCommandRead, ToolExecutionContext } from "./ToolRegistry"
import { canonicalRgInspection, getTrustedCommandExploration, tokenizeSingleCommand } from "./CommandExploration"
import { isPathWithinRoot } from "./pathSafety"
import { isToolAllowedForMode } from "./validateToolUse"
import { getCommandDecision } from "../auto-approval/commands"
import { isCommandDeniedByPolicy, isPathAllowed, isToolAllowed, type ToolPolicySnapshot } from "../agent/ToolPolicy"
import { createToolFailure } from "./ToolFailure"

const MAX_OUTPUT_BYTES = 1_048_576
const MAX_READ_TIME_MS = 60_000
const gitIsolationSupport = new Map<string, { identity: string; supported: boolean }>()
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

async function resolveExecutable(name: string, root: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
	const searchPath = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? ""
	for (const directory of searchPath.split(path.delimiter).slice(0, 128)) {
		if (!path.isAbsolute(directory)) continue
		try {
			const candidate = await fs.realpath(
				path.join(directory, process.platform === "win32" ? `${name}.exe` : name),
			)
			if (isPathWithinRoot(root, candidate)) return undefined
			if (!(await fs.stat(candidate)).isFile()) continue
			return candidate
		} catch {
			/* An unavailable PATH entry is not an executable candidate. */
		}
	}
	return undefined
}

/** Prepare serially through the scheduler's existing approval and durability boundaries. */
export async function prepareParallelCommand(
	{ task, call, callbacks, signal }: ToolExecutionContext,
	policy: ToolPolicySnapshot,
): Promise<PreparedCommandRead | undefined> {
	const args: Record<string, unknown> = { ...call.nativeArgs }
	if (
		call.name !== "execute_command" ||
		typeof args.command !== "string" ||
		task.taskKind !== "primary" ||
		args.verification != null ||
		!callbacks.toolCallId ||
		(args.cwd != null && typeof args.cwd !== "string") ||
		(args.timeout != null && (typeof args.timeout !== "number" || !Number.isFinite(args.timeout)))
	)
		return undefined
	const requestedCwd = typeof args.cwd === "string" ? args.cwd : "."
	const command = unescapeHtmlEntities(args.command)
	const root = await fs.realpath(task.cwd)
	const cwd = await fs.realpath(path.resolve(root, requestedCwd))
	if (!isPathWithinRoot(root, cwd) || !isPathAllowed(policy, cwd, root)) return undefined
	const invocation = await classifyCommandRead(command, root, cwd)
	if (!invocation) return undefined
	const env = { ...process.env }
	// Shell/profile configuration and injected Git configuration belong to the serial handler.
	if (env.RIPGREP_CONFIG_PATH || Object.keys(env).some((key) => /^GIT_/i.test(key))) return undefined
	if (invocation.executable === "git") {
		try {
			await fs.lstat(path.join(root, ".git"))
			// Nested submodule inspection may launch additional Git processes with its own configuration.
			await fs.lstat(path.join(root, ".gitmodules"))
			return undefined
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined
			try {
				await fs.lstat(path.join(root, ".git"))
			} catch {
				return undefined
			}
		}
	}
	const executable = await resolveExecutable(invocation.executable, root, env)
	if (!executable) return undefined
	const binaryStat = await fs.stat(executable)
	const binaryIdentity = `${binaryStat.size}:${binaryStat.mtimeMs}:${binaryStat.ctimeMs}`
	const cachedGitSupport = gitIsolationSupport.get(executable)
	if (invocation.executable === "git" && cachedGitSupport?.identity === binaryIdentity && !cachedGitSupport.supported)
		return undefined
	const ignore = task.rooIgnoreController
	const ignoreContent = ignore?.rooIgnoreContent
	const protectedController = task.rooProtectedController
	const mode = await task.getTaskMode()
	const provider = task.providerRef.deref()
	if (!provider || ignoreContent?.trim() || ignore?.validateCommand(command)) return undefined
	const state = provider.getValues()
	const previewSize = state.terminalOutputPreviewSize ?? DEFAULT_TERMINAL_OUTPUT_PREVIEW_SIZE
	const globalStoragePath = provider.context?.globalStorageUri?.fsPath
	const requestedTimeout = typeof args.timeout === "number" && args.timeout > 0 ? args.timeout * 1000 : 0
	const timeout = Math.min(
		MAX_READ_TIME_MS,
		callbacks.resolveCommandTimeoutMs?.(requestedTimeout, command) || requestedTimeout || MAX_READ_TIME_MS,
	)
	const assertAuthorized = async (activeSignal?: AbortSignal) => {
		activeSignal?.throwIfAborted()
		const current = provider.getValues()
		if (
			task.abort ||
			task.taskMode !== mode ||
			task.providerRef.deref() !== provider ||
			!isToolAllowedForMode("execute_command", task.taskMode, [], undefined, args) ||
			!isToolAllowed(policy, "execute_command") ||
			isCommandDeniedByPolicy(policy, command) ||
			current.disabledTools?.includes("execute_command") ||
			getCommandDecision(command, current.allowedCommands ?? [], current.deniedCommands ?? []) === "auto_deny" ||
			task.rooIgnoreController !== ignore ||
			ignore?.rooIgnoreContent !== ignoreContent ||
			task.rooProtectedController !== protectedController ||
			ignore?.validateCommand(command) ||
			(await fs.realpath(task.cwd)) !== root ||
			(await fs.realpath(path.resolve(root, requestedCwd))) !== cwd ||
			(await resolveExecutable(invocation.executable, root, process.env)) !== executable ||
			!(await classifyCommandRead(command, root, cwd))
		) {
			throw new ToolReadDeniedError("Command approval or read scope changed before execution.")
		}
		activeSignal?.throwIfAborted()
	}
	await assertAuthorized(signal)
	if (!(await callbacks.askApproval("command", command, args.cwd ? { text: cwd } : undefined))) return undefined
	// Approval feedback can append another message before the callback returns.
	let executionId: string | undefined
	for (let index = task.clineMessages.length - 1; index >= 0; index--) {
		const message = task.clineMessages[index]
		if (message.type === "ask" && message.ask === "command") {
			executionId = message.ts.toString()
			break
		}
	}
	await assertAuthorized(signal)
	if (!globalStoragePath && process.env.ROO_CLI_RUNTIME !== "1") return undefined
	const sandboxOptions =
		globalStoragePath && process.env.ROO_CLI_RUNTIME !== "1"
			? {
					storagePath: globalStoragePath,
					workspaceRoots: policy.execution.workspaceRoots.length ? policy.execution.workspaceRoots : [root],
					cwd,
					readOnly: true,
					signal,
				}
			: undefined
	const launch = sandboxOptions
		? await prepareSandboxedCommand(sandboxOptions, [executable, ...invocation.args])
		: undefined
	if (invocation.executable === "git" && cachedGitSupport?.identity !== binaryIdentity) {
		// Probe once per binary version, under this command's approval. Older Git
		// lacks --no-lazy-fetch and must retain the ordinary serial command path.
		const probeLaunch = sandboxOptions
			? await prepareSandboxedCommand(sandboxOptions, [executable, "--no-lazy-fetch", "--version"])
			: undefined
		probeLaunch?.assertScope()
		const probe = await execa(
			probeLaunch?.executable ?? executable,
			probeLaunch ? [...probeLaunch.args] : ["--no-lazy-fetch", "--version"],
			{
				cwd,
				env: { ...env, ...probeLaunch?.env },
				shell: false,
				stdin: "ignore",
				reject: false,
				windowsHide: true,
				maxBuffer: 4_096,
				timeout: Math.min(timeout, 5_000),
				cancelSignal: signal,
				forceKillAfterDelay: 1_000,
			},
		)
		signal?.throwIfAborted()
		if (probe.isCanceled || probe.timedOut)
			throw new ToolReadDeniedError("Git capability preflight did not complete.")
		if (gitIsolationSupport.size >= 16) gitIsolationSupport.delete(gitIsolationSupport.keys().next().value!)
		gitIsolationSupport.set(executable, { identity: binaryIdentity, supported: !probe.failed })
		if (probe.failed) return { scope: root, serialFallback: true }
	}
	// The process ID is separate from the approval message timestamp and never comes from model input.
	const outputId = randomUUID()
	const toolCallId = callbacks.toolCallId
	const storageDir = globalStoragePath
		? path.join(await getTaskDirectoryPath(globalStoragePath, task.taskId), "command-output")
		: undefined
	return {
		scope: root,
		run: async (resultCallbacks) => {
			await assertAuthorized(resultCallbacks.signal)
			const startedAt = Date.now()
			launch?.assertScope()
			const result = await execa(launch?.executable ?? executable, launch ? [...launch.args] : invocation.args, {
				cwd,
				env: {
					...env,
					...launch?.env,
					GIT_OPTIONAL_LOCKS: "0",
					GIT_NO_LAZY_FETCH: "1",
					GIT_TERMINAL_PROMPT: "0",
				},
				shell: false,
				stdin: "ignore",
				all: true,
				reject: false,
				windowsHide: true,
				maxBuffer: MAX_OUTPUT_BYTES,
				timeout,
				cancelSignal: resultCallbacks.signal,
				forceKillAfterDelay: 1_000,
			})
			const cancelled = result.isCanceled || resultCallbacks.signal?.aborted || task.abort
			const completedAt = Date.now()
			const status = cancelled ? "cancelled" : result.failed ? "error" : "success"
			const output = result.all || result.stderr || ""
			const trustedExploration =
				status === "success"
					? await getTrustedCommandExploration({
							command,
							workspaceRoot: root,
							cwd,
							executionStatus: "succeeded",
							exitCode: result.exitCode,
						})
					: undefined
			resultCallbacks.setResultMetadata?.({
				status,
				executionStatus: status,
				exitCode: result.exitCode,
				timedOut: result.timedOut,
				...(trustedExploration ? { trustedExploration } : {}),
				...(status !== "success"
					? {
							failure: createToolFailure({
								reason: cancelled ? "cancelled" : "execution_failed",
								scopeKind: "operation",
								scopeIdentity: ["execute_command", cwd, command],
								effectsStarted: "yes",
								outcome: "known",
								recovery: { kind: "repair" },
							}),
						}
					: {}),
			})
			const details =
				`Command: ${command}\nExit code: ${result.exitCode ?? "unavailable"}` +
				(result.timedOut ? "\nInspection timed out." : "") +
				(result.isMaxBuffer ? "\nInspection exceeded the 1 MiB output limit; narrow the command." : "") +
				(cancelled ? "\nCommand cancelled." : "")
			// Result collection is per call; shared command evidence and UI are published only after workers join.
			let preview = output
			let artifact = ""
			if (storageDir && output.length > 8_000) {
				const interceptor = new OutputInterceptor({
					executionId: outputId,
					taskId: task.taskId,
					command,
					storageDir,
					previewSize,
				})
				interceptor.write(output)
				const persisted = await interceptor.finalize()
				preview = persisted.preview
				if (persisted.artifactPath)
					artifact = `\nArtifact ID: ${path.basename(persisted.artifactPath)}; use read_command_output for full output.`
			}
			resultCallbacks.pushToolResult(`${details}${artifact}\n${preview}`)
			return async () => {
				await task.recordCommandInspectionResult({
					toolCallId,
					executionId: outputId,
					command,
					cwd,
					startedAt,
					completedAt,
					status:
						cancelled || task.abort
							? "cancelled"
							: result.timedOut
								? "timed_out"
								: result.failed
									? "failed"
									: "succeeded",
					exitCode: result.exitCode,
					signalName: result.signal,
				})
				if (executionId) {
					const update: CommandExecutionStatus = result.timedOut
						? { executionId, status: "timeout" }
						: { executionId, status: "exited", exitCode: result.exitCode }
					provider.postMessageToWebview({ type: "commandExecutionStatus", text: JSON.stringify(update) })
				}
				if (!task.abort && !resultCallbacks.signal?.aborted) {
					task.consecutiveMistakeCount = 0
					await task.say(
						"command_output",
						`${details}${artifact}\n${preview}`,
						undefined,
						undefined,
						undefined,
						undefined,
						{ isNonInteractive: true, commandExecutionId: executionId },
					)
				}
			}
		},
	}
}
