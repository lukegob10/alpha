import fs from "fs/promises"
import * as path from "path"
import { randomUUID } from "crypto"
import * as vscode from "vscode"

import delay from "delay"

import { CommandExecutionStatus, DEFAULT_TERMINAL_OUTPUT_PREVIEW_SIZE, PersistedCommandOutput } from "@alpha-code/types"
import { TelemetryService } from "@alpha-code/telemetry"

import { Task } from "../task/Task"

import { ToolUse, ToolResponse } from "../../shared/tools"
import { formatResponse } from "../prompts/responses"
import { defaultModeSlug, planModeSlug } from "../../shared/modes"
import { unescapeHtmlEntities } from "../../utils/text-normalization"
import {
	ExitCodeDetails,
	RooTerminal,
	RooTerminalCallbacks,
	RooTerminalProcess,
} from "../../integrations/terminal/types"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"
import { Terminal } from "../../integrations/terminal/Terminal"
import { OutputInterceptor } from "../../integrations/terminal/OutputInterceptor"
import { Package } from "../../shared/package"
import { t } from "../../i18n"
import { getTaskDirectoryPath } from "../../utils/storage"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import { isToolAllowedForMode } from "./validateToolUse"
import { redactTaskPrivatePaths } from "./taskPathPresentation"
import {
	captureWorkspaceMutationState,
	compareWorkspaceMutationState,
	type WorkspaceMutationState,
	type CommandVerificationDiagnostic,
} from "../agent/VerificationScope"
import { getTrustedCommandExploration } from "./CommandExploration"
import { createPytestVerificationReceipt } from "../agent/PytestVerificationReceipt"

class ShellIntegrationError extends Error {}

type CommandMutationReceiptPhase =
	| "capture-final-state"
	| "compare-final-state"
	| "launch-outcome-unknown"
	| "process-outcome-unknown"
	| "persist-final-receipt"
	| "release-pre-launch-reservation"
	| "release-no-op-receipt"
	| "complete-command-evidence"

export class CommandMutationReceiptError extends Error {
	override readonly name = "CommandMutationReceiptError"

	constructor(
		readonly phase: CommandMutationReceiptPhase,
		readonly observationUnknown: boolean,
		cause: unknown,
	) {
		const detail = cause instanceof Error ? cause.message : String(cause)
		super(`Command mutation receipt failed during ${phase}: ${detail.slice(0, 512)}`, { cause })
	}
}

type CommandExecutionLifecyclePhase = "admit-command" | "launch-command" | "await-command-process"

export class CommandExecutionLifecycleError extends Error {
	override readonly name = "CommandExecutionLifecycleError"

	constructor(
		readonly phase: CommandExecutionLifecyclePhase,
		cause: unknown,
	) {
		const detail = cause instanceof Error ? cause.message : String(cause)
		super(
			phase === "admit-command"
				? `Command was not started because pre-launch bookkeeping failed: ${detail.slice(0, 512)}`
				: `Command execution failed during ${phase}: ${detail.slice(0, 512)}`,
			{ cause },
		)
	}
}

export class CommandOutputBookkeepingError extends Error {
	override readonly name = "CommandOutputBookkeepingError"
	readonly phase = "finalize-command-output" as const

	constructor(cause: unknown) {
		const detail = cause instanceof Error ? cause.message : String(cause)
		super(`Command output bookkeeping failed during finalize-command-output: ${detail.slice(0, 512)}`, { cause })
	}
}

async function finalizeCommandMutationReceipt(
	task: Task,
	mutationBaseline: WorkspaceMutationState | undefined,
	physicalExecutionId: string,
	onIncomplete: () => void,
): Promise<void> {
	if (task.taskKind !== "primary") return

	let changes: Awaited<ReturnType<typeof compareWorkspaceMutationState>> | undefined
	if (mutationBaseline) {
		try {
			const after = await captureWorkspaceMutationState(task.cwd, mutationBaseline)
			changes = await compareWorkspaceMutationState(task.cwd, mutationBaseline, after)
		} catch {
			// A terminal process outcome is independent of our bounded diff observer.
			// Record incompleteness durably instead of turning a real exit into failure.
		}
	}

	if (changes && changes.changedPaths.length > 0) {
		try {
			const owner = task.providerRef.deref()
			if (!owner) throw new Error("Primary mutation ledger is unavailable")
			const receiptSettled = await owner.recordPrimaryMutation(task, changes.files, false, physicalExecutionId)
			if (!receiptSettled) {
				throw new Error("Primary mutation ledger did not affirm the final receipt")
			}
		} catch (error) {
			throw new CommandMutationReceiptError("persist-final-receipt", false, error)
		}
		return
	}

	try {
		const owner = task.providerRef.deref()
		if (!owner) throw new Error("Primary mutation ledger is unavailable")
		if (changes) {
			await owner.releasePrimaryMutation(task, physicalExecutionId)
		} else {
			onIncomplete()
			await owner.releasePrimaryMutation(task, physicalExecutionId, true)
		}
	} catch (error) {
		throw new CommandMutationReceiptError("release-no-op-receipt", false, error)
	}
}

interface ExecuteCommandParams {
	command: string
	cwd?: string | null
	timeout?: number | null
	verification?: { change_set_ids: string[] } | null
}

export function resolveAgentTimeoutMs(timeoutSeconds: number | null | undefined): number {
	const requestedAgentTimeout = typeof timeoutSeconds === "number" && timeoutSeconds > 0 ? timeoutSeconds * 1000 : 0

	// In CLI runtime, stdin harnesses expect command lifetime to be governed
	// solely by commandExecutionTimeout (user setting), not model-provided
	// background timeouts.
	return process.env.ROO_CLI_RUNTIME === "1" ? 0 : requestedAgentTimeout
}

export function isGitHubCliCommand(command: string): boolean {
	const normalized = command.trim().toLowerCase()
	return /(?:^|[;&|]\s*)(?:gh|github)\b/.test(normalized)
}

