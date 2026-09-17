import { beforeEach, describe, expect, it, vi } from "vitest"

import { GitHubApiClient, GitHubRequestInterruptedError } from "../../../services/github/GitHubApiClient"
import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"
import { githubApiTool } from "../GitHubApiTool"

vi.mock("../../../services/github/GitHubApiClient", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../../services/github/GitHubApiClient")>()
	return { ...original, GitHubApiClient: vi.fn() }
})

const params = {
	action: "comment" as const,
	owner: "owner",
	repo: "repo",
	issue_number: 1,
	body: "Review this exact\nbody",
}

function harness(signal?: AbortSignal) {
	const getSecret = vi.fn().mockReturnValue("test-token")
	const task = {
		providerRef: { deref: () => ({ contextProxy: { getSecret } }) },
		consecutiveMistakeCount: 0,
	} as unknown as Task
	const callbacks = {
		askApproval: vi.fn<ToolCallbacks["askApproval"]>().mockResolvedValue(true),
		handleError: vi.fn(),
		pushToolResult: vi.fn(),
		setResultMetadata: vi.fn(),
		signal,
	} satisfies ToolCallbacks
	return { task, callbacks, getSecret }
}

describe("GitHubApiTool effects", () => {
	beforeEach(() => vi.clearAllMocks())

	it("shows the full comment in the forced approval payload", async () => {
		const { task, callbacks } = harness()
		callbacks.askApproval.mockResolvedValue(false)
		await githubApiTool.execute(params, task, callbacks)
		const payload = JSON.parse(callbacks.askApproval.mock.calls[0][1]!)
		expect(payload.github ?? payload).toMatchObject(params)
		expect(callbacks.askApproval).toHaveBeenCalledWith("tool", expect.any(String), undefined, true)
		expect(GitHubApiClient).not.toHaveBeenCalled()
	})

	it("does not request approval when already cancelled", async () => {
		const controller = new AbortController()
		controller.abort()
		const { task, callbacks } = harness(controller.signal)
		await githubApiTool.execute(params, task, callbacks)
		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(GitHubApiClient).not.toHaveBeenCalled()
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "cancelled" })
	})

	it("does not start a write when cancellation arrives during approval", async () => {
		const controller = new AbortController()
		const { task, callbacks, getSecret } = harness(controller.signal)
		callbacks.askApproval.mockImplementation(async () => {
			controller.abort()
			return true
		})
		await githubApiTool.execute(params, task, callbacks)
		expect(getSecret).not.toHaveBeenCalled()
		expect(GitHubApiClient).not.toHaveBeenCalled()
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "cancelled" })
		expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
	})

	it.each(["cancelled", "timeout"] as const)(
		"returns one terminal result with the uncertain write outcome after %s",
		async (reason) => {
			const controller = new AbortController()
			const { task, callbacks } = harness(controller.signal)
			const comment = vi.fn().mockRejectedValue(new GitHubRequestInterruptedError(reason, true))
			vi.mocked(GitHubApiClient).mockImplementation(() => ({ comment }) as unknown as GitHubApiClient)
			await githubApiTool.execute(params, task, callbacks)
			expect(GitHubApiClient).toHaveBeenCalledWith("test-token", { signal: controller.signal })
			expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("check its state before retrying"),
			)
			expect(callbacks.setResultMetadata).toHaveBeenCalledWith(
				reason === "cancelled" ? { status: "cancelled" } : { status: "error", timedOut: true },
			)
			expect(callbacks.handleError).not.toHaveBeenCalled()
		},
	)

	it("includes the full commit title and message when approving a merge", async () => {
		const { task, callbacks } = harness()
		callbacks.askApproval.mockResolvedValue(false)
		const merge = {
			action: "merge_pull_request" as const,
			owner: "owner",
			repo: "repo",
			pull_number: 2,
			title: "Commit title",
			message: "Complete\ncommit message",
			merge_method: "squash" as const,
		}
		await githubApiTool.execute(merge, task, callbacks)
		expect(JSON.parse(callbacks.askApproval.mock.calls[0][1]!).github).toEqual(merge)
	})
})
