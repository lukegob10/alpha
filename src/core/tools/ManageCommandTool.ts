import { z } from "zod"
import { t } from "../../i18n"
import { BaseTool, type ToolCallbacks } from "./BaseTool"
import type { Task } from "../task/Task"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"
import type { AlphaTerminalProcess } from "../../integrations/terminal/types"
import type { NativeToolArgs } from "../../shared/tools"
import { MANAGE_COMMAND_MAX_TIMEOUT_MS, WRITE_STDIN_MIN_POLL_MS, WRITE_STDIN_QUIET_POLL_MS } from "./commandTimeouts"
import { commandSessionRegistry } from "./CommandSessionRegistry"
import { readCommandOutputTool } from "./ReadCommandOutputTool"
import type { CommandToolResult } from "@alpha-code/types"
import { boundCommandToolResult, formatCommandToolResult, getCommandToolResultLimit } from "./BaseTool"

const paramsSchema = z.discriminatedUnion("action", [
	z.object({
		execution_id: z.string().min(1).max(256),
		action: z.enum(["wait", "stop", "input"]),
		input: z.string().max(16_384).nullish(),
		timeout_ms: z.number().int().min(0).max(MANAGE_COMMAND_MAX_TIMEOUT_MS).nullish(),
	}),
	z.object({
		action: z.literal("read"),
		artifact_id: z.string().min(1),
		search: z.string().min(1).optional(),
		offset: z.number().int({ error: "Invalid offset" }).min(0).optional(),
		limit: z.number().int({ error: "Invalid limit" }).min(1).optional(),
	}),
])

export async function waitForCommand(
	process: AlphaTerminalProcess,
	timeoutMs: number,
	signal?: AbortSignal,
	returnOnOutput = false,
): Promise<void> {
	signal?.throwIfAborted()
	// Codex e58bf8f5 collects until the deadline or exit. Alpha's longer
	// default wait after a quiet poll yields early when progress is available.
	const hasNewOutput = () => returnOnOutput && process.hasUnretrievedOutput()
	if (process.isSettled || timeoutMs === 0 || hasNewOutput()) return
	await new Promise<void>((resolve, reject) => {
		const finish = () => {
			cleanup()
			resolve()
		}
		const cancel = () => {
			cleanup()
			reject(signal?.reason ?? new Error("Command wait cancelled"))
		}
		const onOutput = () => {
			if (hasNewOutput()) finish()
		}
		const timer = setTimeout(finish, timeoutMs)
		const cleanup = () => {
			clearTimeout(timer)
			process.off("completed", finish)
			process.off("error", finish)
			if (returnOnOutput) process.off("output_available", onOutput)
			signal?.removeEventListener("abort", cancel)
		}
		process.once("completed", finish)
		process.once("error", finish)
		if (returnOnOutput) process.on("output_available", onOutput)
		signal?.addEventListener("abort", cancel, { once: true })
		if (signal?.aborted) cancel()
		else if (process.isSettled || hasNewOutput()) finish()
	})
}

function publishCommandWait(task: Task): void {
	const provider = task.providerRef?.deref()
	void provider?.postTaskSessionStateToWebview?.({ includeManagedAgentTree: false }).catch(() => {
		provider.log("Failed to publish command wait status")
	})
}

