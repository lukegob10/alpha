import { beforeEach, describe, expect, it, vi } from "vitest"

import { searchCommits } from "../../../utils/git"
import type { AlphaProvider } from "../AlphaProvider"
import { webviewMessageHandler } from "../webviewMessageHandler"

vi.mock("../../../utils/git", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../utils/git")>()),
	searchCommits: vi.fn(),
}))

const request = { type: "searchCommits", query: "repair", requestId: "commit-search" } as const
const commits = [{ hash: "abcdef123", shortHash: "abcdef", subject: "repair", author: "Alex", date: "2026-11-10" }]

function fixture() {
	const task = { cwd: "/origin-workspace" }
	const host = {
		cwd: "/draft-workspace",
		getCurrentTask: vi.fn(() => ({ cwd: "/foreground-workspace" })),
		getLiveTask: vi.fn((taskId: string) => (taskId === "origin" ? task : undefined)),
		postMessageToWebview: vi.fn(),
		log: vi.fn(),
	}
	return { host, task, provider: host as unknown as AlphaProvider }
}

describe("webview commit search routing", () => {
	beforeEach(() => {
		vi.mocked(searchCommits).mockReset().mockResolvedValue(commits)
	})

	it("searches the addressed task's repository and echoes its request identity", async () => {
		const { host, task, provider } = fixture()
		await webviewMessageHandler(provider, { ...request, taskId: "origin" })
		expect(searchCommits).toHaveBeenCalledExactlyOnceWith(request.query, task.cwd)
		expect(host.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "commitSearchResults",
			requestId: request.requestId,
			taskId: "origin",
			commits,
		})
	})

	it.each(["missing", ""])("does not search the foreground for an unavailable task ID %j", async (taskId) => {
		const { host, provider } = fixture()
		await webviewMessageHandler(provider, { ...request, taskId })
		expect(searchCommits).not.toHaveBeenCalled()
		expect(host.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "commitSearchResults",
			requestId: request.requestId,
			taskId,
			commits: [],
		})
	})

	it("keeps correlated draft searches in the draft workspace after task selection changes", async () => {
		const { host, provider } = fixture()
		await webviewMessageHandler(provider, request)
		expect(searchCommits).toHaveBeenCalledExactlyOnceWith(request.query, host.cwd)
		expect(host.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ requestId: request.requestId, commits }),
		)
	})

	it("discards results from a superseded task runtime", async () => {
		const { host, provider } = fixture()
		let resolveSearch!: (result: typeof commits) => void
		const pending = new Promise<typeof commits>((resolve) => {
			resolveSearch = resolve
		})
		vi.mocked(searchCommits).mockReturnValueOnce(pending)
		const search = webviewMessageHandler(provider, { ...request, taskId: "origin" })
		host.getLiveTask.mockReturnValue({ cwd: "/replacement-workspace" })
		resolveSearch(commits)
		await search
		expect(host.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "commitSearchResults",
			requestId: request.requestId,
			taskId: "origin",
			commits: [],
		})
	})
})
