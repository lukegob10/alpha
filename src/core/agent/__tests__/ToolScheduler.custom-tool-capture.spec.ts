import { customToolRegistry } from "@alpha-code/core"
import type { CustomToolDefinition } from "@alpha-code/types"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ToolRegistry } from "../../tools/ToolRegistry"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"
import { ToolScheduler, type ToolExecutionHost } from "../ToolScheduler"

function fixture(definition: CustomToolDefinition) {
	const registry = new ToolRegistry({
		includeBuiltIns: false,
		customTools: [
			{
				definition,
				schema: {
					type: "function",
					function: { name: definition.name, parameters: { type: "object" } },
				},
			},
		],
	})
	const surface = createTaskToolSurface({ registry, mode: "code", cwd: process.cwd(), taskKind: "primary" })
	const host: ToolExecutionHost = {
		taskId: `custom-capture-${definition.name}`,
		cwd: process.cwd(),
		userMessageContent: [],
		askApproval: vi.fn(async () => ({ response: "yesButtonClicked" as const })),
		say: vi.fn(async () => undefined),
		recordToolUsage: vi.fn(),
		pushToolResultToUserContent(result) {
			host.userMessageContent.push(result)
			return true
		},
	}
	const scheduler = new ToolScheduler({
		executionHost: host,
		registry: surface.registry,
		policy: surface.policy,
		mode: "code",
		experiments: { customTools: true },
	})
	return { scheduler, host }
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe("scheduler custom tool catalog capture", () => {
	it("executes the captured definition after another task replaces the live custom catalog", async () => {
		const executeCaptured = vi.fn(async () => "Captured catalog result")
		const captured = fixture({ name: "captured_tool", description: "Original task tool", execute: executeCaptured })
		const newer = fixture({
			name: "newer_tool",
			description: "Other task tool",
			execute: async () => "New catalog",
		})
		const liveMembership = vi.spyOn(customToolRegistry, "has").mockImplementation((name) => name === "newer_tool")

		const outcome = await captured.scheduler.run([
			{ type: "tool_call", id: "captured-call", name: "captured_tool", arguments: { value: "original" } },
		])

		expect(outcome.results).toEqual([
			expect.objectContaining({ callId: "captured-call", status: "success", content: "Captured catalog result" }),
		])
		expect(executeCaptured).toHaveBeenCalledExactlyOnceWith(
			{ value: "original" },
			expect.objectContaining({ mode: "code" }),
		)
		expect(captured.host.askApproval).toHaveBeenCalledOnce()
		expect(captured.host.userMessageContent).toEqual([
			expect.objectContaining({ tool_use_id: "captured-call", is_error: false }),
		])
		expect(liveMembership).not.toHaveBeenCalled()
		expect(newer.host.userMessageContent).toEqual([])
	})
})
