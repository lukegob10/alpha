import { describe, expect, it, vi } from "vitest"

import { captureToolReviewPolicy, checkAutoApproval } from "../../auto-approval"
import { AlphaProtectedController } from "../../protect/AlphaProtectedController"
import type { Task } from "../../task/Task"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { createToolPolicySnapshot } from "../ToolPolicy"
import { ToolScheduler, type ToolExecutionHost } from "../ToolScheduler"

function fixture(captured: boolean | undefined, live: boolean, command: string, workdir?: string) {
	const cwd = process.cwd()
	const state = {
		approvalMode: "auto" as const,
		alwaysAllowWriteProtected: captured === true,
		allowedCommands: ["Set-Content"],
	}
	const reviewPolicy = captured === undefined ? undefined : captureToolReviewPolicy(state)
	const policy = createToolPolicySnapshot({
		visibleTools: ["exec_command"],
		approvalMode: "auto",
		reviewPolicy,
		execution: { workspaceRoots: [cwd], command: { allowedPrefixes: state.allowedCommands } },
	})
	state.alwaysAllowWriteProtected = live
	const effect = vi.fn()
	const onEffectStart = vi.fn(async () => undefined)
	const prompt = vi.fn(async () => false)
	const registry = new ToolRegistry({ includeBuiltIns: false })
	registry.register({
		name: "exec_command",
		aliases: [],
		schema: { type: "function", function: { name: "exec_command", parameters: { type: "object" } } },
		capabilities: { concurrency: "serial", sideEffects: "workspace", controlFlow: false, requiresApproval: true },
		execute: async ({ callbacks }) => {
			if (await callbacks.askApproval("command", command)) {
				effect()
				callbacks.pushToolResult("Command completed")
			}
		},
	})
	const host: ToolExecutionHost = {
		taskId: "protected-command-destination",
		cwd,
		userMessageContent: [],
		taskFacade: { cwd, alphaProtectedController: new AlphaProtectedController(cwd) } as unknown as Task,
		say: vi.fn(async () => undefined),
		recordToolUsage: vi.fn(),
		askApproval: vi.fn<NonNullable<ToolExecutionHost["askApproval"]>>(
			async (ask, text, _progress, isProtected, requiresExplicitApproval) => {
				const decision = await checkAutoApproval({
					state,
					reviewPolicy: policy.approval.reviewPolicy,
					commandPolicy: policy.execution.command,
					ask,
					text,
					isProtected,
					requiresExplicitApproval,
				})
				return {
					response:
						decision.decision === "approve" || (decision.decision === "ask" && (await prompt()))
							? "yesButtonClicked"
							: "noButtonClicked",
				}
			},
		),
		pushToolResultToUserContent(result) {
			host.userMessageContent.push(result)
			return true
		},
	}
	const run = () =>
		new ToolScheduler({ executionHost: host, registry, policy, mode: "code", onEffectStart }).run([
			{
				type: "tool_call",
				id: "protected-command-call",
				name: "exec_command",
				arguments: { cmd: command, ...(workdir ? { workdir } : {}) },
			},
		])
	return { run, effect, onEffectStart, prompt, host }
}

describe("ToolScheduler protected command destinations", () => {
	it.each([
		{ captured: false, live: false },
		{ captured: false, live: true },
		{ captured: true, live: false },
		{ captured: undefined, live: true },
	])("requires review for a protected destination with permission $captured/$live", async ({ captured, live }) => {
		const test = fixture(captured, live, "Set-Content AGENTS.md synthetic-content")

		const outcome = await test.run()

		expect(test.prompt).toHaveBeenCalledOnce()
		expect(test.effect).not.toHaveBeenCalled()
		expect(test.onEffectStart).not.toHaveBeenCalled()
		expect(outcome.results).toMatchObject([{ status: "denied" }])
		expect(test.host.askApproval).toHaveBeenCalledWith(
			"command",
			expect.any(String),
			undefined,
			true,
			...(captured === true ? [] : [true]),
		)
	})

	it("retains a protected-file grant only when both captured and live policy permit it", async () => {
		const test = fixture(true, true, "Set-Content AGENTS.md synthetic-content")

		const outcome = await test.run()

		expect(test.prompt).not.toHaveBeenCalled()
		expect(test.effect).toHaveBeenCalledOnce()
		expect(test.onEffectStart).toHaveBeenCalledOnce()
		expect(outcome.results).toMatchObject([{ status: "success" }])
		expect(test.host.askApproval).toHaveBeenCalledWith("command", expect.any(String), undefined, true)
	})

	it("keeps an ordinary workspace destination eligible for command auto-approval", async () => {
		const test = fixture(false, false, "Set-Content ordinary.txt synthetic-content")

		const outcome = await test.run()

		expect(test.prompt).not.toHaveBeenCalled()
		expect(test.effect).toHaveBeenCalledOnce()
		expect(outcome.results).toMatchObject([{ status: "success" }])
	})

	it("resolves a protected destination from the command working directory", async () => {
		const test = fixture(false, true, "Set-Content settings.json synthetic-content", ".vscode")

		const outcome = await test.run()

		expect(test.prompt).toHaveBeenCalledOnce()
		expect(test.effect).not.toHaveBeenCalled()
		expect(outcome.results).toMatchObject([{ status: "denied" }])
	})

	it("keeps protected destinations guarded for execution hosts without a task controller", async () => {
		const test = fixture(false, true, "Set-Content AGENTS.md synthetic-content")
		delete test.host.taskFacade!.alphaProtectedController

		const outcome = await test.run()

		expect(test.prompt).toHaveBeenCalledOnce()
		expect(test.effect).not.toHaveBeenCalled()
		expect(outcome.results).toMatchObject([{ status: "denied" }])
	})
})
