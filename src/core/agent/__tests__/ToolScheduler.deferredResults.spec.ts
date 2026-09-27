import * as path from "path"
import { tmpdir } from "os"
import { describe, expect, it, vi } from "vitest"

import { ToolRegistry } from "../../tools/ToolRegistry"
import { ToolScheduler } from "../ToolScheduler"
import { createToolPolicySnapshot } from "../ToolPolicy"

function createFixture() {
	const userMessageContent: any[] = []
	const task = {
		abort: false,
		taskId: "deferred-result-test",
		cwd: tmpdir(),
		didRejectTool: false,
		didToolFailInCurrentTurn: false,
		userMessageContent,
		userMessageContentReady: false,
		recordToolUsage: vi.fn(),
		pushToolResultToUserContent(result: any) {
			if (
				userMessageContent.some(
					(item) => item.type === "tool_result" && item.tool_use_id === result.tool_use_id,
				)
			) {
				return false
			}
			userMessageContent.push(result)
			return true
		},
	}
	const registry = new ToolRegistry({ includeBuiltIns: false })
	const execute = vi.fn(async ({ callbacks }: { callbacks: { pushToolResult: (content: string) => void } }) => {
		callbacks.pushToolResult("directory listing")
	})
	registry.register({
		name: "fixture_read",
		aliases: [],
		schema: {
			type: "function",
			function: {
				name: "fixture_read",
				description: "Read fixture",
				parameters: { type: "object", properties: {}, additionalProperties: false },
			},
		},
		capabilities: {
			concurrency: "parallel",
			sideEffects: "none",
			controlFlow: false,
			requiresApproval: false,
		},
		getConcurrencyScope: (call) => path.resolve(tmpdir(), `scope-${call.id}`),
		execute,
	})
	const policy = createToolPolicySnapshot({
		visibleTools: ["fixture_read"],
		allowedTools: ["fixture_read"],
		autoApprovalEnabled: true,
		execution: { workspaceRoots: [tmpdir()] },
	})
	const events: string[] = []
	const scheduler = new ToolScheduler({
		task: task as any,
		registry,
		mode: "code",
		policy,
		validateCall: () => {},
		executionMode: "selective-parallel",
		deferResultCommit: true,
		onEvent: (event) => {
			if (event.type === "tool_result" || event.type === "tool_batch_finished") events.push(event.type)
		},
	})
	const response = {
		items: [{ type: "tool_call" as const, id: "read-1", name: "fixture_read", arguments: {} }],
		text: "",
		reasoning: "",
		toolCalls: [{ type: "tool_call" as const, id: "read-1", name: "fixture_read", arguments: {} }],
	}
	return { task, execute, scheduler, response, events }
}

describe("ToolScheduler deferred results", () => {
	it("holds the result and batch terminal event until the host commits, exactly once", async () => {
		const fixture = createFixture()
		const outcome = await fixture.scheduler.run(fixture.response)

		expect(outcome.results).toMatchObject([{ callId: "read-1", status: "success", content: "directory listing" }])
		expect(fixture.execute).toHaveBeenCalledOnce()
		expect(fixture.task.userMessageContent).toEqual([])
		expect(fixture.task.userMessageContentReady).toBe(false)
		expect(fixture.events).toEqual([])

		await fixture.scheduler.commitDeferredResults()
		await fixture.scheduler.commitDeferredResults()

		expect(fixture.task.userMessageContent).toMatchObject([
			{ type: "tool_result", tool_use_id: "read-1", content: "directory listing", is_error: false },
		])
		expect(fixture.task.userMessageContentReady).toBe(true)
		expect(fixture.events).toEqual(["tool_result", "tool_batch_finished"])
	})

	it("discards a speculative result without publishing a terminal receipt", async () => {
		const fixture = createFixture()
		await fixture.scheduler.run(fixture.response)
		fixture.scheduler.discardDeferredResults()

		expect(fixture.execute).toHaveBeenCalledOnce()
		expect(fixture.task.userMessageContent).toEqual([])
		expect(fixture.events).toEqual([])
	})
})
