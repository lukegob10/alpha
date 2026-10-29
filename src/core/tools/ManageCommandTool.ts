import { z } from "zod"
import { t } from "../../i18n"
import { BaseTool, type ToolCallbacks } from "./BaseTool"
import type { Task } from "../task/Task"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"
import type { AlphaTerminalProcess } from "../../integrations/terminal/types"
import type { NativeToolArgs } from "../../shared/tools"
import { MANAGE_COMMAND_MAX_TIMEOUT_MS } from "./commandTimeouts"
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
		offset: z.number().int().min(0).optional(),
		limit: z.number().int().min(1).optional(),
	}),
])

export async function waitForCommand(
	process: AlphaTerminalProcess,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted()
	// Codex collect_output_until_deadline (upstream main, retrieved 2026-10-29)
	// accumulates progress until the deadline or terminal outcome, even with buffered output.
	// Terminal adapters already bound and archive output independently of this wait.
	if (process.isSettled || timeoutMs === 0) return
	await new Promise<void>((resolve, reject) => {
		const finish = () => {
			cleanup()
			resolve()
		}
		const cancel = () => {
			cleanup()
			reject(signal?.reason ?? new Error("Command wait cancelled"))
		}
		const timer = setTimeout(finish, timeoutMs)
		const cleanup = () => {
			clearTimeout(timer)
			process.off("completed", finish)
			process.off("error", finish)
			signal?.removeEventListener("abort", cancel)
		}
		process.once("completed", finish)
		process.once("error", finish)
		signal?.addEventListener("abort", cancel, { once: true })
		if (signal?.aborted) cancel()
		else if (process.isSettled) finish()
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
			const terminals = [
				...TerminalRegistry.getTerminals(true, task.taskId),
				...TerminalRegistry.getTerminals(false, task.taskId),
			]
			const terminal = terminals.find(
				(item) => item.taskId === task.taskId && item.process?.executionId === params.execution_id,
			)
			const process =
				terminal?.process ??
				(params.action === "wait" &&
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
			if (params.action !== "wait") {
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
				assertSessionCurrent?.()
				if (!isPhysicallyRunning()) throw new Error("Command changed while approval was pending")
				if (params.action === "input") {
					const provider = task.providerRef.deref()
					if (!provider) throw new Error("Task mutation owner unavailable")
					await provider.runWorkspaceMutation(task, "command input", async () => {
						assertActive()
						assertSessionCurrent?.()
						if (!isPhysicallyRunning() || (process.isSettled && !interrupt))
							throw new Error("Command is no longer accepting input")
						if (interrupt) await interrupt.call(process)
						else await process.writeInput!(params.input!)
					})
				} else await process.abort()
			}
			if (process) await waitForCommand(process, params.timeout_ms ?? 10_000, callbacks.signal)
			assertActive()
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
			} finally {
				receipt?.release()
			}
		} catch (error) {
			if (callbacks.signal?.aborted) throw error
			callbacks.setResultMetadata?.({ status: "error" })
			await callbacks.handleError("controlling command", error as Error)
		}
	}
}

export const manageCommandTool = new ManageCommandTool()
