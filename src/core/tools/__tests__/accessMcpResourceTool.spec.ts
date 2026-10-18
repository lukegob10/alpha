import type { Task } from "../../task/Task"
import type { McpServer } from "@alpha-code/types"
import { accessMcpResourceTool } from "../accessMcpResourceTool"

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolDenied: () => "denied",
		toolResult: (text: string) => `result: ${text}`,
	},
}))

describe("accessMcpResourceTool", () => {
	function setup(readResource?: import("vitest").Mock) {
		const servers: McpServer[] = [{ name: "server", source: "project", config: "{}", status: "connected" }]
		const setResultMetadata = vi.fn()
		const handleError = vi.fn()
		const pushToolResult = vi.fn()
		const hub = readResource ? { readResource, getServers: () => servers } : undefined
		const task = {
			consecutiveMistakeCount: 0,
			didToolFailInCurrentTurn: false,
			recordToolError: vi.fn(),
			sayAndCreateMissingParamError: vi.fn(),
			say: vi.fn(),
			providerRef: {
				deref: () => ({ getMcpHub: () => hub }),
			},
		} as unknown as Task
		return {
			task,
			servers,
			callbacks: {
				askApproval: vi.fn().mockResolvedValue(true),
				handleError,
				pushToolResult,
				setResultMetadata,
			},
			handleError,
			pushToolResult,
			setResultMetadata,
		}
	}

	it.each([
		["a missing hub", undefined],
		["an undefined response", vi.fn().mockResolvedValue(undefined)],
	])("fails closed for %s", async (_label, readResource) => {
		const fixture = setup(readResource)
		await accessMcpResourceTool.execute(
			{ server_name: "server", uri: "file:///item" },
			fixture.task,
			fixture.callbacks,
		)

		expect(fixture.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
		expect(fixture.task.didToolFailInCurrentTurn).toBe(true)
		expect(fixture.handleError).toHaveBeenCalledTimes(1)
		expect(fixture.pushToolResult).not.toHaveBeenCalled()
	})

	it("pins a legacy resource read to its approved server through presentation waits", async () => {
		const readResource = vi.fn().mockResolvedValue({ contents: [{ text: "content" }] })
		const fixture = setup(readResource)
		vi.mocked(fixture.task.say).mockImplementation(async (type) => {
			if (type === "mcp_server_request_started") fixture.servers[0] = { ...fixture.servers[0] }
			return undefined
		})
		await accessMcpResourceTool.execute(
			{ server_name: "server", uri: "file:///item" },
			fixture.task,
			fixture.callbacks,
		)
		expect(readResource).not.toHaveBeenCalled()
		expect(fixture.pushToolResult).not.toHaveBeenCalled()
		expect(fixture.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
	})

	it.each(["replaced", "disabled", "disconnected"] as const)(
		"rejects a legacy resource server %s during approval",
		async (change) => {
			const readResource = vi.fn().mockResolvedValue({ contents: [{ text: "content" }] })
			const fixture = setup(readResource)
			fixture.callbacks.askApproval.mockImplementation(async () => {
				if (change === "replaced") fixture.servers[0] = { ...fixture.servers[0] }
				else if (change === "disabled") fixture.servers[0].disabled = true
				else fixture.servers[0].status = "disconnected"
				return true
			})
			await accessMcpResourceTool.execute(
				{ server_name: "server", uri: "file:///item" },
				fixture.task,
				fixture.callbacks,
			)
			expect(readResource).not.toHaveBeenCalled()
			expect(fixture.pushToolResult).not.toHaveBeenCalled()
			expect(fixture.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
		},
	)

	it("rejects legacy resource contents when the server changes before the response", async () => {
		const readResource = vi.fn()
		const fixture = setup(readResource)
		readResource.mockImplementation(async () => {
			fixture.servers[0] = { ...fixture.servers[0] }
			return { contents: [{ text: "stale content" }] }
		})
		await accessMcpResourceTool.execute(
			{ server_name: "server", uri: "file:///item" },
			fixture.task,
			fixture.callbacks,
		)
		expect(readResource).toHaveBeenCalledOnce()
		expect(fixture.pushToolResult).not.toHaveBeenCalled()
		expect(fixture.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
	})

	it("does not read a legacy resource after approval is declined", async () => {
		const readResource = vi.fn()
		const fixture = setup(readResource)
		fixture.callbacks.askApproval.mockResolvedValue(false)
		await accessMcpResourceTool.execute(
			{ server_name: "server", uri: "file:///item" },
			fixture.task,
			fixture.callbacks,
		)
		expect(readResource).not.toHaveBeenCalled()
		expect(fixture.pushToolResult).toHaveBeenCalledWith("denied")
	})

	it("does not dispatch a legacy resource read cancelled during approval", async () => {
		const readResource = vi.fn()
		const fixture = setup(readResource)
		const controller = new AbortController()
		const reason = new Error("cancelled resource approval")
		fixture.callbacks.askApproval.mockImplementation(async () => {
			controller.abort(reason)
			return true
		})
		await expect(
			accessMcpResourceTool.execute({ server_name: "server", uri: "file:///item" }, fixture.task, {
				...fixture.callbacks,
				signal: controller.signal,
			}),
		).rejects.toBe(reason)
		expect(readResource).not.toHaveBeenCalled()
		expect(fixture.pushToolResult).not.toHaveBeenCalled()
		expect(fixture.handleError).not.toHaveBeenCalled()
	})

	it("keeps an empty contents array successful", async () => {
		const fixture = setup(vi.fn().mockResolvedValue({ contents: [] }))
		await accessMcpResourceTool.execute(
			{ server_name: "server", uri: "file:///item" },
			fixture.task,
			fixture.callbacks,
		)

		expect(fixture.setResultMetadata).toHaveBeenCalledWith({
			status: "success",
			trustedProgress: {
				kind: "read",
				scope: expect.any(String),
				stateFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
		})
		expect(fixture.pushToolResult).toHaveBeenCalledWith("result: (Empty response)")
	})

	it("observes changed resource contents under the same URI", async () => {
		const readResource = vi.fn().mockResolvedValue({ contents: [{ text: "original" }] })
		const fixture = setup(readResource)
		const run = async () => {
			await accessMcpResourceTool.execute(
				{ server_name: "server", uri: "file:///item" },
				fixture.task,
				fixture.callbacks,
			)
			return fixture.setResultMetadata.mock.calls.at(-1)?.[0].trustedProgress
		}
		const original = await run()
		expect(original).toBeDefined()
		expect(await run()).toEqual(original)
		readResource.mockResolvedValue({ contents: [{ text: "changed" }] })
		expect(await run()).toMatchObject({
			scope: original.scope,
			stateFingerprint: expect.not.stringMatching(original.stateFingerprint),
		})
	})
})