export class ManageCommandTool extends BaseTool<"manage_command"> {
	readonly name = "manage_command" as const
	async execute(
		raw: NativeToolArgs["manage_command"],
		task: Task,
		callbacks: ToolCallbacks,
		assertSessionCurrent?: () => void,
		sessionId?: number,
		sessionProcess?: AlphaTerminalProcess,
	): Promise<void> {
		const startedAt = performance.now()
		let wait: ReturnType<typeof commandSessionRegistry.beginWait>
		let quiet = false
		try {
			const params = paramsSchema.parse(raw)
			const assertActive = () => {
				callbacks.signal?.throwIfAborted()
				if (task.abort) throw new Error("Task was cancelled")
			}
			assertActive()
			if (params.action === "read") {
				await readCommandOutputTool.execute(params, task, callbacks)
				return
			}
			const evidence = () =>
				task.getCommandExecutionEvidence().find((item) => item.executionId === params.execution_id)
			if (!evidence()) throw new Error("Command does not belong to this task instance or is no longer retained")
			if (params.action === "input" && params.input == null)
				throw new Error("This command does not support input, or input was not supplied")
			const terminals = [
				...TerminalRegistry.getTerminals(true, task.taskId),
				...TerminalRegistry.getTerminals(false, task.taskId),
			]
			const terminal = terminals.find(
				(item) => item.taskId === task.taskId && item.process?.executionId === params.execution_id,
			)
			const hasRecordedExit = () => {
				const current = evidence()
				return current !== undefined && current.status !== "running" && Number.isInteger(current.exitCode)
			}
			const process =
				terminal?.process ??
				((params.action === "wait" || hasRecordedExit()) &&
				sessionProcess?.isSettled &&
				sessionProcess.executionId === params.execution_id
					? sessionProcess
					: undefined)
			const isPhysicallyRunning = () =>
				terminal !== undefined &&
				process !== undefined &&
				terminal.taskId === task.taskId &&
				terminal.process === process &&
				process.executionId === params.execution_id &&
				terminal.running
			// Codex 3c074bb4, unified_exec/process_manager.rs (2026-11-02): a write
			// racing with exit collects the final receipt. A failed reader alone is not exit proof.
			const hasConfirmedExit = () =>
				process?.isSettled === true &&
				process.executionId === params.execution_id &&
				!isPhysicallyRunning() &&
				hasRecordedExit()
			if (params.action !== "wait" && !hasConfirmedExit()) {
				const interrupt = params.action === "input" && params.input === "\x03" && process?.interrupt
				if (
					!terminal ||
					!process ||
					!isPhysicallyRunning() ||
					(params.action === "input" && process.isSettled && !interrupt)
				)
					throw new Error("Command is no longer running")
				assertSessionCurrent?.()
				if (params.action === "input" && ((!process.writeInput && !interrupt) || params.input == null))
					throw new Error("This command does not support input, or input was not supplied")
				if (
					!(await callbacks.askApproval(
						"command",
						`${params.action} command ${params.execution_id}${params.action === "input" ? `\n${params.input}` : ""}`,
					))
				) {
					callbacks.setResultMetadata?.({ status: "denied" })
					callbacks.pushToolResult("Command control was denied")
					return
				}
				assertActive()
				if (!hasConfirmedExit()) {
					assertSessionCurrent?.()
					if (!isPhysicallyRunning()) throw new Error("Command changed while approval was pending")
					if (params.action === "input") {
						const provider = task.providerRef.deref()
						if (!provider) throw new Error("Task mutation owner unavailable")
						await provider.runWorkspaceMutation(task, "command input", async () => {
							assertActive()
							if (hasConfirmedExit()) return
							assertSessionCurrent?.()
							if (!isPhysicallyRunning() || (process.isSettled && !interrupt))
								throw new Error("Command is no longer accepting input")
							if (interrupt) await interrupt.call(process)
							else await process.writeInput!(params.input!)
						})
					} else await process.abort()
				}
			}
			if (process) {
				const isSessionPoll = sessionId !== undefined && params.action === "wait"
				if (isSessionPoll && params.timeout_ms !== 0) {
					wait = commandSessionRegistry.beginWait(task, sessionId, params.timeout_ms == null)
					if (wait) publishCommandWait(task)
				}
				const timeoutMs = wait?.waitForProgress
					? WRITE_STDIN_QUIET_POLL_MS
					: (params.timeout_ms ?? (isSessionPoll ? WRITE_STDIN_MIN_POLL_MS : 10_000))
				await waitForCommand(process, timeoutMs, callbacks.signal, wait?.waitForProgress)
			}
			assertActive()
			// Like Codex's refresh_process_state (upstream main, retrieved 2026-11-10),
			// recheck the original command after waiting. A settled session can still
			// own its output even when its terminal has been reused.
			if (
				(process && process.executionId !== params.execution_id) ||
				(sessionId !== undefined &&
					(!process || commandSessionRegistry.resolve(task, sessionId)?.process !== process))
			) {
				throw new Error("Command session changed while waiting for output")
			}
			const current = evidence()!
			const physicallyRunning = isPhysicallyRunning()
			// A completed nonzero exit is a process failure, not a failed tool transaction.
			const completedProcessFailure =
				current.status === "failed" && typeof current.exitCode === "number" && current.signalName === undefined
			const receiptOutputLimit =
				callbacks.commandResultMaxOutputTokens !== undefined
					? Math.max(0, getCommandToolResultLimit(callbacks) - 512)
					: Math.max(0, Math.min(8_000, (callbacks.getRemainingOutputChars?.() ?? 9_000) - 1_000))
			const receipt = process?.captureUnretrievedOutput(receiptOutputLimit)
			try {
				const output = `${receipt?.output ?? ""}${process?.outputArchiveInterrupted ? `\n${t("common:errors.command_output_archive_interrupted")}` : ""}`
				const hasMoreOutput = receipt?.hasMoreOutput === true
				let commandResult: CommandToolResult | undefined
				if (callbacks.commandResultMaxOutputTokens !== undefined) {
					commandResult = {
						wall_time_seconds: Math.max(0, (performance.now() - startedAt) / 1000),
						output,
						...(typeof current.exitCode === "number" ? { exit_code: current.exitCode } : {}),
						...(process?.outputArtifactId ? { artifact_id: process.outputArtifactId } : {}),
						...((physicallyRunning || current.status === "running" || hasMoreOutput) &&
						sessionId !== undefined
							? { session_id: sessionId }
							: {}),
						...(hasMoreOutput ? { has_more_output: true } : {}),
					}
					// Native text receipts already reserve their framing within the raw cap.
					// JSON escaping must not discard output whose cursor is about to commit.
					if (callbacks.commandResultFormat !== "codex") {
						commandResult = boundCommandToolResult(commandResult, getCommandToolResultLimit(callbacks))
					}
				}
				if (callbacks.commandResultFormat === "codex" && commandResult && callbacks.pushCommandResult) {
					callbacks.pushCommandResult(commandResult)
				} else
					callbacks.pushToolResult(
						callbacks.commandResultFormat === "codex" && commandResult
							? formatCommandToolResult(
									commandResult,
									getCommandToolResultLimit(callbacks),
									callbacks.toolCallId ?? current.executionId,
								)
							: `${JSON.stringify({ execution_id: current.executionId, status: current.status, exit_code: current.exitCode ?? null, process_available: Boolean(process), stop_requested: params.action === "stop" })}\nOutput:\n${output}`,
					)
				callbacks.setResultMetadata?.({
					...(hasMoreOutput || process?.outputArchiveInterrupted ? { truncated: true } : {}),
					...(commandResult
						? {
								executionStatus:
									physicallyRunning || current.status === "running"
										? "running"
										: current.status === "succeeded"
											? "success"
											: current.status === "denied" || current.status === "cancelled"
												? current.status
												: "error",
								status:
									current.status === "running" ||
									current.status === "succeeded" ||
									completedProcessFailure
										? "success"
										: current.status === "denied" || current.status === "cancelled"
											? current.status
											: "error",
								...(typeof current.exitCode === "number" ? { exitCode: current.exitCode } : {}),
							}
						: {}),
					...(commandResult ? { commandResult } : {}),
					waitOutcome: physicallyRunning || current.status === "running" ? "active" : "idle",
				})
				receipt?.commit()
				quiet =
					current.status === "running" &&
					physicallyRunning &&
					!process?.isSettled &&
					output.length === 0 &&
					!hasMoreOutput
			} finally {
				receipt?.release()
			}
		} catch (error) {
			quiet = false
			if (callbacks.signal?.aborted) throw error
			callbacks.setResultMetadata?.({ status: "error" })
			await callbacks.handleError("controlling command", error as Error)
		} finally {
			if (wait) {
				wait.finish(quiet)
				publishCommandWait(task)
			}
		}
	}
}

export const manageCommandTool = new ManageCommandTool()
