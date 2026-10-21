import fs from "fs/promises"
import * as path from "path"
import { randomUUID } from "crypto"
import * as vscode from "vscode"

import delay from "delay"

import {
	CommandExecutionStatus,
	DEFAULT_TERMINAL_OUTPUT_PREVIEW_SIZE,
	PersistedCommandOutput,
	type CommandToolResult,
	type TerminalOutputPreviewSize,
} from "@alpha-code/types"
import { TelemetryService } from "@alpha-code/telemetry"

import { Task } from "../task/Task"

import { ToolUse, ToolResponse } from "../../shared/tools"
import { formatResponse } from "../prompts/responses"
import { defaultModeSlug, planModeSlug } from "../../shared/modes"
import {
	ExitCodeDetails,
	AlphaTerminal,
	AlphaTerminalCallbacks,
	AlphaTerminalProcess,
	DirectTerminalCommand,
} from "../../integrations/terminal/types"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"
import { commandSessionRegistry } from "./CommandSessionRegistry"
import { Terminal } from "../../integrations/terminal/Terminal"
import { OutputArchiveInterruptedError, OutputInterceptor } from "../../integrations/terminal/OutputInterceptor"
import { Package } from "../../shared/package"
import { t } from "../../i18n"
import { getTaskDirectoryPath } from "../../utils/storage"
import {
	BaseTool,
	boundCommandToolResult,
	formatCommandToolResult,
	getCommandToolResultLimit,
	TOOL_OUTPUT_TRUNCATION_SUFFIX,
	ToolCallbacks,
	ToolReadDeniedError,
} from "./BaseTool"
import { createToolFailure, type ToolFailureMetadata } from "./ToolFailure"
import { isToolAllowedForMode } from "./validateToolUse"
import { redactTaskPrivatePaths } from "./taskPathPresentation"
import {
	captureWorkspaceMutationState,
	captureWorkspaceMutationDiffBaseline,
	createWorkspaceMutationDiffs,
	compareWorkspaceMutationState,
	type WorkspaceMutationDiff,
	type WorkspaceMutationDiffBaseline,
	type WorkspaceMutationState,
} from "../agent/VerificationScope"
import { getTrustedCommandExploration } from "./CommandExploration"
import { getCommandDecision } from "../auto-approval/commands"

class ShellIntegrationError extends Error {}
class PreparedCommandCancelledError extends Error {}

const PREPARED_COMMAND_CLEANUP_OBSERVATION_MS = 15_000

const MAX_TURN_FILE_CHANGE_MESSAGE_BYTES = 2 * 1_024 * 1_024
const fileChangeMessageBytesByTask = new WeakMap<Task, Map<number, number>>()

function reserveFileChangeMessageBytes(task: Task, turnKey: number, bytes: number): boolean {
	let byTurn = fileChangeMessageBytesByTask.get(task)
	if (!byTurn) {
		byTurn = new Map()
		fileChangeMessageBytesByTask.set(task, byTurn)
	}
	const used = byTurn.get(turnKey) ?? 0
	if (used + bytes > MAX_TURN_FILE_CHANGE_MESSAGE_BYTES) return false
	byTurn.set(turnKey, used + bytes)
	// Only a few older turns can still have background commands in flight.
	while (byTurn.size > 8) byTurn.delete(byTurn.keys().next().value!)
	return true
}

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
	owner: ReturnType<Task["providerRef"]["deref"]>,
	mutationBaseline: WorkspaceMutationState | undefined,
	diffBaseline: WorkspaceMutationDiffBaseline | undefined,
	physicalExecutionId: string,
	onIncomplete: () => void,
): Promise<WorkspaceMutationDiff[]> {
	if (task.taskKind !== "primary") return []

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
			if (!owner) throw new Error("Primary mutation ledger is unavailable")
			const receiptSettled = await owner.recordPrimaryMutation(task, changes.files, false, physicalExecutionId)
			if (!receiptSettled) {
				throw new Error("Primary mutation ledger did not affirm the final receipt")
			}
		} catch (error) {
			throw new CommandMutationReceiptError("persist-final-receipt", false, error)
		}
		if (!mutationBaseline || !diffBaseline) return []
		try {
			return await createWorkspaceMutationDiffs(task.cwd, mutationBaseline, changes, diffBaseline)
		} catch {
			return []
		}
	}

	try {
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
	return []
}

export interface ExecuteCommandParams {
	command: string
	tty?: boolean | null
	cwd?: string | null
	timeout?: number | null
	verification?: { change_set_ids: string[] } | null
}

type CommandPresentationSlot =
	| "started"
	| "output-status"
	| "command-output"
	| "terminal-status"
	| "evidence"
	| "file-changes"
	| "failure"
	| "metadata"

/** A fixed number of replaceable projections; raw output never waits on this boundary. */
class DeferredCommandPresentation {
	private state: "held" | "ready" | "open" | "discarded" = "held"
	private readonly pending = new Map<
		CommandPresentationSlot,
		(assertOwnership?: () => void) => void | Promise<void>
	>()
	private opening?: Promise<void>
	private draining?: Promise<void>
	private backgroundGuard?: () => void
	private backgroundFailure?: (error: unknown) => void
	private readonly order: readonly CommandPresentationSlot[] = [
		"started",
		"output-status",
		"command-output",
		"terminal-status",
		"evidence",
		"file-changes",
		"failure",
		"metadata",
	]

	publish(
		slot: CommandPresentationSlot,
		operation: (assertOwnership?: () => void) => void | Promise<void>,
	): Promise<void> {
		if (this.state === "discarded") return Promise.resolve()
		if (slot !== "failure" || !this.pending.has(slot)) {
			this.pending.set(slot, operation)
		}
		if (this.state === "open") this.scheduleBackgroundDrain()
		return Promise.resolve()
	}

	open(assertOwnership?: () => void): Promise<void> {
		this.opening ??= (async () => {
			if (this.state !== "held") return
			this.state = "ready"
			const initial = new Map(this.pending)
			this.pending.clear()
			// One fixed pass completes even if a yielded command streams forever.
			// Updates during persistence coalesce for the later ordinary owner.
			for (const slot of this.order) {
				const operation = initial.get(slot)
				if (!operation || this.state !== "ready") continue
				assertOwnership?.()
				await operation(assertOwnership)
				assertOwnership?.()
			}
		})()
		return this.opening
	}

	takeFailurePresentation(): (assertOwnership?: () => void) => Promise<void> {
		const retained = ["evidence", "failure", "metadata"] as const
		const snapshot = retained.map((slot) => this.pending.get(slot))
		this.discard()
		let finalization: Promise<void> | undefined
		return (assertOwnership) => {
			finalization ??= (async () => {
				for (const operation of snapshot) {
					if (!operation) continue
					assertOwnership?.()
					await operation(assertOwnership)
					assertOwnership?.()
				}
			})()
			return finalization
		}
	}

	commit(assertBackgroundOwnership: () => void, onFailure: (error: unknown) => void): void {
		if (this.state !== "ready") throw new Error("Prepared command presentation is not ready for handoff")
		this.backgroundGuard = assertBackgroundOwnership
		this.backgroundFailure = onFailure
		this.state = "open"
		// Only a microtask is scheduled here. The synchronous scheduler handoff
		// itself publishes nothing and starts no additional process/effect.
		this.scheduleBackgroundDrain()
	}

	private scheduleBackgroundDrain(): void {
		if (this.draining || this.state !== "open" || this.pending.size === 0) return
		this.draining = Promise.resolve()
			.then(async () => {
				while (this.state === "open" && this.pending.size > 0) {
					const batch = new Map(this.pending)
					this.pending.clear()
					for (const slot of this.order) {
						const operation = batch.get(slot)
						if (!operation || this.state !== "open") continue
						this.backgroundGuard?.()
						await operation(this.backgroundGuard)
						this.backgroundGuard?.()
					}
				}
			})
			.catch((error: unknown) => {
				this.discard()
				this.backgroundFailure?.(error)
			})
			.finally(() => {
				this.draining = undefined
				this.scheduleBackgroundDrain()
			})
		void this.draining.catch((error: unknown) =>
			console.error("[ExecuteCommandTool] Background command projection failed", error),
		)
	}

	discard(): void {
		this.state = "discarded"
		this.pending.clear()
	}
}

