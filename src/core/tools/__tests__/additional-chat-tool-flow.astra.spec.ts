import { afterEach, describe, expect, it, vi } from "vitest"
import { customToolRegistry } from "@alpha-code/core"

import { ExecaTerminalProcess } from "../../../integrations/terminal/ExecaTerminalProcess"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import type { AlphaTerminal } from "../../../integrations/terminal/types"
import { ToolScheduler, type ToolExecutionHost } from "../../agent/ToolScheduler"
import type { Task } from "../../task/Task"
import { commandSessionRegistry } from "../CommandSessionRegistry"
import { createTaskToolSurface } from "../TaskToolSurface"
import { ToolRegistry } from "../ToolRegistry"

async function completedCommand(output: string) {
	const cwd = process.cwd()
	const taskId = "additional-astra-output-audit"
	const terminal = {
		provider: "execa",
		id: 1,
		busy: false,
		running: false,
		getCurrentWorkingDirectory: () => cwd,
		isClosed: () => false,
	} as unknown as AlphaTerminal
	const command = new ExecaTerminalProcess(terminal)
	command.executionId = "additional-astra-output-execution"
	// Seed the real terminal receipt boundary after the foreground command yielded.
	;(command as unknown as { fullOutput: string }).fullOutput = output
	command.emit("completed")
	// The completed event alone does not settle output; join the native finalization boundary.
	await command.finalizeOutput()
	const task = {
		taskId,
		cwd,
		taskKind: "primary",
		getCommandExecutionEvidence: () => [{ executionId: command.executionId, status: "succeeded", exitCode: 0 }],
	} as unknown as Task
	const userMessageContent: ToolExecutionHost["userMessageContent"] = []
	const host: ToolExecutionHost = {
		taskId,
		cwd,
		taskFacade: task,
		userMessageContent,
		say: vi.fn(async () => undefined),
		recordToolUsage: vi.fn(),
		pushToolResultToUserContent: (result) => {
			userMessageContent.push(result)
			return true
		},
	}
	// A completed Execa process is removed from the reusable terminal. The session
	// registry must retain its remaining output, as it does in production.
	vi.spyOn(TerminalRegistry, "getTerminals").mockReturnValue([])
	const sessionId = commandSessionRegistry.register(task, command)
	const surface = createTaskToolSurface({ mode: "code", cwd })
	const poll = (id: string, maxOutputTokens = 10_000) =>
		new ToolScheduler({
			executionHost: host,
			registry: surface.registry,
			policy: surface.policy,
			mode: "code",
		}).run([
			{
				type: "tool_call",
				id,
				name: "write_stdin",
				arguments: { session_id: sessionId, max_output_tokens: maxOutputTokens },
			},
		])
	return { task, command, poll, sessionId, host }
}

afterEach(() => {
	vi.restoreAllMocks()
	customToolRegistry.unregister("additional_astra_custom_effect")
})

