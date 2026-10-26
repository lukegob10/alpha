import type { WebviewMessage } from "@alpha-code/types"

import { webviewMessageHandler } from "../webviewMessageHandler"
import type { AlphaProvider } from "../AlphaProvider"
import { handleCreateWorktree } from "../worktree/handlers"

vi.mock("../worktree/handlers", async (importOriginal) => ({
	...(await importOriginal<typeof import("../worktree/handlers")>()),
	handleCreateWorktree: vi.fn(),
}))

const createProvider = () => ({
	getCurrentTask: () => undefined,
	postMessageToWebview: vi.fn(),
})

const request: WebviewMessage = {
	type: "createWorktree",
	requestId: "create-a",
	worktreePath: "/worktrees/new",
	worktreeBranch: "worktree/feature",
	worktreeBaseBranch: "main",
	worktreeCreateNewBranch: true,
}

describe("worktree create request correlation", () => {
	beforeEach(() => vi.clearAllMocks())

	it("echoes the captured request ID in progress and completion", async () => {
		const provider = createProvider()
		const message = { ...request }
		vi.mocked(handleCreateWorktree).mockImplementation(async (_provider, _options, onProgress) => {
			message.requestId = "changed-after-admission"
			onProgress?.({ bytesCopied: 12, itemName: "nested/file" })
			return { success: true, message: "Created" }
		})

		await webviewMessageHandler(provider as unknown as AlphaProvider, message)

		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "worktreeCopyProgress",
			requestId: "create-a",
			copyProgressBytesCopied: 12,
			copyProgressItemName: "nested/file",
		})
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "worktreeResult",
			requestId: "create-a",
			success: true,
			text: "Created",
		})
	})

	it.each(["result", "exception"])("echoes the request ID on %s failure", async (failure) => {
		const provider = createProvider()
		if (failure === "exception") vi.mocked(handleCreateWorktree).mockRejectedValueOnce(new Error("Create failed"))
		else vi.mocked(handleCreateWorktree).mockResolvedValueOnce({ success: false, message: "Create failed" })

		await webviewMessageHandler(provider as unknown as AlphaProvider, request)

		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "worktreeResult",
			requestId: "create-a",
			success: false,
			text: "Create failed",
		})
	})

	it("keeps legacy requests without correlation readable", async () => {
		const provider = createProvider()
		vi.mocked(handleCreateWorktree).mockResolvedValueOnce({ success: true, message: "Created" })
		const { requestId: _requestId, ...legacy } = request

		await webviewMessageHandler(provider as unknown as AlphaProvider, legacy)

		expect(provider.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "worktreeResult",
			success: true,
			text: "Created",
		})
	})
})
