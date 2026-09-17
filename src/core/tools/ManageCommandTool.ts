import { z } from "zod"
import { BaseTool, type ToolCallbacks } from "./BaseTool"
import type { Task } from "../task/Task"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"
import type { AlphaTerminalProcess } from "../../integrations/terminal/types"
import type { NativeToolArgs } from "../../shared/tools"

const paramsSchema = z.object({
	execution_id: z.string().min(1).max(256),
	action: z.enum(["wait", "stop", "input"]),
	input: z.string().max(16_384).nullish(),
	timeout_ms: z.number().int().min(0).max(30_000).nullish(),
})

export async function waitForCommand(
	process: AlphaTerminalProcess,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted()
	if (process.isSettled || process.hasUnretrievedOutput() || timeoutMs === 0) return
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
			process.off("output_available", finish)
			signal?.removeEventListener("abort", cancel)
		}
		process.once("completed", finish)
		process.once("error", finish)
		process.once("output_available", finish)
		signal?.addEventListener("abort", cancel, { once: true })
		if (signal?.aborted) cancel()
		else if (process.isSettled || process.hasUnretrievedOutput()) finish()
	})
}

export class ManageCommandTool extends BaseTool<"manage_command"> {
	readonly name = "manage_command" as const
	async execute(raw: NativeToolArgs["manage_command"], task: Task, callbacks: ToolCallbacks): Promise<void> {
		try {
			const params = paramsSchema.parse(raw)
			const assertActive = () => {
				callbacks.signal?.throwIfAborted()
				if (task.abort) throw new Error("Task was cancelled")
			}
			assertActive()
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
			const process = terminal?.process
			if (params.action !== "wait") {
				if (!process || !terminal.running || (params.action === "input" && process.isSettled))
					throw new Error("Command is no longer running")
				if (params.action === "input" && (!process.writeInput || params.input == null))
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
				if (terminal.taskId !== task.taskId || terminal.process !== process || !terminal.running)
					throw new Error("Command changed while approval was pending")
				if (params.action === "input") {
					const provider = task.providerRef.deref()
					if (!provider) throw new Error("Task mutation owner unavailable")
					await provider.runWorkspaceMutation(task, "command input", async () => {
						assertActive()
						if (terminal.taskId !== task.taskId || terminal.process !== process || process.isSettled)
							throw new Error("Command is no longer accepting input")
						await process.writeInput!(params.input!)
					})
				} else await process.abort()
			}
			if (process) await waitForCommand(process, params.timeout_ms ?? 10_000, callbacks.signal)
			assertActive()
			const current = evidence()!
			const receipt = process?.captureUnretrievedOutput(
				Math.max(0, Math.min(8_000, (callbacks.getRemainingOutputChars?.() ?? 9_000) - 1_000)),
			)
			try {
				callbacks.pushToolResult(
					`${JSON.stringify({ execution_id: current.executionId, status: current.status, exit_code: current.exitCode ?? null, process_available: Boolean(process), stop_requested: params.action === "stop" })}\nOutput:\n${receipt?.output ?? ""}`,
				)
				receipt?.commit()
			} finally {
				receipt?.release()
			}
			callbacks.setResultMetadata?.({ waitOutcome: current.status === "running" ? "active" : "idle" })
		} catch (error) {
			if (callbacks.signal?.aborted) throw error
			callbacks.setResultMetadata?.({ status: "error" })
			await callbacks.handleError("controlling command", error as Error)
		}
	}
}

export const manageCommandTool = new ManageCommandTool()