describe("additional Astra audit: completed command output discoverability", () => {
	it("reports when a completed poll leaves unread output and identifies how to fetch it", async () => {
		const tail = "FINAL_DIAGNOSTIC: migration removed the expected table\n"
		const fixture = await completedCommand(`${"build progress\n".repeat(600)}${tail}`)
		const first = (await fixture.poll("first")).results[0]!

		expect(first.status).toBe("success")
		expect(first.commandResult?.exit_code).toBe(0)
		expect(first.content).not.toContain(tail)
		expect(fixture.command.hasUnretrievedOutput()).toBe(true)
		expect(commandSessionRegistry.resolve(fixture.task, fixture.sessionId)).toBeDefined()
		const second = (await fixture.poll("second")).results[0]!
		expect(second.content).toContain(tail)
		expect(fixture.command.hasUnretrievedOutput()).toBe(false)
		expect(commandSessionRegistry.resolve(fixture.task, fixture.sessionId)).toBeUndefined()

		// The caller sees a terminal receipt before that second poll. Both omission
		// and its retrieval path must be observable, rather than silently hidden.
		expect.soft(first.truncated, "partial output must not be labeled complete").toBe(true)
		expect.soft(/truncat|more output|remaining output|unread output/i.test(String(first.content))).toBe(true)
		expect.soft(/write_stdin|artifact|session ID|session_id/.test(String(first.content))).toBe(true)
	})

	it("does not silently return no output when a small positive budget leaves the whole buffer unread", async () => {
		const fixture = await completedCommand("final diagnostic\n")
		const first = (await fixture.poll("small-budget", 100)).results[0]!

		expect(first.status).toBe("success")
		expect(first.commandResult?.exit_code).toBe(0)
		expect(first.commandResult?.output).toBe("")
		expect(fixture.command.hasUnretrievedOutput()).toBe(true)
		expect.soft(first.truncated).toBe(true)
		expect.soft(/truncat|more output|remaining output|unread output/i.test(String(first.content))).toBe(true)
	})

	it("returns and retires a complete small receipt normally", async () => {
		const fixture = await completedCommand("final diagnostic\n")
		const result = (await fixture.poll("complete")).results[0]!

		expect(result.status).toBe("success")
		expect(result.commandResult?.output).toBe("final diagnostic\n")
		expect(result.content).toContain("Process exited with code 0")
		expect(result.truncated).toBe(false)
		expect(fixture.command.hasUnretrievedOutput()).toBe(false)
		expect(commandSessionRegistry.resolve(fixture.task, fixture.sessionId)).toBeUndefined()
	})
})

describe("additional Astra audit: custom tool approval and effect admission", () => {
	function customEffectFixture(approve: boolean) {
		const cwd = process.cwd()
		const order: string[] = []
		const execute = vi.fn(async () => {
			order.push("execute")
			return "external effect completed"
		})
		customToolRegistry.register({
			name: "additional_astra_custom_effect",
			description: "Performs an external effect",
			execute,
		})
		const registry = new ToolRegistry({ includeBuiltIns: false, includeCustomTools: true })
		const surface = createTaskToolSurface({ registry, mode: "code", cwd, approvalMode: "ask" })
		const userMessageContent: ToolExecutionHost["userMessageContent"] = []
		const host: ToolExecutionHost = {
			taskId: "additional-astra-custom-effect-task",
			cwd,
			taskFacade: { getTaskMode: async () => "code" } as Task,
			userMessageContent,
			say: vi.fn(async () => undefined),
			recordToolUsage: vi.fn(),
			askApproval: vi.fn(async () => {
				order.push("approval")
				return { response: approve ? ("yesButtonClicked" as const) : ("noButtonClicked" as const) }
			}),
			pushToolResultToUserContent: (result) => {
				userMessageContent.push(result)
				return true
			},
		}
		const onEffectStart = vi.fn(async () => {
			order.push("effect-start")
		})
		const run = () =>
			new ToolScheduler({
				executionHost: host,
				registry,
				policy: surface.policy,
				mode: "code",
				experiments: { customTools: true },
				onEffectStart,
			}).run([
				{ type: "tool_call", id: "custom-effect-call", name: "additional_astra_custom_effect", arguments: {} },
			])
		return { run, surface, host, execute, onEffectStart, order }
	}

	it("honors Ask policy before invoking an advertised approval-required custom effect", async () => {
		const fixture = customEffectFixture(false)
		expect(fixture.surface.resolve("additional_astra_custom_effect")?.capabilities).toMatchObject({
			sideEffects: "external",
			requiresApproval: true,
		})
		expect(fixture.surface.policy.approval.mode).toBe("ask")
		const outcome = await fixture.run()

		expect.soft(fixture.host.askApproval).toHaveBeenCalledOnce()
		expect.soft(fixture.execute).not.toHaveBeenCalled()
		expect.soft(outcome.results[0]?.status).toBe("denied")
		expect(fixture.onEffectStart).not.toHaveBeenCalled()
	})

	it("records custom effect admission before an approved callback starts", async () => {
		const fixture = customEffectFixture(true)
		const outcome = await fixture.run()

		expect(outcome.results[0]?.status).toBe("success")
		expect(fixture.execute).toHaveBeenCalledOnce()
		expect.soft(fixture.onEffectStart).toHaveBeenCalledOnce()
		expect.soft(fixture.order).toEqual(["approval", "effect-start", "execute"])
	})
})
