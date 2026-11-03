import { afterEach, describe, expect, it, vi } from "vitest"
import type { ToolApprovalDecision, ToolApprovalRequest } from "@alpha-code/types"

import { ToolRegistry } from "../../tools/ToolRegistry"
import { clearTaskSessionApprovalGrants } from "../../auto-approval/taskSessionApprovalGrants"
import type { AgentToolCall } from "../AgentResponse"
import type { AgentTurnEvent } from "../AgentTurnEvents"
import { createToolPolicySnapshot } from "../ToolPolicy"
import { ToolScheduler, type ToolExecutionHost } from "../ToolScheduler"

const taskId = "approval-shell-identity"
afterEach(() => clearTaskSessionApprovalGrants(taskId))

// Codex ac558e2 tools/approvals.rs:574 keeps retained execution authority distinct
// from permission to review new input. Alpha's explicit shell controls stay exact.
describe("native command session grants retain shell authority", () => {
	it.each([
		{ changed: "shell", authority: { shell: "/bin/zsh" } },
		{ changed: "login startup", authority: { login: true } },
		{ changed: "TTY", authority: { tty: true } },
	])("requires a fresh reviewed decision when $changed changes", async ({ authority }) => {
		const effects: Record<string, unknown>[] = []
		const events: AgentTurnEvent[] = []
		const review = vi.fn<(request: ToolApprovalRequest) => Promise<ToolApprovalDecision>>()
		review.mockImplementationOnce(async (request) => {
			if (!request.proposedAmendment) throw new Error("Expected exact reviewed command")
			return { decision: "approve_with_amendment", amendment: request.proposedAmendment }
		})
		review.mockResolvedValue({ decision: "deny", feedback: "Review changed execution authority" })
		const host: ToolExecutionHost = {
			taskId,
			taskKind: "primary",
			cwd: process.cwd(),
			userMessageContent: [],
			requestToolApproval: review,
			say: vi.fn(async () => undefined),
			recordToolUsage: vi.fn(),
			pushToolResultToUserContent(result) {
				if (
					host.userMessageContent.some(
						(item) => item.type === "tool_result" && item.tool_use_id === result.tool_use_id,
					)
				)
					return false
				host.userMessageContent.push(result)
				return true
			},
		}
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register({
			name: "exec_command",
			aliases: [],
			schema: { type: "function", function: { name: "exec_command", parameters: { type: "object" } } },
			capabilities: {
				concurrency: "serial",
				sideEffects: "workspace",
				controlFlow: false,
				requiresApproval: true,
			},
			execute: async ({ call, callbacks }) => {
				// Deliberately keep the same human summary: the grant must bind complete arguments.
				if (await callbacks.askApproval("command", "git status --short")) {
					effects.push(structuredClone(call.nativeArgs as Record<string, unknown>))
					callbacks.pushToolResult("Completed reviewed command")
				}
			},
		})
		const policy = createToolPolicySnapshot({
			visibleTools: ["exec_command"],
			allowedTools: ["exec_command"],
			execution: { workspaceRoots: [process.cwd()] },
		})
		const baseline = {
			cmd: "git status --short",
			workdir: ".",
			shell: "/bin/bash",
			login: false,
			tty: false,
			yield_time_ms: 1_000,
			max_output_tokens: 1_000,
		}
		const run = (id: string, args: Record<string, unknown>) => {
			const call: AgentToolCall = { type: "tool_call", id, name: "exec_command", arguments: args }
			return new ToolScheduler({
				executionHost: host,
				registry,
				mode: "code",
				policy,
				validateCall: () => undefined,
				onEvent: (event) => {
					events.push(event)
				},
			}).run([call])
		}

		expect((await run("reviewed", baseline)).results).toMatchObject([{ status: "success" }])
		expect(
			(await run("presentation-only", { ...baseline, yield_time_ms: 20_000, max_output_tokens: 20 })).results,
		).toMatchObject([{ status: "success" }])
		expect(review).toHaveBeenCalledOnce()
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "approval_result",
				decision: "approved",
				reason: "Approved by an exact task-session grant.",
			}),
		)

		const changed = await run("changed-authority", { ...baseline, ...authority })
		expect(changed.results).toMatchObject([
			{
				callId: "changed-authority",
				status: "denied",
				failure: { reason: "approval_denied", effectsStarted: "no", outcome: "known" },
			},
		])
		expect(review).toHaveBeenCalledTimes(2)
		expect(effects).toHaveLength(2)
		expect(
			effects.every((args) => args.shell === baseline.shell && args.login === false && args.tty === false),
		).toBe(true)
		expect(
			host.userMessageContent.filter(
				(result) => result.type === "tool_result" && result.tool_use_id === "changed-authority",
			),
		).toEqual([expect.objectContaining({ type: "tool_result", is_error: true })])
		expect(events.filter((event) => event.type === "approval_result" && event.decision === "denied")).toHaveLength(
			1,
		)
	})
})
