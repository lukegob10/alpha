import type { Task } from "../../task/Task"
import { accessMcpResourceTool } from "../accessMcpResourceTool"

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolDenied: () => "denied",
		toolResult: (text: string) => `result: ${text}`,
	},
}))

describe("accessMcpResourceTool", () => {
	function setup(readResource?: ReturnType<typeof vi.fn>) {
		const setResultMetadata = vi.fn()
		const handleError = vi.fn()
		const pushToolResult = vi.fn()
		const task = {
			consecutiveMistakeCount: 0,
			didToolFailInCurrentTurn: false,
			recordToolError: vi.fn(),
			sayAndCreateMissingParamError: vi.fn(),
			say: vi.fn(),
			providerRef: {
				deref: () => ({ getMcpHub: () => (readResource ? { readResource } : undefined) }),
			},
		} as unknown as Task
		return {
			task,
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