export interface PreparedApprovedCommandRead {
	/** Opens the existing collector once, after the scheduler's effect boundary. */
	run(
		callbacks: Pick<ToolCallbacks, "signal" | "pushToolResult" | "setResultMetadata">,
	): Promise<(assertOwnership?: () => void) => Promise<void>>
	dispose(): Promise<void>
	settleRejectedRun(): {
		cleanup: Promise<void>
		finalize: (assertOwnership?: () => void) => Promise<void>
	}
	/** Synchronous acknowledgment after the scheduler's final cancellation check. */
	commit(): void
}

interface PreparedCommandHost {
	readonly directCommand: DirectTerminalCommand
	readonly beforeLaunch: () => Promise<void>
	readonly presentation: DeferredCommandPresentation
	readonly awaitRun: () => Promise<void>
	readonly onProcessCreated: (process: AlphaTerminalProcess, isArchiveClosed: () => boolean) => void
	readonly onCreationHookFailure: (process: AlphaTerminalProcess) => void
	readonly onSession: (sessionId: number | undefined) => void
	readonly signal: AbortSignal
	readonly isRunAdmitted: () => boolean
}

export function resolveAgentTimeoutMs(timeoutSeconds: number | null | undefined): number {
	return typeof timeoutSeconds === "number" && timeoutSeconds > 0 ? timeoutSeconds * 1000 : 0
}

export class ExecuteCommandTool extends BaseTool<"execute_command"> {
	readonly name = "execute_command" as const

	async prepareApprovedRead(
		params: ExecuteCommandParams,
		task: Task,
		callbacks: ToolCallbacks,
		launch: { readonly directCommand: DirectTerminalCommand; readonly beforeLaunch: () => Promise<void> },
	): Promise<PreparedApprovedCommandRead | undefined> {
		const presentation = new DeferredCommandPresentation()
		const cancellation = new AbortController()
		const lifetime = task.getTaskLifetimeCancellationSignal()
		const externalSignal = callbacks.signal ? AbortSignal.any([callbacks.signal, lifetime]) : lifetime
		const signal = AbortSignal.any([externalSignal, cancellation.signal])
		const originalTaskId = task.taskId
		let markReady!: () => void
		const ready = new Promise<void>((resolve) => {
			markReady = resolve
		})
		let start!: () => void
		let stop!: (error: Error) => void
		const launchGate = new Promise<void>((resolve, reject) => {
			start = resolve
			stop = reject
		})
		// Observe before preparation can fail without ever reaching the gate.
		void launchGate.catch(() => undefined)
		let reachedGate = false
		let started = false
		let committed = false
		let presentationReady = false
		let disposed = false
		let rejectedProjectionRevoked = false
		let rejectedProjectionReady = false
		let rejectedRun: ReturnType<PreparedApprovedCommandRead["settleRejectedRun"]> | undefined
		let process: AlphaTerminalProcess | undefined
		let physicalExecutionId: string | undefined
		let isArchiveClosed: (() => boolean) | undefined
		let archiveSettled = false
		let physicalCompleted = false
		let confirmedPrelaunchFailure = false
		let producerSettled = false
		let sessionId: number | undefined
		// Scheduler preparation and run share the exact collector. Keep its
		// native output/format wrappers instead of rebinding to unbounded sinks.
		const execution = this.executeApproved(params, task, callbacks, {
			...launch,
			signal,
			isRunAdmitted: () => started,
			presentation,
			awaitRun: async () => {
				reachedGate = true
				markReady()
				await launchGate
			},
			onProcessCreated: (created, closed) => {
				process = created
				physicalExecutionId = created.executionId
				isArchiveClosed = closed
				created.once("shell_execution_complete", () => {
					physicalCompleted = true
				})
			},
			onCreationHookFailure: (created) => {
				if (created === process && created.executionId === physicalExecutionId) confirmedPrelaunchFailure = true
			},
			onSession: (created) => {
				sessionId = created
			},
		})
		void execution.then(
			() => {
				producerSettled = true
				markReady()
			},
			() => {
				producerSettled = true
				markReady()
			},
		)
		let cleanup: Promise<void> | undefined
		let disposal: Promise<void> | undefined
		let firstCleanupFailure: { reason: unknown } | undefined
		const observeCleanup = <T>(operation: Promise<T>): Promise<T> =>
			operation.catch((reason: unknown) => {
				firstCleanupFailure ??= { reason }
				throw reason
			})
		const releaseClosedOriginal = (): boolean => {
			if (
				!process ||
				!producerSettled ||
				!archiveSettled ||
				!isArchiveClosed?.() ||
				task.taskId !== originalTaskId ||
				!physicalExecutionId ||
				process.executionId !== physicalExecutionId ||
				(!physicalCompleted && !confirmedPrelaunchFailure)
			)
				return false
			const session = sessionId === undefined ? undefined : commandSessionRegistry.resolve(task, sessionId)
			if (
				sessionId !== undefined &&
				session?.process === process &&
				session.executionId === physicalExecutionId
			) {
				commandSessionRegistry.release(task, sessionId)
			}
			return true
		}
		const dispose = (retainFailure = false): Promise<void> => {
			if (!retainFailure) rejectedProjectionRevoked = true
			if (committed) return Promise.resolve()
			if (disposal) return disposal
			presentation.discard()
			disposed = true
			cancellation.abort()
			stop(new PreparedCommandCancelledError("Prepared command execution was cancelled before presentation"))
			const retry = cleanup !== undefined
			cleanup ??= (async () => {
				// Its rejection is already the scheduler's terminal tool failure.
				// Cleanup joins it without reporting the same failure a second time.
				const producer = execution.then(
					() => undefined,
					() => undefined,
				)
				// Disposal can win while admission awaits. Its local signal prevents
				// dispatch; still recheck the creation hook after the producer joins.
				if (!process) await Promise.allSettled([producer])
				if (process) {
					const original = process
					const originalExecutionId = physicalExecutionId
					const passive = observeCleanup(
						Promise.resolve().then(() => {
							if (!original.waitForOutputFinalization)
								throw new Error("Command archive closure is unavailable")
							return original.waitForOutputFinalization()
						}),
					)
					void passive.then(
						() => {
							archiveSettled = true
						},
						() => {
							archiveSettled = true
						},
					)
					const physical = observeCleanup(
						Promise.resolve().then(async () => {
							if (
								task.taskId !== originalTaskId ||
								!originalExecutionId ||
								original.executionId !== originalExecutionId
							) {
								throw new Error("Prepared command ownership changed before cleanup")
							}
							const owned = [
								...TerminalRegistry.getTerminals(true, originalTaskId),
								...TerminalRegistry.getTerminals(false, originalTaskId),
							].some(
								(terminal) =>
									terminal.taskId === originalTaskId &&
									terminal.process === original &&
									terminal.running,
							)
							if (owned) await original.abort()
						}),
					)
					await Promise.allSettled([physical, passive, producer])
					if (!firstCleanupFailure && !releaseClosedOriginal()) {
						firstCleanupFailure = {
							reason: new Error("Command physical or archive closure is still unconfirmed"),
						}
					}
				}
				if (firstCleanupFailure) throw firstCleanupFailure.reason
			})()
			void cleanup.catch(() => undefined)
			const originalCleanup = cleanup
			// Join the same producer, physical-control and passive archive work
			// before a retry checks proof. Observer flags may still be queued when
			// the actual process run has just settled; never issue a second abort.
			const observation = retry
				? (async () => {
						const [outcome] = await Promise.allSettled([originalCleanup])
						try {
							if (process ? releaseClosedOriginal() : outcome.status === "fulfilled") return
						} catch (reason) {
							throw firstCleanupFailure ? firstCleanupFailure.reason : reason
						}
						if (firstCleanupFailure) throw firstCleanupFailure.reason
						if (outcome.status === "rejected") throw outcome.reason
						throw new Error("Command physical or archive closure is still unconfirmed")
					})()
				: originalCleanup
			let cleanupTimer: NodeJS.Timeout | undefined
			disposal ??= new Promise<void>((resolve, reject) => {
				cleanupTimer = setTimeout(() => {
					const timeout = new Error(
						"Prepared command cleanup remains unconfirmed after 15 seconds; original ownership was retained",
					)
					console.error(`[ExecuteCommandTool] ${timeout.message}`)
					reject(firstCleanupFailure ? firstCleanupFailure.reason : timeout)
				}, PREPARED_COMMAND_CLEANUP_OBSERVATION_MS)
				observation.then(resolve, reject).catch(() => undefined)
			}).finally(() => {
				clearTimeout(cleanupTimer)
				externalSignal.removeEventListener("abort", onAbort)
				// A timeout observes this owner; it is not permanent producer truth.
				// An explicit retry joins the same original cleanup without relaunch.
				disposal = undefined
			})
			return disposal
		}
		const assertRejectedPresentationOwner = (assertOwnership?: () => void): void => {
			if (
				rejectedProjectionRevoked ||
				task.abort ||
				externalSignal.aborted ||
				task.taskId !== originalTaskId ||
				(process && process.executionId !== physicalExecutionId)
			) {
				throw new PreparedCommandCancelledError("Rejected command presentation ownership was revoked")
			}
			assertOwnership?.()
		}
		const onAbort = () => {
			void dispose().catch(() => undefined)
		}
		externalSignal.addEventListener("abort", onAbort, { once: true })
		await ready
		if (!reachedGate || signal.aborted) {
			await dispose()
			externalSignal.removeEventListener("abort", onAbort)
			await execution
			return undefined
		}
		return {
			run: async (runCallbacks) => {
				if (disposed || runCallbacks.signal?.aborted) {
					await dispose()
					throw new Error("Prepared command was cancelled")
				}
				if (started) throw new Error("Prepared command execution cannot be started twice")
				started = true
				start()
				await execution
				return async (assertOwnership) => {
					const assertPresentationOwner = () => {
						if (disposed || task.abort || signal.aborted || task.taskId !== originalTaskId) {
							throw new PreparedCommandCancelledError(
								"Prepared command presentation ownership was revoked",
							)
						}
						assertOwnership?.()
					}
					assertPresentationOwner()
					await presentation.open(assertPresentationOwner)
					assertPresentationOwner()
					presentationReady = true
				}
			},
			dispose: () => dispose(),
			settleRejectedRun: () => {
				if (rejectedRun) return rejectedRun
				const snapshot = presentation.takeFailurePresentation()
				const finalize = async (assertOwnership?: () => void) => {
					const assertOwner = () => assertRejectedPresentationOwner(assertOwnership)
					assertOwner()
					await snapshot(assertOwner)
					assertOwner()
					rejectedProjectionReady = true
				}
				rejectedRun = { cleanup: dispose(true), finalize }
				return rejectedRun
			},
			commit: () => {
				if (committed) return
				if (rejectedRun) {
					assertRejectedPresentationOwner()
					if (!rejectedProjectionReady) throw new Error("Rejected command presentation is not finalized")
					committed = true
					externalSignal.removeEventListener("abort", onAbort)
					return
				}
				if (!presentationReady || disposed || task.abort || signal.aborted || task.taskId !== originalTaskId) {
					throw new PreparedCommandCancelledError(
						"Prepared command ownership changed before presentation handoff",
					)
				}
				const ownsBackgroundPresentation = () =>
					!task.abort &&
					!lifetime.aborted &&
					task.taskId === originalTaskId &&
					(!process || process.executionId === physicalExecutionId)
				presentation.commit(
					() => {
						if (!ownsBackgroundPresentation()) {
							throw new PreparedCommandCancelledError(
								"Background command presentation ownership was revoked",
							)
						}
					},
					(error) => {
						if (error instanceof PreparedCommandCancelledError) return
						if (ownsBackgroundPresentation()) {
							if (callbacks.toolCallId)
								task.failCommandExecution?.(callbacks.toolCallId, "failed", physicalExecutionId)
							task.didToolFailInCurrentTurn = true
							task.suspendAfterCurrentTurn(t("common:errors.command_output_bookkeeping_incomplete"))
						}
						console.error("[ExecuteCommandTool] Background command projection failed", error)
					},
				)
				committed = true
				externalSignal.removeEventListener("abort", onAbort)
			},
		}
	}

