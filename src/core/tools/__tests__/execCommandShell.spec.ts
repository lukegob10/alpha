import { createToolPolicySnapshot } from "../../agent/ToolPolicy"
import { afterEach, describe, expect, it, vi } from "vitest"

import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"
import { createExecCommandTool } from "../../prompts/tools/native-tools/execute_command"
import { executeCommandTool } from "../ExecuteCommandTool"
import { ToolRegistry } from "../ToolRegistry"
import type { ToolCallbacks } from "../BaseTool"
import type { Task } from "../../task/Task"
import type { ToolUse } from "../../../shared/tools"

afterEach(() => vi.restoreAllMocks())

describe("explicit exec shell controls", () => {
	it("advertises explicit shell and startup selection", () => {
		const schema = createExecCommandTool()
		if (schema.type !== "function") throw new Error("Expected a function tool")
		expect(schema.function.parameters).toMatchObject({
			properties: { shell: { type: "string" }, login: { type: "boolean" } },
		})
	})

	it("keeps explicit controls through native parsing", () => {
		const args = { cmd: "printf hello", shell: "/bin/bash", login: false }
		const parsed = NativeToolCallParser.parseToolCall({
			id: "shell-choice",
			name: "exec_command",
			arguments: JSON.stringify(args),
		})
		expect(parsed).not.toBeNull()
		if (!parsed || !("nativeArgs" in parsed)) throw new Error("Expected parsed native command arguments")
		expect(parsed.nativeArgs).toEqual(args)
	})

	it("retains explicit controls when the canonical adapter invokes the executor", async () => {
		const execute = vi.spyOn(executeCommandTool, "execute").mockResolvedValue(undefined)
		const call = {
			type: "tool_use",
			id: "shell-choice",
			name: "exec_command",
			params: {},
			partial: false,
			nativeArgs: { cmd: "printf hello", shell: "/bin/bash", login: false },
		} as unknown as ToolUse<"exec_command">
		const callbacks = { askApproval: vi.fn(), handleError: vi.fn(), pushToolResult: vi.fn() } as ToolCallbacks
		const task = {
			providerRef: {
				deref: () => ({
					runWorkspaceMutation: async (_task: unknown, _label: string, run: () => Promise<void>) => run(),
				}),
			},
		} as unknown as Task
		await new ToolRegistry().resolve("exec_command")!.execute({ task, call, callbacks })
		expect(execute.mock.calls[0][0]).toMatchObject({ command: "printf hello", shell: "/bin/bash", login: false })
	})
})

describe("explicit shell read admission", () => {
	it.each([{ shell: "/bin/bash" }, { login: false }, { login: true }])(
		"does not prepare an audited read for %j",
		async (controls) => {
			const registry = new ToolRegistry()
			const descriptor = registry.resolve("exec_command")!
			const args = { cmd: "rg -n pattern file", ...controls }
			const policy = createToolPolicySnapshot({ visibleTools: ["exec_command"] })
			expect(await descriptor.isParallelCommandReadReady!({} as Task, args, policy)).toBe(false)
			const callbacks = { askApproval: vi.fn(), handleError: vi.fn(), pushToolResult: vi.fn() } as ToolCallbacks
			const prepared = await descriptor.prepareParallelCommand!(
				{
					task: {} as Task,
					callbacks,
					call: {
						type: "tool_use",
						id: "explicit-read",
						name: "exec_command",
						params: {},
						partial: false,
						nativeArgs: args,
					},
				},
				policy,
			)
			expect(prepared).toBeUndefined()
			expect(callbacks.askApproval).not.toHaveBeenCalled()
		},
	)
})