export class ExecuteCommandTool extends BaseTool<"execute_command"> {
	readonly name = "execute_command" as const

	async execute(params: ExecuteCommandParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { command, cwd: requestedCwd, timeout: timeoutSeconds, verification } = params
		const customCwd = requestedCwd ?? undefined
		const { handleError, pushToolResult, askApproval } = callbacks
		let commandEvidenceId: string | undefined

		try {
			if (!command) {
				task.consecutiveMistakeCount++
				task.recordToolError("execute_command")
				pushToolResult(await task.sayAndCreateMissingParamError("execute_command", "command"))
				return
			}

			const canonicalCommand = unescapeHtmlEntities(command)
			const executionId = task.lastMessageTs?.toString() ?? Date.now().toString()
			commandEvidenceId = callbacks.toolCallId ?? `${executionId}:legacy:${randomUUID()}`
			task.beginCommandExecution?.(commandEvidenceId, executionId, canonicalCommand, verification?.change_set_ids)

			if (isGitHubCliCommand(canonicalCommand)) {
				task.failCommandExecution?.(commandEvidenceId)
				task.recordToolError("execute_command")
				pushToolResult(
					formatResponse.toolError(
						"GitHub CLI commands are disabled in Alpha. Use the native github_api tool for pull request, check, merge, and comment operations. Use local git commands only for clone, pull, commit, and push.",
					),
				)
				return
			}

			const ignoredFileAttemptedToAccess = task.rooIgnoreController?.validateCommand(canonicalCommand)

			if (ignoredFileAttemptedToAccess) {
				task.failCommandExecution?.(commandEvidenceId, "denied")
				await task.say("rooignore_error", ignoredFileAttemptedToAccess)
				pushToolResult(formatResponse.rooIgnoreError(ignoredFileAttemptedToAccess))
				return
			}

			task.consecutiveMistakeCount = 0

			const didApprove = await askApproval("command", canonicalCommand)

			if (!didApprove) {
				task.failCommandExecution?.(commandEvidenceId, "denied")
				return
			}

			const executionMode = typeof task.getTaskMode === "function" ? await task.getTaskMode() : defaultModeSlug
			if (
				!isToolAllowedForMode("execute_command", executionMode, [], undefined, {
					command: canonicalCommand,
					cwd: customCwd ?? null,
					timeout: timeoutSeconds ?? null,
					verification: verification ?? null,
				})
			) {
				task.failCommandExecution?.(commandEvidenceId, "denied")
				task.recordToolError("execute_command", "Command authority changed while approval was pending")
				pushToolResult(
					formatResponse.toolError(
						`Command was not started because it is not allowed in the task's current ${executionMode} mode.`,
					),
				)
				return
			}

			const provider = await task.providerRef.deref()
			const providerState = await provider?.getState()

			const { terminalShellIntegrationDisabled = true } = providerState ?? {}

			// Get command execution timeout from VSCode configuration (in seconds)
			const commandExecutionTimeoutSeconds = vscode.workspace
				.getConfiguration(Package.name)
				.get<number>("commandExecutionTimeout", 0)

			// Get command timeout allowlist from VSCode configuration
			const commandTimeoutAllowlist = vscode.workspace
				.getConfiguration(Package.name)
				.get<string[]>("commandTimeoutAllowlist", [])

			// Check if command matches any prefix in the allowlist
			const isCommandAllowlisted = commandTimeoutAllowlist.some((prefix) =>
				canonicalCommand.startsWith(prefix.trim()),
			)

			// Convert seconds to milliseconds for internal use, but skip timeout if command is allowlisted
			const commandExecutionTimeout = isCommandAllowlisted ? 0 : commandExecutionTimeoutSeconds * 1000

			// Convert agent-specified timeout from seconds to milliseconds
			const agentTimeout = resolveAgentTimeoutMs(timeoutSeconds)

			const options: ExecuteCommandOptions = {
				executionId,
				toolCallId: commandEvidenceId,
				command: canonicalCommand,
				customCwd,
				verificationChangeSetIds: verification?.change_set_ids,
				terminalShellIntegrationDisabled,
				commandExecutionTimeout,
				agentTimeout,
			}

			try {
				const [rejected, result] = await executeCommandInTerminal(task, options)

				if (rejected) {
					task.didRejectTool = true
				}

				pushToolResult(result)
			} catch (error: unknown) {
				if (!(error instanceof ShellIntegrationError)) throw error

				const status: CommandExecutionStatus = { executionId, status: "fallback" }
				provider?.postMessageToWebview({ type: "commandExecutionStatus", text: JSON.stringify(status) })
				await task.say("shell_integration_warning")

				// Invalidate pending ask from first execution to prevent race condition
				task.supersedePendingAsk()

				const [rejected, result] = await executeCommandInTerminal(task, {
					...options,
					terminalShellIntegrationDisabled: true,
				})

				if (rejected) {
					task.didRejectTool = true
				}

				pushToolResult(result)
			}

			return
		} catch (error) {
			if (commandEvidenceId) task.failCommandExecution?.(commandEvidenceId)
			await handleError("executing command", error as Error)
			return
		} finally {
			const evidence = task.getCommandExecutionEvidence?.().find((item) => item.toolCallId === commandEvidenceId)
			if (evidence) {
				const trustedExploration =
					evidence.command && evidence.cwd
						? await getTrustedCommandExploration({
								command: evidence.command,
								workspaceRoot: task.cwd,
								cwd: evidence.cwd,
								executionStatus: evidence.status,
								exitCode: evidence.exitCode,
							})
						: undefined
				callbacks.setResultMetadata?.({
					executionStatus: evidence.status === "running" ? "running" : undefined,
					status:
						evidence.status === "succeeded" || evidence.status === "running"
							? "success"
							: evidence.status === "denied" || evidence.status === "cancelled"
								? evidence.status
								: "error",
					exitCode: evidence.exitCode,
					timedOut: evidence.status === "timed_out",
					...(trustedExploration ? { trustedExploration } : {}),
				})
			}
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"execute_command">): Promise<void> {
		const command = block.params.command
		await task.ask("command", command ?? "", block.partial).catch(() => {})
	}
}

export type ExecuteCommandOptions = {
	executionId: string
	toolCallId?: string
	command: string
	customCwd?: string
	verificationChangeSetIds?: readonly string[]
	terminalShellIntegrationDisabled?: boolean
	commandExecutionTimeout?: number
	agentTimeout?: number
}

export async function executeCommandInTerminal(
	task: Task,
	{
		executionId,
		toolCallId,
		command,
		customCwd,
		verificationChangeSetIds,
		terminalShellIntegrationDisabled = true,
		commandExecutionTimeout = 0,
		agentTimeout = 0,
	}: ExecuteCommandOptions,
): Promise<[boolean, ToolResponse]> {
	// Convert milliseconds back to seconds for display purposes.
	const commandExecutionTimeoutSeconds = commandExecutionTimeout / 1000
	let workingDir: string
	const physicalExecutionId = `${executionId}:${randomUUID()}`
	let mutationBaseline: WorkspaceMutationState | undefined
	let mutationReceiptCompletion: Promise<void> | undefined
	let commandMutationCompletion = Promise.resolve()
	let commandMutationFailureHandling: Promise<{ recoveryError?: unknown }> | undefined
	let commandTerminalOutcomeFenced = false
	let pytestReceipt: Awaited<ReturnType<typeof createPytestVerificationReceipt>> | undefined
	let verificationDiagnostic: CommandVerificationDiagnostic | undefined
	const disposePytestReceipt = async () => {
		try {
			await pytestReceipt?.dispose()
		} catch (error) {
			// Optional observer cleanup must not replace the physical outcome or skip
			// settlement of the command's workspace mutation reservation.
			console.error("Failed to clean pytest observer:", error)
		}
	}

	const isManagedWorker = task.taskKind === "subagent" && task.subagentRole === "worker"
	const executionMode = typeof task.getTaskMode === "function" ? await task.getTaskMode() : defaultModeSlug
	const isPlanMode = executionMode === planModeSlug
	const restrictCommandCwdToWorkspace = isManagedWorker || isPlanMode
	const cancellationResult = (): [boolean, ToolResponse] => {
		if (toolCallId) task.failCommandExecution?.(toolCallId, "cancelled")
		return [false, "Command was not started because the task was cancelled."]
	}
	const taskWasCancelled = () => task.abort || task.getTaskLifetimeCancellationSignal().aborted
	if (taskWasCancelled()) return cancellationResult()
	if (restrictCommandCwdToWorkspace && customCwd && path.isAbsolute(customCwd)) {
		if (toolCallId) task.failCommandExecution?.(toolCallId)
		return [
			false,
			isPlanMode
				? "Plan commands may use only workspace-relative command directories."
				: "Editing workers may use only workspace-relative command directories.",
		]
	}
	if (!customCwd) {
		workingDir = task.cwd
	} else if (path.isAbsolute(customCwd)) {
		workingDir = customCwd
	} else {
		workingDir = path.resolve(task.cwd, customCwd)
	}

	try {
		await fs.access(workingDir)
		if (restrictCommandCwdToWorkspace) {
			const [realWorkspace, realWorkingDir] = await Promise.all([fs.realpath(task.cwd), fs.realpath(workingDir)])
			const relative = path.relative(realWorkspace, realWorkingDir)
			if (relative.startsWith("..") || path.isAbsolute(relative)) {
				if (toolCallId) task.failCommandExecution?.(toolCallId)
				return [
					false,
					isPlanMode
						? "Plan command directory resolves outside the task workspace."
						: "Editing worker command directory is outside its isolated workspace.",
				]
			}
		}
	} catch (error) {
		if (toolCallId) task.failCommandExecution?.(toolCallId)
		return [
			false,
			`Working directory '${restrictCommandCwdToWorkspace ? customCwd || "." : workingDir}' does not exist.`,
		]
	}

	let message: { text?: string; images?: string[] } | undefined
	let runInBackground = false
	let completed = false
	let result: string = ""
	let persistedResult: PersistedCommandOutput | undefined
	let exitDetails: ExitCodeDetails | undefined
	let shellIntegrationError: string | undefined
	let hasAskedForCommandOutput = false

	// Managed workers run unattended and must use the terminal provider whose
	// process tree can be deterministically terminated by task cancellation.
	const terminalProvider = isManagedWorker || terminalShellIntegrationDisabled ? "execa" : "vscode"
	const provider = await task.providerRef.deref()
	const handleCommandMutationFailure = (error: unknown): Promise<{ recoveryError?: unknown }> => {
		commandMutationFailureHandling ??= (async () => {
			const receiptError =
				error instanceof CommandMutationReceiptError
					? error
					: new CommandMutationReceiptError("complete-command-evidence", false, error)
			let recoveryError: unknown
			if (receiptError.observationUnknown) {
				try {
					const owner = task.providerRef.deref()
					if (!owner) throw new Error("Primary mutation ledger is unavailable")
					const receiptSettled = await owner.recordPrimaryMutation(
						task,
						{ __unobserved_command_scope__: physicalExecutionId },
						true,
						physicalExecutionId,
					)
					if (!receiptSettled) {
						throw new Error("Primary mutation ledger did not affirm the unresolved receipt")
					}
					// The unresolved receipt now owns this physical reservation. A late
					// terminal callback must not try to settle the same token a second time.
					mutationReceiptCompletion = Promise.resolve()
				} catch (recoveryFailure) {
					recoveryError = recoveryFailure
				}
			}

			if (toolCallId) task.failCommandExecution?.(toolCallId, "failed", physicalExecutionId)
			task.didToolFailInCurrentTurn = true
			task.suspendAfterCurrentTurn(
				receiptError.observationUnknown
					? t("common:errors.command_mutation_observation_incomplete")
					: t("common:errors.command_mutation_receipt_incomplete"),
			)
			console.error(
				`[ExecuteCommandTool] ${redactTaskPrivatePaths(task, receiptError.message)}`,
				recoveryError
					? new AggregateError(
							[receiptError, recoveryError],
							"Failed to preserve unresolved command mutation debt",
						)
					: receiptError,
			)
			return { recoveryError }
		})()
		return commandMutationFailureHandling
	}
	const observeCommandMutationFailure = (operation: Promise<void>): Promise<void> =>
		operation.catch(async (error) => {
			const { recoveryError } = await handleCommandMutationFailure(error)
			if (recoveryError) {
				throw new AggregateError(
					[error, recoveryError],
					"Command mutation observation failed and unresolved debt could not be persisted",
				)
			}
			throw error
		})
	const ensureMutationReceipt = (): Promise<void> => {
		mutationReceiptCompletion ??= observeCommandMutationFailure(
			finalizeCommandMutationReceipt(task, mutationBaseline, physicalExecutionId, () => {
				workspaceObservationIncomplete = true
			}),
		)
		return mutationReceiptCompletion
	}
	let mutationReservationAcquired = false
	let workspaceObservationIncomplete = false
	const releaseMutationReservationBeforeLaunch = async (primaryError: unknown): Promise<void> => {
		if (!mutationReservationAcquired) return
		try {
			const owner = task.providerRef.deref()
			if (!owner) throw new Error("Primary mutation ledger is unavailable")
			await owner.releasePrimaryMutation(task, physicalExecutionId)
		} catch (error) {
			const receiptError = new CommandMutationReceiptError("release-pre-launch-reservation", false, error)
			await handleCommandMutationFailure(receiptError)
			throw new AggregateError(
				[primaryError, receiptError],
				"Command did not launch and its mutation reservation could not be released",
			)
		}
	}

	// Get global storage path for persisted output artifacts
	const globalStoragePath = provider?.context?.globalStorageUri?.fsPath
	let interceptor: OutputInterceptor | undefined

	// Create OutputInterceptor if we have storage available
	if (globalStoragePath) {
		const taskDir = await getTaskDirectoryPath(globalStoragePath, task.taskId)
		const storageDir = path.join(taskDir, "command-output")
		const providerState = await provider?.getState()
		const terminalOutputPreviewSize =
			providerState?.terminalOutputPreviewSize ?? DEFAULT_TERMINAL_OUTPUT_PREVIEW_SIZE

		interceptor = new OutputInterceptor({
			executionId,
			taskId: task.taskId,
			command,
			storageDir,
			previewSize: terminalOutputPreviewSize,
		})
	}

	let accumulatedOutput = ""
	// Bound accumulated output buffer size to prevent unbounded memory growth for long-running commands.
	// The interceptor preserves full output; this buffer is only for UI display (100KB limit).
	const maxAccumulatedOutputSize = 100_000
	const commandOutputStreamThrottleMs = 150
	let latestCompressedOutput = ""
	let lastQueuedCommandOutput = ""
	let lastCommandOutputEmitAt = 0
	let pendingCommandOutputEmitTimer: NodeJS.Timeout | undefined
	let commandOutputSayChain: Promise<void> = Promise.resolve()

	const queueCommandOutputMessage = (text: string, partial: boolean, force = false): Promise<void> => {
		if (!force && text === lastQueuedCommandOutput) {
			return commandOutputSayChain
		}

		lastQueuedCommandOutput = text
		commandOutputSayChain = commandOutputSayChain
			.then(async () => {
				await task.say("command_output", text, undefined, partial, undefined, undefined, {
					isNonInteractive: true,
				})
			})
			.catch((error) => {
				console.error("[ExecuteCommandTool] Failed to publish command output:", error)
			})

		return commandOutputSayChain
	}

	const schedulePartialCommandOutputUpdate = () => {
		if (!latestCompressedOutput || completed) {
			return
		}

		const emitUpdate = () => {
			pendingCommandOutputEmitTimer = undefined
			lastCommandOutputEmitAt = Date.now()
			void queueCommandOutputMessage(latestCompressedOutput, true)
		}

		const elapsed = Date.now() - lastCommandOutputEmitAt
		if (elapsed >= commandOutputStreamThrottleMs) {
			emitUpdate()
			return
		}

		if (!pendingCommandOutputEmitTimer) {
			pendingCommandOutputEmitTimer = setTimeout(emitUpdate, commandOutputStreamThrottleMs - elapsed)
		}
	}

	// Track when onCompleted callback finishes to avoid race condition.
	// The callback is async but Terminal/ExecaTerminal don't await it, so we track completion
	// explicitly to ensure persistedResult is set before we use it.
	let onCompletedPromise: Promise<void> | undefined
	let resolveOnCompleted: (() => void) | undefined
	let rejectOnCompleted: ((error: CommandOutputBookkeepingError) => void) | undefined
	let onCompletedInvoked = false
	let missingOutputCompletionTimer: NodeJS.Timeout | undefined
	let backgroundResultReturned = false
	let testValidation = false
	let outputBookkeepingFailure: CommandOutputBookkeepingError | undefined
	let outputBookkeepingFailureHandling: Promise<void> | undefined
	const handleBackgroundOutputBookkeepingFailure = (): Promise<void> => {
		if (!backgroundResultReturned || !outputBookkeepingFailure || !exitDetails) return Promise.resolve()
		const failure = outputBookkeepingFailure
		outputBookkeepingFailureHandling ??= (async () => {
			// The terminal completion callback owns mutation settlement and may still be
			// running. Wait for it before marking the already-returned command failed so
			// its success projection cannot overwrite this bookkeeping failure.
			await commandMutationCompletion.catch(() => undefined)
			if (toolCallId) task.failCommandExecution?.(toolCallId, "failed", physicalExecutionId)
			task.didToolFailInCurrentTurn = true
			task.suspendAfterCurrentTurn(t("common:errors.command_output_bookkeeping_incomplete"))
			console.error(`[ExecuteCommandTool] ${redactTaskPrivatePaths(task, failure.message)}`, failure)
		})()
		return outputBookkeepingFailureHandling
	}
	onCompletedPromise = new Promise((resolve, reject) => {
		resolveOnCompleted = resolve
		rejectOnCompleted = reject
	})
	// Terminal event emitters do not await the async callback. Attach an observer
	// immediately, while retaining the original promise for the foreground join.
	void onCompletedPromise.catch(() => undefined)
	const scheduleMissingOutputCompletionFailure = () => {
		if (onCompletedInvoked || outputBookkeepingFailure || missingOutputCompletionTimer) return
		// Both terminal providers synchronously emit `completed` (which invokes
		// onCompleted) in the same turn or the microtask immediately following the
		// shell outcome. Yield one timer turn so that supported ordering can settle,
		// then fail closed instead of retaining an unjoinable output promise.
		missingOutputCompletionTimer = setTimeout(() => {
			missingOutputCompletionTimer = undefined
			if (onCompletedInvoked || outputBookkeepingFailure) return
			outputBookkeepingFailure = new CommandOutputBookkeepingError(
				new Error(t("common:errors.command_output_bookkeeping_incomplete")),
			)
			rejectOnCompleted?.(outputBookkeepingFailure)
			void handleBackgroundOutputBookkeepingFailure()
		}, 0)
	}

	const callbacks: RooTerminalCallbacks = {
		onLine: async (lines: string, process: RooTerminalProcess) => {
			accumulatedOutput += lines

			// Trim accumulated output to prevent unbounded memory growth
			if (accumulatedOutput.length > maxAccumulatedOutputSize) {
				accumulatedOutput = accumulatedOutput.slice(-maxAccumulatedOutputSize)
			}

			// Write to interceptor for persisted output
			interceptor?.write(lines)

			// Continue sending compressed output to webview for UI display (unchanged behavior)
			const compressedOutput = Terminal.compressTerminalOutput(accumulatedOutput)
			latestCompressedOutput = compressedOutput
			const status: CommandExecutionStatus = { executionId, status: "output", output: compressedOutput }
			provider?.postMessageToWebview({ type: "commandExecutionStatus", text: JSON.stringify(status) })
			schedulePartialCommandOutputUpdate()

			if (runInBackground || hasAskedForCommandOutput) {
				return
			}

			// Mark that we've asked to prevent multiple concurrent asks
			hasAskedForCommandOutput = true

			try {
				const { response, text, images } = await task.ask("command_output", "")
				runInBackground = true

				if (response === "messageResponse") {
					if (text || images?.length) message = { text, images }
					process.continue()
				}
			} catch (_error) {
				// Silently handle ask errors (e.g., "Current ask promise was ignored")
			}
		},
		onCompleted: async (output: string | undefined) => {
			onCompletedInvoked = true
			clearTimeout(missingOutputCompletionTimer)
			missingOutputCompletionTimer = undefined
			try {
				if (pytestReceipt) {
					const validation = await pytestReceipt.complete()
					testValidation = validation.validated
					verificationDiagnostic ??= validation.diagnostic
				}
				clearTimeout(pendingCommandOutputEmitTimer)
				pendingCommandOutputEmitTimer = undefined

				// Finalize interceptor and get persisted result.
				// We await finalize() to ensure the artifact file is fully flushed
				// before we advertise the artifact_id to the LLM.
				if (interceptor) {
					persistedResult = await interceptor.finalize()
				}

				// Continue using compressed output for UI display
				result = Terminal.compressTerminalOutput(output ?? "")
				latestCompressedOutput = result

				// Preserve order: wait for queued partial updates, then emit the final
				// non-partial command_output update.
				await commandOutputSayChain
				await queueCommandOutputMessage(result, false, true)
				completed = true
				resolveOnCompleted?.()
			} catch (error) {
				outputBookkeepingFailure = new CommandOutputBookkeepingError(error)
				rejectOnCompleted?.(outputBookkeepingFailure)
				void handleBackgroundOutputBookkeepingFailure()
			}
		},
		onShellExecutionStarted: (pid: number | undefined) => {
			const status: CommandExecutionStatus = { executionId, status: "started", pid, command }
			provider?.postMessageToWebview({ type: "commandExecutionStatus", text: JSON.stringify(status) })
		},
		onShellExecutionComplete: (details: ExitCodeDetails) => {
			const status: CommandExecutionStatus = { executionId, status: "exited", exitCode: details.exitCode }
			provider?.postMessageToWebview({ type: "commandExecutionStatus", text: JSON.stringify(status) })
			exitDetails = details
			// A process-level failure already persisted unknown mutation debt and owns
			// the terminal evidence. Late success callbacks may flush output, but must
			// never settle that reservation again or overwrite the failed outcome.
			if (commandMutationFailureHandling || commandTerminalOutcomeFenced) return
			scheduleMissingOutputCompletionFailure()
			commandMutationCompletion = observeCommandMutationFailure(
				(async () => {
					await ensureMutationReceipt()
					// Output persistence is not mutation observation, but command success
					// must not be published until it has settled. A rejected output gate is
					// surfaced separately by the foreground join or background observer.
					await onCompletedPromise?.catch(() => undefined)
					if (outputBookkeepingFailure || commandMutationFailureHandling) return
					if (!toolCallId) return
					try {
						const outcome = {
							...details,
							...(pytestVersions.length ? { testValidation } : {}),
							...(verificationDiagnostic ? { verificationDiagnostic } : {}),
						}
						task.completeCommandExecution?.(toolCallId, outcome, physicalExecutionId)
					} catch (error) {
						throw new CommandMutationReceiptError("complete-command-evidence", false, error)
					}
				})(),
			)
			void commandMutationCompletion.catch(() => undefined)
			void handleBackgroundOutputBookkeepingFailure()
		},
		onVerificationUnavailable: (message) => {
			verificationDiagnostic = { code: "runtime_scope_unavailable", message }
		},
	}

	if (terminalProvider === "vscode") {
		callbacks.onNoShellIntegration = async (error: string) => {
			TelemetryService.instance.captureShellIntegrationError(task.taskId)
			shellIntegrationError = error
		}
	}

	if (taskWasCancelled()) return cancellationResult()
	const terminal = await TerminalRegistry.getOrCreateTerminal(workingDir, task.taskId, terminalProvider)
	if (taskWasCancelled()) return cancellationResult()

	if (terminal instanceof Terminal) {
		terminal.terminal.show(true)

		// Update the working directory in case the terminal we asked for has
		// a different working directory so that the model will know where the
		// command actually executed.
		workingDir = terminal.getCurrentWorkingDirectory()
	}

	if (task.taskKind === "primary") {
		try {
			mutationBaseline = await captureWorkspaceMutationState(task.cwd)
		} catch {
			workspaceObservationIncomplete = true
		}
	}
	let admissionFailure: { error: unknown; cancelled: boolean } | undefined
	try {
		if (taskWasCancelled()) return cancellationResult()
		if (task.taskKind === "primary") {
			const owner = task.providerRef.deref()
			if (!owner) throw new Error("Primary mutation ledger is unavailable")
			await owner.reservePrimaryMutation(task, physicalExecutionId)
			mutationReservationAcquired = true
		}
		if (toolCallId)
			await task.admitCommandExecution?.(
				toolCallId,
				physicalExecutionId,
				command,
				workingDir,
				verificationChangeSetIds,
			)
		if (taskWasCancelled()) {
			admissionFailure = {
				error: new CommandExecutionLifecycleError(
					"launch-command",
					new Error("Command admission was cancelled"),
				),
				cancelled: true,
			}
		}
	} catch (error) {
		admissionFailure = { error, cancelled: taskWasCancelled() }
	}
	if (admissionFailure) {
		await releaseMutationReservationBeforeLaunch(admissionFailure.error)
		if (admissionFailure.cancelled) return cancellationResult()
		throw new CommandExecutionLifecycleError("admit-command", admissionFailure.error)
	}
	const captured = toolCallId
		? task
				.getCommandExecutionEvidence?.()
				.find((item) => item.toolCallId === toolCallId && item.executionId === physicalExecutionId)
		: undefined
	const pytestVersions = Object.values(captured?.verificationVersions ?? {}).filter(
		(version) => version.runner === "pytest",
	)
	if (pytestVersions.length) {
		try {
			pytestReceipt = await createPytestVerificationReceipt({
				executionId: physicalExecutionId,
				commandDigest: pytestVersions[0].commandDigest,
				cwd: pytestVersions[0].scopePath,
				workspaceRoot: task.cwd,
				expectedFiles: [...new Set(pytestVersions.flatMap((version) => version.pytestExpectedFiles ?? []))],
				configFiles: [...new Set(pytestVersions.flatMap((version) => version.pytestConfigFiles ?? []))],
			})
		} catch {
			verificationDiagnostic = {
				code: "runtime_scope_unavailable",
				message:
					"The execution-bound pytest observer could not be prepared; this command cannot provide verification evidence.",
			}
		}
	}
	if (taskWasCancelled()) {
		await disposePytestReceipt()
		await releaseMutationReservationBeforeLaunch(new Error("Command admission was cancelled"))
		return cancellationResult()
	}
	let process: ReturnType<RooTerminal["runCommand"]>
	try {
		process = pytestReceipt
			? terminal.runCommand(command, callbacks, { pytestVerification: pytestReceipt.launch })
			: terminal.runCommand(command, callbacks)
	} catch (error) {
		await disposePytestReceipt()
		const launchError = new CommandExecutionLifecycleError("launch-command", error)
		if (mutationReservationAcquired) {
			const receiptError = new CommandMutationReceiptError("launch-outcome-unknown", true, launchError)
			const { recoveryError } = await handleCommandMutationFailure(receiptError)
			if (recoveryError) {
				throw new AggregateError(
					[launchError, recoveryError],
					"Command launch failed and unresolved mutation debt could not be persisted",
				)
			}
		} else if (toolCallId) {
			task.failCommandExecution?.(toolCallId, "failed", physicalExecutionId)
		}
		throw launchError
	}
	if (pytestReceipt) {
		const cleanup = () => {
			process.removeListener("error", cleanup)
			void disposePytestReceipt()
		}
		void onCompletedPromise.then(cleanup, cleanup)
		process.once("error", cleanup)
		// A provider can reject its process promise without emitting an error event.
		// Fulfillment may merely background it, so only rejection releases this owner.
		void process.catch(cleanup)
	}
	task.terminalProcess = process

	// Dual-timeout logic:
	// - Agent timeout: transitions the command to background (continues running).
	// - User timeout: remains a hard process-lifetime ceiling and aborts the
	//   registry-owned process even if the agent timeout returned first.
	let agentTimeoutId: NodeJS.Timeout | undefined
	let userTimeoutId: NodeJS.Timeout | undefined
	let isUserTimedOut = false
	let userTimeoutCleanupError: unknown

	try {
		const racers: Promise<void>[] = [process]

		// Agent timeout: transition to background (command keeps running)
		if (agentTimeout > 0) {
			racers.push(
				new Promise<void>((resolve) => {
					agentTimeoutId = setTimeout(() => {
						runInBackground = true
						process.continue()
						task.supersedePendingAsk()
						resolve()
					}, agentTimeout)
				}),
			)
		}

		// User timeout: abort the command (existing behavior)
		if (commandExecutionTimeout > 0) {
			racers.push(
				new Promise<void>((_, reject) => {
					userTimeoutId = setTimeout(() => {
						isUserTimedOut = true
						// The timeout now owns the terminal outcome. A callback emitted by
						// process cleanup may still flush output, but it must not settle the
						// reservation or publish success independently of the timeout path.
						commandTerminalOutcomeFenced = true
						if (toolCallId) task.failCommandExecution?.(toolCallId, "timed_out", physicalExecutionId)
						const status: CommandExecutionStatus = { executionId, status: "timeout" }
						provider?.postMessageToWebview({ type: "commandExecutionStatus", text: JSON.stringify(status) })
						if (runInBackground) {
							task.didToolFailInCurrentTurn = true
							void task
								.say(
									"error",
									t("common:errors:command_timeout", { seconds: commandExecutionTimeoutSeconds }),
								)
								.catch((error) =>
									console.error("Failed to report a background command timeout:", error),
								)
						}
						void Promise.resolve(process.abort()).then(
							() => reject(new Error(`Command execution timed out after ${commandExecutionTimeout}ms`)),
							(error) => {
								userTimeoutCleanupError = error
								console.error("Failed to terminate a timed-out command:", error)
								reject(error)
							},
						)
					}, commandExecutionTimeout)
				}),
			)
		}

		await Promise.race(racers)
		// Abort cleanup can resolve the process promise before the timeout racer's
		// rejection microtask. The timer has already claimed terminal ownership, so
		// do not let that cleanup ordering turn a timed-out command into success.
		if (isUserTimedOut) {
			throw new Error(`Command execution timed out after ${commandExecutionTimeout}ms`)
		}
	} catch (error) {
		await disposePytestReceipt()
		if (isUserTimedOut) {
			if (userTimeoutCleanupError) {
				const cleanupError = new CommandExecutionLifecycleError(
					"await-command-process",
					new Error(
						`Command exceeded its timeout and process cleanup failed: ${userTimeoutCleanupError instanceof Error ? userTimeoutCleanupError.message : String(userTimeoutCleanupError)}`,
						{ cause: userTimeoutCleanupError },
					),
				)
				if (mutationReservationAcquired) {
					const receiptError = new CommandMutationReceiptError("process-outcome-unknown", true, cleanupError)
					const { recoveryError } = await handleCommandMutationFailure(receiptError)
					if (recoveryError) {
						throw new AggregateError(
							[cleanupError, recoveryError],
							"Timed-out command cleanup failed and unresolved mutation debt could not be persisted",
						)
					}
				}
				throw cleanupError
			}

			if (mutationReservationAcquired) {
				const timeoutError = new CommandExecutionLifecycleError("await-command-process", error)
				if (exitDetails) {
					// A terminal outcome arrived as part of abort cleanup. Settle the
					// exact/no-op receipt here because its normal callback is fenced.
					try {
						await ensureMutationReceipt()
					} catch (receiptError) {
						throw new AggregateError(
							[timeoutError, receiptError],
							"Timed-out command mutation receipt could not be finalized",
						)
					}
				} else {
					// A successful abort without a terminal callback does not prove the
					// final workspace scope. Persist conservative unknown debt under the
					// same physical reservation before returning the timeout result.
					const receiptError = new CommandMutationReceiptError("process-outcome-unknown", true, timeoutError)
					const { recoveryError } = await handleCommandMutationFailure(receiptError)
					if (recoveryError) {
						throw new AggregateError(
							[timeoutError, receiptError, recoveryError],
							"Timed-out command ended without an observable outcome and unresolved debt could not be persisted",
						)
					}
				}
			}
			await task.say("error", t("common:errors:command_timeout", { seconds: commandExecutionTimeoutSeconds }))
			task.didToolFailInCurrentTurn = true
			task.terminalProcess = undefined

			return [
				false,
				`The command was terminated after exceeding a user-configured ${commandExecutionTimeoutSeconds}s timeout. Do not try to re-run the command.`,
			]
		}

		const processError = new CommandExecutionLifecycleError("await-command-process", error)
		const failures: unknown[] = [processError]
		if (exitDetails) {
			const receiptResult = await Promise.allSettled([commandMutationCompletion])
			if (receiptResult[0].status === "rejected") failures.push(receiptResult[0].reason)
		} else if (mutationReservationAcquired) {
			const receiptError = new CommandMutationReceiptError("process-outcome-unknown", true, processError)
			const { recoveryError } = await handleCommandMutationFailure(receiptError)
			if (recoveryError) failures.push(recoveryError)
		}
		if (onCompletedInvoked && onCompletedPromise) {
			const outputResult = await Promise.allSettled([onCompletedPromise])
			if (outputResult[0].status === "rejected") failures.push(outputResult[0].reason)
		}
		if (toolCallId) task.failCommandExecution?.(toolCallId, "failed", physicalExecutionId)
		if (failures.length > 1) {
			throw new AggregateError(failures, "Command process and completion bookkeeping failed")
		}
		throw processError
	} finally {
		clearTimeout(agentTimeoutId)
		const keepUserTimeoutForBackground =
			commandExecutionTimeout > 0 && runInBackground && !completed && !exitDetails && process.isSettled !== true
		if (keepUserTimeoutForBackground) {
			const clearBackgroundUserTimeout = () => {
				clearTimeout(userTimeoutId)
				process.removeListener("completed", clearBackgroundUserTimeout)
				process.removeListener("error", clearBackgroundUserTimeout)
			}
			process.once("completed", clearBackgroundUserTimeout)
			process.once("error", clearBackgroundUserTimeout)
		} else {
			clearTimeout(userTimeoutId)
		}
		clearTimeout(pendingCommandOutputEmitTimer)
		task.terminalProcess = undefined
	}

	if (shellIntegrationError) {
		const shellError = new ShellIntegrationError(shellIntegrationError)
		const completions: Promise<void>[] = [ensureMutationReceipt()]
		if (onCompletedInvoked && onCompletedPromise) completions.push(onCompletedPromise)
		const completionResults = await Promise.allSettled(completions)
		if (toolCallId) task.failCommandExecution?.(toolCallId, "failed", physicalExecutionId)
		const failures = completionResults.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
		if (failures.length > 0) {
			throw new AggregateError(
				[shellError, ...failures],
				"Shell integration and command completion bookkeeping failed",
			)
		}
		throw shellError
	}

	// Wait for a short delay to ensure all messages are sent to the webview.
	// This delay allows time for non-awaited promises to be created and
	// for their associated messages to be sent to the webview, maintaining
	// the correct order of messages (although the webview is smart about
	// grouping command_output messages despite any gaps anyways).
	await delay(50)

	// Wait for onCompleted callback to finish if shell execution completed.
	// This ensures persistedResult is set before we try to use it, fixing the race
	// condition where exitDetails is set (sync) before the async onCompleted finishes.
	if (exitDetails && onCompletedPromise) {
		const [outputResult, mutationResult] = await Promise.allSettled([onCompletedPromise, commandMutationCompletion])
		const failures = [mutationResult, outputResult].flatMap((settled) =>
			settled.status === "rejected" ? [settled.reason] : [],
		)
		if (failures.length === 1) throw failures[0]
		if (failures.length > 1) {
			throw new AggregateError(failures, "Command mutation and output bookkeeping failed")
		}
	}

	const displayOutput = result || latestCompressedOutput || ""
	if (!completed && !exitDetails) {
		backgroundResultReturned = true
		void handleBackgroundOutputBookkeepingFailure()
	}

	if (message) {
		const { text, images } = message
		await task.say("user_feedback", text, images)

		return [
			true,
			formatResponse.toolResult(
				redactTaskPrivatePaths(
					task,
					[
						`Command is still running in terminal from '${terminal.getCurrentWorkingDirectory().toPosix()}'.`,
						displayOutput.length > 0 ? `Here's the output so far:\n${displayOutput}\n` : "\n",
						`<user_message>\n${text}\n</user_message>`,
					].join("\n"),
				),
				images,
			),
		]
	} else if (completed || exitDetails) {
		const currentWorkingDir = terminal.getCurrentWorkingDirectory().toPosix()
		const displayWorkingDir = isManagedWorker ? "." : currentWorkingDir
		const observationNote = workspaceObservationIncomplete
			? "\nWorkspace diff observation was incomplete; this result reports the process outcome, not a complete inventory of changed files."
			: ""

		// Use persisted output format when output was truncated and spilled to disk
		if (persistedResult?.truncated) {
			return [
				false,
				redactTaskPrivatePaths(
					task,
					formatPersistedOutput(persistedResult, exitDetails, displayWorkingDir) + observationNote,
				),
			]
		}

		// Use inline format for small outputs (original behavior with exit status)
		let exitStatus: string = ""

		if (exitDetails !== undefined) {
			if (exitDetails.signalName) {
				exitStatus = `Process terminated by signal ${exitDetails.signalName}`

				if (exitDetails.coreDumpPossible) {
					exitStatus += " - core dump possible"
				}
			} else if (exitDetails.exitCode === undefined) {
				result += "<VSCE exit code is undefined: terminal output and command execution status is unknown.>"
				exitStatus = `Exit code: <undefined, notify user>`
			} else {
				if (exitDetails.exitCode !== 0) {
					exitStatus += "Command execution was not successful, inspect the cause and adjust as needed.\n"
				}

				exitStatus += `Exit code: ${exitDetails.exitCode}`
			}
		} else {
			result += "<VSCE exitDetails == undefined: terminal output and command execution status is unknown.>"
			exitStatus = `Exit code: <undefined, notify user>`
		}

		return [
			false,
			redactTaskPrivatePaths(
				task,
				`Command executed in terminal within working directory '${displayWorkingDir}'. ${exitStatus}${observationNote}\nOutput:\n${result}`,
			),
		]
	} else {
		return [
			false,
			redactTaskPrivatePaths(
				task,
				[
					`Command is still running in terminal ${workingDir ? ` from '${isManagedWorker ? "." : workingDir.toPosix()}'` : ""}.`,
					displayOutput.length > 0 ? `Here's the output so far:\n${displayOutput}\n` : "\n",
					"You will be updated on the terminal status and new output in the future.",
				].join("\n"),
			),
		]
	}
}

/**
 * Format exit status from ExitCodeDetails
 */
function formatExitStatus(exitDetails: ExitCodeDetails | undefined): string {
	if (exitDetails === undefined) {
		return "Exit code: <undefined, notify user>"
	}

	if (exitDetails.signalName) {
		let status = `Process terminated by signal ${exitDetails.signalName}`
		if (exitDetails.coreDumpPossible) {
			status += " - core dump possible"
		}
		return status
	}

	if (exitDetails.exitCode === undefined) {
		return "Exit code: <undefined, notify user>"
	}

	let status = ""
	if (exitDetails.exitCode !== 0) {
		status += "Command execution was not successful, inspect the cause and adjust as needed.\n"
	}
	status += `Exit code: ${exitDetails.exitCode}`
	return status
}

/**
 * Format persisted output result for tool response when output was truncated
 */
function formatPersistedOutput(
	result: PersistedCommandOutput,
	exitDetails: ExitCodeDetails | undefined,
	workingDir: string,
): string {
	const exitStatus = formatExitStatus(exitDetails)
	const sizeStr = formatBytes(result.totalBytes)
	const artifactId = result.artifactPath ? path.basename(result.artifactPath) : ""

	return [
		`Command executed in '${workingDir}'. ${exitStatus}`,
		"",
		`Output (${sizeStr}) persisted. Artifact ID: ${artifactId}`,
		"",
		"Preview:",
		result.preview,
		"",
		"Use read_command_output tool to view full output if needed.",
	].join("\n")
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export const executeCommandTool = new ExecuteCommandTool()