	async execute(params: ExecuteCommandParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		return this.executeApproved(params, task, callbacks)
	}

	private async executeApproved(
		params: ExecuteCommandParams,
		task: Task,
		callbacks: ToolCallbacks,
		host?: PreparedCommandHost,
	): Promise<void> {
		const { command, tty, cwd: requestedCwd, timeout: timeoutSeconds, verification } = params
		const customCwd = requestedCwd ?? undefined
		const { handleError, pushToolResult, askApproval } = callbacks
		let commandResult: CommandToolResult | undefined
		let unpublishedSessionId: number | undefined
		let commandEvidenceId: string | undefined
		let effectsStarted: ToolFailureMetadata["effectsStarted"] = "no"
		let failure: ToolFailureMetadata | undefined
		const sessionHeader = (sessionId: number) => `Process running with session ID ${sessionId}`
		const assertSessionControlBudget = () => {
			const remaining = callbacks.getRemainingOutputChars?.()
			if (remaining === undefined) return
			// Reserve control framing, including the harness suffix, before a command can create a session.
			// The model's max_output_tokens applies to stdout; it must not remove the numeric handle.
			const framing =
				callbacks.commandResultFormat === "codex"
					? formatCommandToolResult(
							{
								wall_time_seconds: Number.MAX_SAFE_INTEGER,
								output: "",
								session_id: Number.MAX_SAFE_INTEGER,
							},
							0,
							callbacks.toolCallId ?? commandEvidenceId,
						)
					: sessionHeader(Number.MAX_SAFE_INTEGER) + "\n"
			const required = framing.length + TOOL_OUTPUT_TRUNCATION_SUFFIX.length
			if (remaining < required) {
				throw new Error(
					`Command was not started because its remaining tool output budget (${remaining} characters) cannot fit required session control information (${required} characters).`,
				)
			}
		}
		const pushCommandResult = (result: ToolResponse) => {
			if (callbacks.commandResultFormat === "codex" && commandResult && callbacks.pushCommandResult) {
				callbacks.pushCommandResult(
					typeof result === "string" ? commandResult : { ...commandResult, output: "" },
					typeof result === "string" ? undefined : result,
				)
				unpublishedSessionId = undefined
				return
			}
			let content: ToolResponse = result
			if (callbacks.commandResultFormat === "codex" && commandResult) {
				content =
					typeof result === "string"
						? formatCommandToolResult(
								commandResult,
								getCommandToolResultLimit(callbacks),
								callbacks.toolCallId ?? commandEvidenceId,
							)
						: [
								{
									type: "text",
									text: formatCommandToolResult(
										{ ...commandResult, output: "" },
										0,
										callbacks.toolCallId ?? commandEvidenceId,
									),
								},
								...result,
							]
			} else if (unpublishedSessionId !== undefined) {
				const header = sessionHeader(unpublishedSessionId)
				content =
					typeof content === "string" ? header + "\n" + content : [{ type: "text", text: header }, ...content]
			}
			pushToolResult(content)
			unpublishedSessionId = undefined
		}
		const reportFailure = (metadata: ToolFailureMetadata) => {
			failure = metadata
			callbacks.setResultMetadata?.({
				status:
					metadata.reason === "policy_denied" || metadata.reason === "approval_denied"
						? "denied"
						: metadata.reason === "cancelled"
							? "cancelled"
							: "error",
				failure: metadata,
			})
		}
		const preLaunchFailure = (
			reason: ToolFailureMetadata["reason"],
			recovery: ToolFailureMetadata["recovery"],
			identity: unknown = command,
		) => {
			reportFailure(
				createToolFailure({
					reason,
					scopeKind: "capability",
					scopeIdentity: ["execute_command", task.cwd, identity],
					effectsStarted: "no",
					outcome: "known",
					recovery,
				}),
			)
		}
		const denyByTaskCommandAuthority = (reason: string) => {
			if (commandEvidenceId) task.failCommandExecution?.(commandEvidenceId, "denied")
			task.recordToolError("exec_command", reason)
			preLaunchFailure("policy_denied", { kind: "user-action" }, "managed-child-command-authority")
			pushToolResult(formatResponse.toolError(reason))
		}
		try {
			if (!command) {
				preLaunchFailure("invalid_arguments", { kind: "repair" })
				callbacks.setResultMetadata?.({ status: "error" })
				task.consecutiveMistakeCount++
				task.recordToolError("execute_command")
				pushToolResult(await task.sayAndCreateMissingParamError("execute_command", "command"))
				return
			}

			// Native arguments already contain literal shell input; decoding changes approved intent.
			const canonicalCommand = command
			const executionId = task.lastMessageTs?.toString() ?? Date.now().toString()
			commandEvidenceId = callbacks.toolCallId ?? `${executionId}:legacy:${randomUUID()}`
			task.beginCommandExecution?.(commandEvidenceId, executionId, canonicalCommand, verification?.change_set_ids)

			const ignoredFileAttemptedToAccess = task.alphaIgnoreController?.validateCommand(canonicalCommand)

			if (ignoredFileAttemptedToAccess) {
				preLaunchFailure("policy_denied", { kind: "user-action" }, [
					"alphaignore",
					ignoredFileAttemptedToAccess,
				])
				callbacks.setResultMetadata?.({ status: "denied" })
				task.failCommandExecution?.(commandEvidenceId, "denied")
				await task.say("rooignore_error", ignoredFileAttemptedToAccess)
				pushToolResult(formatResponse.alphaIgnoreError(ignoredFileAttemptedToAccess))
				return
			}

			const initialAuthorityDenial = await task.getTaskCommandDenialReason?.(canonicalCommand, customCwd)
			if (initialAuthorityDenial) {
				denyByTaskCommandAuthority(initialAuthorityDenial)
				return
			}

			task.consecutiveMistakeCount = 0

			const askCommandApproval: NonNullable<ToolCallbacks["askCommandApproval"]> =
				callbacks.askCommandApproval ?? (async (...args) => ({ approved: await askApproval(...args) }))
			const commandProgressStatus = customCwd
				? { text: redactTaskPrivatePaths(task, path.resolve(task.cwd, customCwd)) }
				: undefined
			const approval = customCwd
				? await askCommandApproval("command", canonicalCommand, commandProgressStatus)
				: await askCommandApproval("command", canonicalCommand)

			if (!approval.approved) {
				task.failCommandExecution?.(commandEvidenceId, "denied")
				return
			}

			const postApprovalAuthorityDenial = await task.getTaskCommandDenialReason?.(canonicalCommand, customCwd)
			if (postApprovalAuthorityDenial) {
				denyByTaskCommandAuthority(postApprovalAuthorityDenial)
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
				preLaunchFailure("policy_denied", { kind: "user-action" }, ["mode", executionMode])
				callbacks.setResultMetadata?.({ status: "denied" })
				pushToolResult(
					formatResponse.toolError(
						`Command was not started because it is not allowed in the task's current ${executionMode} mode.`,
					),
				)
				return
			}

			const approvedExecutionId =
				approval.commandExecutionId ??
				(await task.presentApprovedCommand(canonicalCommand, commandProgressStatus))
			const provider = await task.providerRef.deref()
			// Terminal launch needs cached settings, not the full UI projection and its mode-file loading.
			const terminalShellIntegrationDisabled = provider?.getValue("terminalShellIntegrationDisabled") ?? true

			let commandExecutionTimeout: number
			if (callbacks.resolveCommandTimeoutMs) {
				// Ordinary and prepared commands use the same immutable step policy.
				commandExecutionTimeout = callbacks.resolveCommandTimeoutMs(0, canonicalCommand)
			} else {
				// Historical direct callers have no scheduler snapshot.
				const configuration = vscode.workspace.getConfiguration(Package.name)
				const timeoutSeconds = configuration.get<number>("commandExecutionTimeout", 0)
				const timeoutAllowlist = configuration.get<string[]>("commandTimeoutAllowlist", [])
				const allowlisted = getCommandDecision(canonicalCommand, timeoutAllowlist, []) === "auto_approve"
				commandExecutionTimeout = allowlisted ? 0 : timeoutSeconds * 1_000
			}

			// Convert agent-specified timeout from seconds to milliseconds
			const agentTimeout = resolveAgentTimeoutMs(timeoutSeconds)

			const options: ExecuteCommandOptions = {
				executionId: approvedExecutionId,
				toolCallId: commandEvidenceId,
				command: canonicalCommand,
				tty: tty ?? undefined,
				customCwd,
				verificationChangeSetIds: verification?.change_set_ids,
				terminalShellIntegrationDisabled,
				commandExecutionTimeout,
				agentTimeout,
				signal: host?.signal ?? callbacks.signal,
				...(host
					? {
							directCommand: host.directCommand,
							beforeLaunch: host.beforeLaunch,
							presentation: host.presentation,
							onProcessCreated: host.onProcessCreated,
							onCreationHookFailure: host.onCreationHookFailure,
							capturedExecutionMode: executionMode,
							capturedProvider: provider,
							capturedOutputPreviewSize: provider?.getValue("terminalOutputPreviewSize"),
						}
					: {}),
				onExecutionState: (state) => {
					effectsStarted = state
				},
				onCommandResult: (result) => {
					host?.onSession(result.session_id)
					unpublishedSessionId = result.session_id
					commandResult =
						callbacks.commandResultMaxOutputTokens === undefined
							? undefined
							: boundCommandToolResult(result, getCommandToolResultLimit(callbacks))
					if (host)
						callbacks.setResultMetadata?.({
							status: "success",
							executionStatus: result.session_id
								? "running"
								: result.exit_code === 0
									? "success"
									: "error",
							exitCode: result.exit_code,
							...(commandResult ? { commandResult } : {}),
						})
				},
				onFailure: reportFailure,
			}

			try {
				assertSessionControlBudget()
				// Serial preparation stops before collector admission, whose mutation
				// probes must remain behind the scheduler's real effect boundary.
				await host?.awaitRun()
				const [rejected, result] = await executeCommandInTerminal(task, options)

				if (rejected) {
					task.didRejectTool = true
				}

				pushCommandResult(result)
			} catch (error: unknown) {
				if (!(error instanceof ShellIntegrationError)) throw error
				if (tty === true) throw error

				const status: CommandExecutionStatus = { executionId: approvedExecutionId, status: "fallback" }
				provider?.postMessageToWebview({ type: "commandExecutionStatus", text: JSON.stringify(status) })
				await task.say("shell_integration_warning")

				// Invalidate pending ask from first execution to prevent race condition
				task.supersedePendingAsk()

				assertSessionControlBudget()
				const [rejected, result] = await executeCommandInTerminal(task, {
					...options,
					terminalShellIntegrationDisabled: true,
				})

				if (rejected) {
					task.didRejectTool = true
				}

				pushCommandResult(result)
			}

			return
		} catch (error) {
			if (error instanceof PreparedCommandCancelledError) {
				if (commandEvidenceId) task.failCommandExecution?.(commandEvidenceId, "cancelled")
				return
			}
			// A failed feedback/response formatter can hide the numeric handle after the process yielded.
			// Return unread output to terminal delivery only when its session result never reached the caller.
			if (unpublishedSessionId !== undefined) {
				commandSessionRegistry.release(task, unpublishedSessionId)
				commandResult = undefined
			}
			if (!failure) {
				const outcomeKnown =
					effectsStarted === "no" ||
					error instanceof CommandOutputBookkeepingError ||
					(error instanceof CommandMutationReceiptError && !error.observationUnknown)
				reportFailure(
					createToolFailure({
						reason:
							effectsStarted === "no"
								? "pre_launch_rejected"
								: outcomeKnown
									? "execution_failed"
									: "outcome_unknown",
						scopeKind: effectsStarted === "no" ? "capability" : "operation",
						scopeIdentity:
							effectsStarted === "no"
								? ["command-admission", task.cwd]
								: ["execute_command", task.cwd, command, customCwd],
						effectsStarted,
						outcome: outcomeKnown ? "known" : "unknown",
						recovery: { kind: outcomeKnown ? "repair" : "verify-outcome" },
					}),
				)
			}
			callbacks.setResultMetadata?.({ status: error instanceof ToolReadDeniedError ? "denied" : "error" })
			if (commandEvidenceId) {
				const evidenceId = commandEvidenceId
				const fail = () => {
					task.failCommandExecution?.(evidenceId, error instanceof ToolReadDeniedError ? "denied" : "failed")
				}
				if (host?.isRunAdmitted()) await host.presentation.publish("evidence", fail)
				else fail()
			}
			// The scheduler owns the speculative error receipt. Calling its ordinary
			// UI error callback here would publish before assistant durability.
			if (host) throw error
			await handleError("executing command", error as Error)
			return
		} finally {
			const publishMetadata = async (assertOwnership?: () => void) => {
				const evidence = task
					.getCommandExecutionEvidence?.()
					.find((item) => item.toolCallId === commandEvidenceId)
				if (evidence) {
					const completedProcessFailure =
						!failure &&
						evidence.status === "failed" &&
						typeof evidence.exitCode === "number" &&
						evidence.signalName === undefined
					if (
						!failure &&
						!completedProcessFailure &&
						evidence.status !== "succeeded" &&
						evidence.status !== "running"
					) {
						const unknown =
							effectsStarted !== "no" &&
							evidence.exitCode === undefined &&
							evidence.status !== "denied" &&
							evidence.status !== "cancelled"
						reportFailure(
							createToolFailure({
								reason: unknown
									? "outcome_unknown"
									: evidence.status === "denied"
										? "approval_denied"
										: evidence.status === "cancelled"
											? "cancelled"
											: "execution_failed",
								scopeKind: "operation",
								scopeIdentity: ["execute_command", task.cwd, command, customCwd],
								effectsStarted,
								outcome: unknown ? "unknown" : "known",
								recovery: { kind: unknown ? "verify-outcome" : "repair" },
							}),
						)
					}
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
					assertOwnership?.()
					callbacks.setResultMetadata?.({
						executionStatus:
							evidence.status === "running"
								? "running"
								: evidence.status === "succeeded"
									? "success"
									: evidence.status === "denied" || evidence.status === "cancelled"
										? evidence.status
										: "error",
						status:
							evidence.status === "succeeded" || evidence.status === "running" || completedProcessFailure
								? "success"
								: evidence.status === "denied" || evidence.status === "cancelled"
									? evidence.status
									: "error",
						exitCode: evidence.exitCode,
						...(commandResult ? { commandResult } : {}),
						timedOut: evidence.status === "timed_out",
						...(trustedExploration ? { trustedExploration } : {}),
					})
				}
			}
			if (host) await host.presentation.publish("metadata", publishMetadata)
			else await publishMetadata()
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
	tty?: boolean
	customCwd?: string
	verificationChangeSetIds?: readonly string[]
	terminalShellIntegrationDisabled?: boolean
	commandExecutionTimeout?: number
	agentTimeout?: number
	/** Host-only audited transport; never read from model parameters. */
	directCommand?: DirectTerminalCommand
	beforeLaunch?: () => Promise<void>
	/** Cancels admission; a successfully launched resumable process belongs to the task. */
	signal?: AbortSignal
	/** Internal presentation owner used only by an approved prepared read. */
	presentation?: DeferredCommandPresentation
	onProcessCreated?: (process: AlphaTerminalProcess, isArchiveClosed: () => boolean) => void
	onCreationHookFailure?: (process: AlphaTerminalProcess) => void
	capturedExecutionMode?: string
	capturedProvider?: ReturnType<Task["providerRef"]["deref"]>
	capturedOutputPreviewSize?: TerminalOutputPreviewSize
	/** Trusted launch boundary for distinguishing rejection from an unknown process outcome. */
	onExecutionState?: (state: ToolFailureMetadata["effectsStarted"]) => void
	onCommandResult?: (result: CommandToolResult) => void
	onFailure?: (failure: ToolFailureMetadata) => void
}

export async function executeCommandInTerminal(
	task: Task,
	{
		executionId,
		toolCallId,
		command,
		tty,
		customCwd,
		verificationChangeSetIds,
		terminalShellIntegrationDisabled = true,
		commandExecutionTimeout = 0,
		agentTimeout = 0,
		onExecutionState,
		onCommandResult,
		onFailure,
		directCommand,
		beforeLaunch,
		signal,
		presentation,
		onProcessCreated,
		onCreationHookFailure,
		capturedExecutionMode,
		capturedProvider,
		capturedOutputPreviewSize,
	}: ExecuteCommandOptions,
): Promise<[boolean, ToolResponse]> {
	const commandStartedAt = performance.now()
	const project = (
		slot: CommandPresentationSlot,
		operation: (assertOwnership?: () => void) => void | Promise<void>,
	): Promise<void> => {
		if (presentation) return presentation.publish(slot, operation)
		return Promise.resolve(operation())
	}
	// Convert milliseconds back to seconds for display purposes.
	const commandExecutionTimeoutSeconds = commandExecutionTimeout / 1000
	let workingDir: string
	const physicalExecutionId = `${executionId}:${randomUUID()}`
	let fileChangeTurnKey = task.clineMessages?.[0]?.ts ?? 0
	for (let index = (task.clineMessages?.length ?? 0) - 1; index >= 0; index--) {
		const message = task.clineMessages[index]
		if (message.type === "say" && message.say === "user_feedback") {
			fileChangeTurnKey = message.ts
			break
		}
	}
	let mutationBaseline: WorkspaceMutationState | undefined
	let diffBaseline: WorkspaceMutationDiffBaseline | undefined
	let mutationReceiptCompletion: Promise<WorkspaceMutationDiff[]> | undefined
	let commandMutationCompletion = Promise.resolve()
	let commandMutationFailureHandling: Promise<{ recoveryError?: unknown }> | undefined
	let commandTerminalOutcomeFenced = false
	let fileChangesPublished = false

	const isManagedWorker = task.taskKind === "subagent" && task.subagentRole === "worker"
	const executionMode =
		capturedExecutionMode ?? (typeof task.getTaskMode === "function" ? await task.getTaskMode() : defaultModeSlug)
	const isPlanMode = executionMode === planModeSlug
	const rejectBeforeLaunch = (reason: ToolFailureMetadata["reason"], scope: unknown) =>
		onFailure?.(
			createToolFailure({
				reason,
				scopeKind: "workspace",
				scopeIdentity: ["command-directory", task.cwd, scope],
				effectsStarted: "no",
				outcome: "known",
				recovery: { kind: reason === "policy_denied" ? "user-action" : "repair" },
			}),
		)
	const restrictCommandCwdToWorkspace = isManagedWorker || isPlanMode
	const cancellationResult = (): [boolean, ToolResponse] => {
		if (toolCallId)
			void project("evidence", () => {
				task.failCommandExecution?.(toolCallId, "cancelled")
			})
		return [false, "Command was not started because the task was cancelled."]
	}
	let stepOwnsLaunch = true
	const taskWasCancelled = () =>
		task.abort || (stepOwnsLaunch && signal?.aborted) || task.getTaskLifetimeCancellationSignal().aborted
	if (taskWasCancelled()) return cancellationResult()
	if (tty === true && (isManagedWorker || isPlanMode)) {
		rejectBeforeLaunch("policy_denied", "interactive-terminal")
		if (toolCallId)
			void project("evidence", () => {
				task.failCommandExecution?.(toolCallId, "denied")
			})
		return [false, "Interactive terminals require a foreground Code task; this command was not started."]
	}
	if (restrictCommandCwdToWorkspace && customCwd && path.isAbsolute(customCwd)) {
		rejectBeforeLaunch("policy_denied", customCwd)
		if (toolCallId)
			void project("evidence", () => {
				task.failCommandExecution?.(toolCallId)
			})
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

	let outsideWorkspaceDirectory: string | undefined
	try {
		await fs.access(workingDir)
		if (restrictCommandCwdToWorkspace) {
			const [realWorkspace, realWorkingDir] = await Promise.all([fs.realpath(task.cwd), fs.realpath(workingDir)])
			const relative = path.relative(realWorkspace, realWorkingDir)
			if (relative.startsWith("..") || path.isAbsolute(relative)) {
				outsideWorkspaceDirectory = realWorkingDir
			}
		}
	} catch (error) {
		rejectBeforeLaunch("pre_launch_rejected", workingDir)
		if (toolCallId)
			void project("evidence", () => {
				task.failCommandExecution?.(toolCallId)
			})
		return [
			false,
			`Working directory '${restrictCommandCwdToWorkspace ? customCwd || "." : workingDir}' does not exist.`,
		]
	}
	if (outsideWorkspaceDirectory) {
		rejectBeforeLaunch("policy_denied", outsideWorkspaceDirectory)
		if (toolCallId)
			void project("evidence", () => {
				task.failCommandExecution?.(toolCallId)
			})
		return [
			false,
			isPlanMode
				? "Plan command directory resolves outside the task workspace."
				: "Editing worker command directory is outside its isolated workspace.",
		]
	}

	let message: { text?: string; images?: string[] } | undefined
	let runInBackground = false
	let completed = false
	let result: string = ""
	let persistedResult: PersistedCommandOutput | undefined
	let exitDetails: ExitCodeDetails | undefined
	let shellIntegrationError: string | undefined
	let terminalProcessFailure: CommandExecutionLifecycleError | undefined
	let terminalProcessFailureHandling: Promise<void> | undefined
	let hasAskedForCommandOutput = false

	// Managed workers run unattended and must use the terminal provider whose
	// process tree can be deterministically terminated by task cancellation.
	const terminalProvider =
		tty === true
			? "vscode"
			: tty === false || isManagedWorker || terminalShellIntegrationDisabled
				? "execa"
				: "vscode"
	const provider = capturedProvider ?? (await task.providerRef.deref())
	const postStatus = (status: CommandExecutionStatus): void => {
		const slot =
			status.status === "started" ? "started" : status.status === "output" ? "output-status" : "terminal-status"
		void project(slot, async () => {
			await provider?.postMessageToWebview({ type: "commandExecutionStatus", text: JSON.stringify(status) })
		}).catch((error) => console.error("[ExecuteCommandTool] Could not publish command status", error))
	}
	const handleCommandMutationFailure = (error: unknown): Promise<{ recoveryError?: unknown }> => {
		commandMutationFailureHandling ??= (async () => {
			const receiptError =
				error instanceof CommandMutationReceiptError
					? error
					: new CommandMutationReceiptError("complete-command-evidence", false, error)
			let recoveryError: unknown
			if (receiptError.observationUnknown) {
				try {
					const owner = provider
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
					mutationReceiptCompletion = Promise.resolve([])
				} catch (recoveryFailure) {
					recoveryError = recoveryFailure
				}
			}

			await project("failure", () => {
				if (toolCallId) task.failCommandExecution?.(toolCallId, "failed", physicalExecutionId)
				task.didToolFailInCurrentTurn = true
				task.suspendAfterCurrentTurn(
					receiptError.observationUnknown
						? t("common:errors.command_mutation_observation_incomplete")
						: t("common:errors.command_mutation_receipt_incomplete"),
				)
			})
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
	const observeCommandMutationFailure = <T>(operation: Promise<T>): Promise<T> =>
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
	const ensureMutationReceipt = (): Promise<WorkspaceMutationDiff[]> => {
		mutationReceiptCompletion ??= observeCommandMutationFailure(
			finalizeCommandMutationReceipt(task, provider, mutationBaseline, diffBaseline, physicalExecutionId, () => {
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
			const owner = provider
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
		const terminalOutputPreviewSize =
			capturedOutputPreviewSize ??
			(presentation ? undefined : provider?.getValue("terminalOutputPreviewSize")) ??
			DEFAULT_TERMINAL_OUTPUT_PREVIEW_SIZE

		interceptor = new OutputInterceptor({
			executionId,
			taskId: task.taskId,
			command,
			storageDir,
			previewSize: terminalOutputPreviewSize,
		})
	}
	let archiveFinalization: Promise<void> | undefined
	const finalizeOutputArchive = (process: AlphaTerminalProcess): Promise<void> => {
		archiveFinalization ??= (async () => {
			if (!interceptor) return
			try {
				const finalized = await interceptor.finalize()
				if (process?.outputArchiveInterrupted) return
				persistedResult = finalized
				if (process && finalized.artifactPath) process.outputArtifactId = path.basename(finalized.artifactPath)
			} catch (error) {
				if (!(error instanceof OutputArchiveInterruptedError)) throw error
			}
		})()
		return archiveFinalization
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
		return project("command-output", async (assertOwnership) => {
			commandOutputSayChain = commandOutputSayChain.then(async () => {
				assertOwnership?.()
				try {
					await task.say("command_output", text, undefined, partial, undefined, undefined, {
						isNonInteractive: true,
						commandExecutionId: executionId,
					})
				} catch (error) {
					console.error("[ExecuteCommandTool] Failed to publish command output:", error)
				}
				assertOwnership?.()
			})

			await commandOutputSayChain
		})
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

	// Track output bookkeeping for foreground and yielded commands. The VS Code
	// terminal does not await this callback; Execa also joins its own observers.
	let onCompletedPromise: Promise<void> | undefined
	let resolveOnCompleted: (() => void) | undefined
	let rejectOnCompleted: ((error: CommandOutputBookkeepingError) => void) | undefined
	let onCompletedInvoked = false
	let missingOutputCompletionTimer: NodeJS.Timeout | undefined
	let backgroundResultReturned = false
	let outputBookkeepingFailure: CommandOutputBookkeepingError | undefined
	let outputBookkeepingFailureHandling: Promise<void> | undefined
	const handleBackgroundOutputBookkeepingFailure = (): Promise<void> => {
		if (!backgroundResultReturned || !outputBookkeepingFailure || !exitDetails) return Promise.resolve()
		const failure = outputBookkeepingFailure
		if (!outputBookkeepingFailureHandling) {
			outputBookkeepingFailureHandling = (async () => {
				// The terminal completion callback owns mutation settlement and may still be
				// running. Wait for it before marking the already-returned command failed so
				// its success projection cannot overwrite this bookkeeping failure.
				await commandMutationCompletion.catch(() => undefined)
				await project("failure", () => {
					if (toolCallId) task.failCommandExecution?.(toolCallId, "failed", physicalExecutionId)
					task.didToolFailInCurrentTurn = true
					task.suspendAfterCurrentTurn(t("common:errors.command_output_bookkeeping_incomplete"))
				})
				console.error(`[ExecuteCommandTool] ${redactTaskPrivatePaths(task, failure.message)}`, failure)
			})()
			void outputBookkeepingFailureHandling.catch((error: unknown) => {
				console.error("[ExecuteCommandTool] Failed to preserve background output bookkeeping failure", error)
			})
		}
		return outputBookkeepingFailureHandling
	}
	onCompletedPromise = new Promise((resolve, reject) => {
		resolveOnCompleted = resolve
		rejectOnCompleted = reject
	})
	// Observe immediately for adapters that do not await async callbacks, while
	// retaining the original promise for the foreground join.
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

	let createdProcess: AlphaTerminalProcess | undefined
	const outputArchive = {
		archiveExecutionId: executionId,
		isClosed: () => interceptor?.isOutputClosed() ?? true,
	}
	const bindCreatedProcess = (process: AlphaTerminalProcess): void => {
		if (createdProcess) {
			if (createdProcess !== process || process.executionId !== physicalExecutionId) {
				throw new Error("Command process identity changed after its archival ownership was bound")
			}
			return
		}
		process.executionId = physicalExecutionId
		createdProcess = process
		onProcessCreated?.(process, outputArchive.isClosed)
		commandSessionRegistry.trackTaskOutput(task, process, physicalExecutionId, outputArchive)
	}
	const callbacks: AlphaTerminalCallbacks = {
		onProcessCreated: (process) => {
			try {
				bindCreatedProcess(process)
			} catch (error) {
				onCreationHookFailure?.(process)
				throw error
			}
		},
		onOutput: (chunk, _process, signal) => interceptor?.writeWithBackpressure(chunk, signal),
		onOutputClosed: async (process) => {
			try {
				await finalizeOutputArchive(process)
			} catch (error) {
				process.outputArchiveInterrupted = true
				process.outputArtifactId = undefined
				outputBookkeepingFailure ??= new CommandOutputBookkeepingError(error)
				rejectOnCompleted?.(outputBookkeepingFailure)
				// A reader error already owns its actionable failure and unknown
				// mutation receipt. Closing its archive must not replace that error.
				if (!terminalProcessFailure) void handleBackgroundOutputBookkeepingFailure()
				throw outputBookkeepingFailure
			}
		},
		onLine: (lines: string, process: AlphaTerminalProcess) => {
			accumulatedOutput += lines

			// Trim accumulated output to prevent unbounded memory growth
			if (accumulatedOutput.length > maxAccumulatedOutputSize) {
				accumulatedOutput = accumulatedOutput.slice(-maxAccumulatedOutputSize)
			}

			// Continue sending compressed output to webview for UI display (unchanged behavior)
			const compressedOutput = Terminal.compressTerminalOutput(accumulatedOutput)
			latestCompressedOutput = compressedOutput
			const status: CommandExecutionStatus = { executionId, status: "output", output: compressedOutput }
			postStatus(status)
			schedulePartialCommandOutputUpdate()

			if (presentation || runInBackground || hasAskedForCommandOutput) {
				return
			}

			// Mark that we've asked to prevent multiple concurrent asks
			hasAskedForCommandOutput = true

			// The command controller owns this user interaction. Output delivery
			// must settle independently so physical completion can join its callbacks.
			void (async () => {
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
			})()
		},
		onCompleted: async (output: string | undefined, process: AlphaTerminalProcess) => {
			onCompletedInvoked = true
			clearTimeout(missingOutputCompletionTimer)
			missingOutputCompletionTimer = undefined
			try {
				clearTimeout(pendingCommandOutputEmitTimer)
				pendingCommandOutputEmitTimer = undefined

				// Finalize interceptor and get persisted result.
				// We await finalize() to ensure the artifact file is fully flushed
				// before we advertise the artifact_id to the LLM.
				await finalizeOutputArchive(process)

				// Continue using compressed output for UI display
				result = Terminal.compressTerminalOutput(output ?? "")
				if (interceptor?.isInterrupted() || process?.outputArchiveInterrupted) {
					result += `\n${t("common:errors.command_output_archive_interrupted")}`
				}
				latestCompressedOutput = result

				// Preserve order: wait for queued partial updates, then emit the final
				// non-partial command_output update.
				if (!presentation) await commandOutputSayChain
				const artifactNotice = process?.outputArtifactId
					? `\nArtifact ID: ${process.outputArtifactId}\nUse write_stdin with this artifact_id to view more output.`
					: ""
				await queueCommandOutputMessage(result + artifactNotice, false, true)
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
			postStatus(status)
		},
		onShellExecutionComplete: (details: ExitCodeDetails) => {
			const status: CommandExecutionStatus = { executionId, status: "exited", exitCode: details.exitCode }
			postStatus(status)
			exitDetails = details
			// A process-level failure already persisted unknown mutation debt and owns
			// the terminal evidence. Late success callbacks may flush output, but must
			// never settle that reservation again or overwrite the failed outcome.
			if (commandMutationFailureHandling || commandTerminalOutcomeFenced) return
			scheduleMissingOutputCompletionFailure()
			commandMutationCompletion = observeCommandMutationFailure(
				(async () => {
					const fileChanges = await ensureMutationReceipt()
					// Output persistence is not mutation observation, but command success
					// must not be published until it has settled. A rejected output gate is
					// surfaced separately by the foreground join or background observer.
					await onCompletedPromise?.catch(() => undefined)
					if (outputBookkeepingFailure || commandMutationFailureHandling || commandTerminalOutcomeFenced)
						return
					if (toolCallId) {
						try {
							await project("evidence", () => {
								task.completeCommandExecution?.(toolCallId, details, physicalExecutionId)
							})
						} catch (error) {
							throw new CommandMutationReceiptError("complete-command-evidence", false, error)
						}
					}
					if (details.exitCode === 0 && !details.signalName && !taskWasCancelled() && !fileChangesPublished) {
						fileChangesPublished = true
						await project("file-changes", async (assertOwnership) => {
							for (const change of fileChanges) {
								assertOwnership?.()
								const payload = JSON.stringify({
									tool: "appliedDiff",
									...change,
									changeStatus: "applied",
									commandExecutionId: physicalExecutionId,
								})
								if (!reserveFileChangeMessageBytes(task, fileChangeTurnKey, Buffer.byteLength(payload)))
									break
								await task
									.say("tool", payload, undefined, false, undefined, undefined, {
										isNonInteractive: true,
									})
									.catch((error) =>
										console.warn(
											`[ExecuteCommandTool] Could not publish completed file change for ${redactTaskPrivatePaths(task, change.path)} (${physicalExecutionId}): ${redactTaskPrivatePaths(task, String(error)).slice(0, 256)}`,
										),
									)
								assertOwnership?.()
							}
						})
					}
				})(),
			)
			void commandMutationCompletion.catch(() => undefined)
			void handleBackgroundOutputBookkeepingFailure()
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
	const releaseTerminalReservation = () => TerminalRegistry.releaseTerminalReservation(terminal, task.taskId)
	if (taskWasCancelled()) {
		releaseTerminalReservation()
		return cancellationResult()
	}

	if (terminal instanceof Terminal) {
		try {
			terminal.terminal.show(true)

			// Update the working directory in case the terminal we asked for has
			// a different working directory so that the model will know where the
			// command actually executed.
			workingDir = terminal.getCurrentWorkingDirectory()
		} catch (error) {
			releaseTerminalReservation()
			throw error
		}
	}

	if (task.taskKind === "primary") {
		try {
			mutationBaseline = await captureWorkspaceMutationState(task.cwd)
			try {
				diffBaseline = await captureWorkspaceMutationDiffBaseline(task.cwd, mutationBaseline)
			} catch {
				// Presentation evidence is optional; the mutation receipt remains authoritative.
			}
		} catch {
			workspaceObservationIncomplete = true
		}
	}
	let admissionFailure: { error: unknown; cancelled: boolean } | undefined
	try {
		if (taskWasCancelled()) {
			releaseTerminalReservation()
			return cancellationResult()
		}
		if (task.taskKind === "primary") {
			const owner = provider
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
		releaseTerminalReservation()
		await releaseMutationReservationBeforeLaunch(admissionFailure.error)
		if (admissionFailure.cancelled) return cancellationResult()
		throw new CommandExecutionLifecycleError("admit-command", admissionFailure.error)
	}
	if (taskWasCancelled()) {
		releaseTerminalReservation()
		await releaseMutationReservationBeforeLaunch(new Error("Command admission was cancelled"))
		return cancellationResult()
	}
	try {
		await beforeLaunch?.()
	} catch (error) {
		releaseTerminalReservation()
		await releaseMutationReservationBeforeLaunch(error)
		if (taskWasCancelled()) return cancellationResult()
		if (error instanceof ToolReadDeniedError) {
			rejectBeforeLaunch("policy_denied", workingDir)
			if (toolCallId)
				await project("evidence", () => {
					task.failCommandExecution?.(toolCallId, "denied", physicalExecutionId)
				})
			throw error
		}
		throw new CommandExecutionLifecycleError("admit-command", error)
	}
	if (taskWasCancelled()) {
		releaseTerminalReservation()
		await releaseMutationReservationBeforeLaunch(new Error("Command launch was cancelled"))
		return cancellationResult()
	}
	let process: ReturnType<AlphaTerminal["runCommand"]>
	try {
		onExecutionState?.("unknown")
		process = terminal.runCommand(command, callbacks, directCommand)
		// Canonical adapters already bound ownership before launch. Retain the
		// same binding for older adapters/fixtures that omit the creation hook.
		bindCreatedProcess(process)
		// A valid resumable process survives request steering. Prepared reads keep
		// their separate disposal owner until the scheduler commits presentation.
		stepOwnsLaunch = false
		onExecutionState?.("yes")
	} catch (error) {
		releaseTerminalReservation()
		let launchCause = error
		// A canonical creation-hook throw precedes spawn. Its adapter already owns
		// finalization; join that exact archive without assimilating the process.
		if (createdProcess?.waitForOutputFinalization) {
			const [archive] = await Promise.allSettled([createdProcess.waitForOutputFinalization()])
			if (archive.status === "rejected")
				launchCause = new AggregateError(
					[error, archive.reason],
					"Command creation and archive closure failed",
					{ cause: error },
				)
		}
		const launchError = new CommandExecutionLifecycleError("launch-command", launchCause)
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
			await project("evidence", () => {
				task.failCommandExecution?.(toolCallId, "failed", physicalExecutionId)
			})
		}
		throw launchError
	}
	task.terminalProcess = process
	const onTerminalProcessError = (error: Error) => {
		if (commandTerminalOutcomeFenced) return
		commandTerminalOutcomeFenced = true
		terminalProcessFailure = new CommandExecutionLifecycleError("await-command-process", error)
		if (!onCompletedInvoked) {
			// Process disposal owns this failure. Settle the output join now so the
			// missing-completion timer cannot finalize the same command a second time.
			clearTimeout(missingOutputCompletionTimer)
			missingOutputCompletionTimer = undefined
			outputBookkeepingFailure ??= new CommandOutputBookkeepingError(error)
			rejectOnCompleted?.(outputBookkeepingFailure)
		}
		terminalProcessFailureHandling = (async () => {
			// A yielded command no longer has a foreground promise to report failure.
			// Preserve its unknown physical mutation scope instead of leaving a live
			// reservation and running command evidence behind after the terminal closes.
			if (!exitDetails && mutationReservationAcquired) {
				const receiptError = new CommandMutationReceiptError(
					"process-outcome-unknown",
					true,
					terminalProcessFailure,
				)
				const { recoveryError } = await handleCommandMutationFailure(receiptError)
				if (recoveryError) throw recoveryError
			} else {
				await project("failure", () => {
					if (toolCallId) task.failCommandExecution?.(toolCallId, "failed", physicalExecutionId)
					task.didToolFailInCurrentTurn = true
					if (exitDetails && backgroundResultReturned)
						task.suspendAfterCurrentTurn(t("common:errors.command_output_bookkeeping_incomplete"))
				})
			}
		})()
		void terminalProcessFailureHandling.catch((failure) =>
			console.error("[ExecuteCommandTool] Failed to preserve terminal process failure", failure),
		)
	}
	process.once("error", onTerminalProcessError)
	process.once("completed", () => {
		// The process is thenable; returning it makes the completion barrier wait on itself.
		process.removeListener("error", onTerminalProcessError)
	})

	// Dual-timeout logic:
	// - Agent timeout: transitions the command to background (continues running).
	// - User timeout: remains a hard process-lifetime ceiling and aborts the
	//   registry-owned process even if the agent timeout returned first.
	let agentTimeoutId: NodeJS.Timeout | undefined
	let userTimeoutId: NodeJS.Timeout | undefined
	let isUserTimedOut = false
	let userTimeoutFinalization: Promise<void> | undefined
	const finalizeUserTimeout = (): Promise<void> => {
		if (userTimeoutFinalization) return userTimeoutFinalization
		// This owner outlives the foreground race. The agent may already have
		// received a background session when the process-lifetime timeout fires.
		userTimeoutFinalization = (async () => {
			try {
				await Promise.resolve().then(() => process.abort())
			} catch (error) {
				const cleanupError = new CommandExecutionLifecycleError(
					"await-command-process",
					new Error(
						`Command exceeded its timeout and process cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
						{ cause: error },
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

			if (!mutationReservationAcquired) return
			const timeoutError = new CommandExecutionLifecycleError(
				"await-command-process",
				new Error(`Command execution timed out after ${commandExecutionTimeout}ms`),
			)
			if (exitDetails) {
				// Abort reported the physical exit. Its ordinary callback is fenced,
				// so this owner must settle the exact/no-op receipt itself.
				try {
					await ensureMutationReceipt()
				} catch (receiptError) {
					throw new AggregateError(
						[timeoutError, receiptError],
						"Timed-out command mutation receipt could not be finalized",
					)
				}
			} else {
				const receiptError = new CommandMutationReceiptError("process-outcome-unknown", true, timeoutError)
				const { recoveryError } = await handleCommandMutationFailure(receiptError)
				if (recoveryError) {
					throw new AggregateError(
						[timeoutError, receiptError, recoveryError],
						"Timed-out command ended without an observable outcome and unresolved debt could not be persisted",
					)
				}
			}
		})()
		// A yielded command has no foreground caller left to observe rejection.
		void userTimeoutFinalization.catch((error) => console.error("Timed-out command finalization failed:", error))
		return userTimeoutFinalization
	}

	try {
		const racers: Promise<void>[] = [process]

		// Agent timeout: transition to background (command keeps running)
		if (agentTimeout > 0) {
			racers.push(
				new Promise<void>((resolve) => {
					agentTimeoutId = setTimeout(() => {
						runInBackground = true
						process.continue()
						if (!presentation) task.supersedePendingAsk()
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
						const finalization = finalizeUserTimeout()
						try {
							void project("evidence", () => {
								if (toolCallId)
									task.failCommandExecution?.(toolCallId, "timed_out", physicalExecutionId)
							})
							const status: CommandExecutionStatus = { executionId, status: "timeout" }
							postStatus(status)
						} catch (error) {
							console.error("Failed to project a command timeout:", error)
						}
						if (runInBackground) {
							void project("failure", async (assertOwnership) => {
								assertOwnership?.()
								task.didToolFailInCurrentTurn = true
								await task.say(
									"error",
									t("common:errors:command_timeout", { seconds: commandExecutionTimeoutSeconds }),
								)
								assertOwnership?.()
							}).catch((error) => console.error("Failed to report a background command timeout:", error))
						}
						void finalization.then(
							() => reject(new Error(`Command execution timed out after ${commandExecutionTimeout}ms`)),
							(error) => reject(error),
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
		if (isUserTimedOut) {
			await finalizeUserTimeout()
			await project("failure", async (assertOwnership) => {
				assertOwnership?.()
				await task.say("error", t("common:errors:command_timeout", { seconds: commandExecutionTimeoutSeconds }))
				assertOwnership?.()
				task.didToolFailInCurrentTurn = true
			})
			if (task.terminalProcess === process) task.terminalProcess = undefined

			return [
				false,
				`The command was terminated after exceeding a user-configured ${commandExecutionTimeoutSeconds}s timeout. Do not try to re-run the command.`,
			]
		}

		const processError = new CommandExecutionLifecycleError("await-command-process", error)
		const failures: unknown[] = [processError]
		if (terminalProcessFailureHandling) {
			const [failureHandling] = await Promise.allSettled([terminalProcessFailureHandling])
			if (failureHandling.status === "rejected") failures.push(failureHandling.reason)
		}
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
		if (toolCallId && !terminalProcessFailureHandling && !commandMutationFailureHandling)
			await project("evidence", () => {
				task.failCommandExecution?.(toolCallId, "failed", physicalExecutionId)
			})
		if (failures.length > 1) {
			throw new AggregateError(
				failures,
				`Command process and completion bookkeeping failed: ${processError.message}`,
			)
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
		if (task.terminalProcess === process) task.terminalProcess = undefined
	}

	if (shellIntegrationError) {
		const shellError = new ShellIntegrationError(shellIntegrationError)
		const completions: Promise<unknown>[] = [ensureMutationReceipt()]
		if (onCompletedInvoked && onCompletedPromise) completions.push(onCompletedPromise)
		const completionResults = await Promise.allSettled(completions)
		if (toolCallId)
			await project("evidence", () => {
				task.failCommandExecution?.(toolCallId, "failed", physicalExecutionId)
			})
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
	if (!presentation) await delay(50)
	if (terminalProcessFailure) {
		await terminalProcessFailureHandling
		throw terminalProcessFailure
	}

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
	const sessionId =
		!completed &&
		!exitDetails &&
		!process.isSettled &&
		terminal.taskId === task.taskId &&
		terminal.process === process &&
		terminal.running
			? commandSessionRegistry.register(task, process)
			: undefined
	if (toolCallId && (message || (!completed && !exitDetails))) {
		await project("evidence", () => {
			task.markCommandExecutionBackgrounded?.(toolCallId, physicalExecutionId)
		})
	}
	if (!completed && !exitDetails) {
		backgroundResultReturned = true
		void handleBackgroundOutputBookkeepingFailure()
	}
	onCommandResult?.({
		wall_time_seconds: Math.max(0, (performance.now() - commandStartedAt) / 1000),
		output: redactTaskPrivatePaths(task, persistedResult?.truncated ? persistedResult.preview : displayOutput),
		...(typeof exitDetails?.exitCode === "number" ? { exit_code: exitDetails.exitCode } : {}),
		...(sessionId !== undefined ? { session_id: sessionId } : {}),
		...(persistedResult?.truncated && persistedResult.artifactPath
			? { artifact_id: path.basename(persistedResult.artifactPath) }
			: {}),
	})

	if (message) {
		const { text, images } = message
		await task.say("user_feedback", text, images)

		return [
			true,
			formatResponse.toolResult(
				redactTaskPrivatePaths(
					task,
					[
						`Command is still running in terminal from '${terminal.getCurrentWorkingDirectory().toPosix()}'. execution_id: ${physicalExecutionId}.${sessionId === undefined ? "" : ` session_id: ${sessionId}. Use write_stdin to wait for output or send input.`}`,
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
					`Command is still running in terminal ${workingDir ? ` from '${isManagedWorker ? "." : workingDir.toPosix()}'` : ""}. execution_id: ${physicalExecutionId}.${sessionId === undefined ? "" : ` session_id: ${sessionId}. Use write_stdin to wait for output or send input.`}`,
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
		"Use write_stdin with this artifact_id to view more output.",
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
