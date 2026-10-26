import { act, fireEvent, render, screen } from "@testing-library/react"

import type { ExtensionMessage, WebviewMessage } from "@alpha-code/types"

import { CreateWorktreeModal } from "../CreateWorktreeModal"

const mockPostMessage = vi.fn<(message: WebviewMessage) => void>()

vi.mock("@/utils/vscode", () => ({
	vscode: { postMessage: (message: WebviewMessage) => mockPostMessage(message) },
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const receive = (message: Partial<ExtensionMessage>) => {
	act(() => window.dispatchEvent(new MessageEvent("message", { data: message })))
}

const populate = () => {
	receive({ type: "worktreeDefaults", suggestedBranch: "worktree/feature", suggestedPath: "/worktrees/submitted" })
	receive({ type: "branchList", localBranches: ["main"], remoteBranches: [], currentBranch: "main" })
}

const create = () => {
	fireEvent.click(screen.getByRole("button", { name: "worktrees:create" }))
	const message = mockPostMessage.mock.calls
		.map(([message]) => message)
		.findLast((message) => message.type === "createWorktree")!
	expect(message).toMatchObject({ requestId: expect.any(String), worktreePath: "/worktrees/submitted" })
	return message.requestId!
}

describe("CreateWorktreeModal", () => {
	beforeEach(() => mockPostMessage.mockClear())

	it("ignores operation results when it has no pending create request", () => {
		const onClose = vi.fn()
		render(<CreateWorktreeModal open onClose={onClose} openAfterCreate />)
		populate()

		receive({ type: "worktreeResult", requestId: "another-operation", success: true })

		expect(onClose).not.toHaveBeenCalled()
		expect(mockPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "switchWorktree" }))
	})

	it("opens the submitted path after a matching completion even if the form changes", () => {
		const onClose = vi.fn()
		const onSuccess = vi.fn()
		render(<CreateWorktreeModal open onClose={onClose} onSuccess={onSuccess} openAfterCreate />)
		populate()
		const requestId = create()
		fireEvent.change(screen.getByDisplayValue("/worktrees/submitted"), { target: { value: "/worktrees/edited" } })

		receive({ type: "worktreeResult", requestId, success: true })
		receive({ type: "worktreeResult", requestId, success: true })

		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "switchWorktree",
			worktreePath: "/worktrees/submitted",
			worktreeNewWindow: true,
		})
		expect(onClose).toHaveBeenCalledTimes(1)
		expect(onSuccess).toHaveBeenCalledTimes(1)
	})

	it("ignores unrelated results and copy progress while a create request is pending", () => {
		const onClose = vi.fn()
		render(<CreateWorktreeModal open onClose={onClose} />)
		populate()
		const requestId = create()

		receive({
			type: "worktreeCopyProgress",
			requestId: "another-operation",
			copyProgressItemName: "foreign file",
			copyProgressBytesCopied: 12,
		})
		receive({ type: "worktreeResult", requestId: "another-operation", success: true })
		receive({ type: "worktreeResult", success: true })

		expect(screen.queryByText("worktrees:copyingFiles")).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: "worktrees:creating" })).toBeDisabled()
		expect(onClose).not.toHaveBeenCalled()
		receive({
			type: "worktreeCopyProgress",
			requestId,
			copyProgressItemName: "own file",
			copyProgressBytesCopied: 12,
		})
		expect(screen.getByText("worktrees:copyingFiles")).toBeInTheDocument()
	})

	it("keeps a retry independent from late results for the previous request", () => {
		const onClose = vi.fn()
		render(<CreateWorktreeModal open onClose={onClose} />)
		populate()
		const first = create()
		receive({ type: "worktreeResult", requestId: first, success: false, text: "Creation failed" })
		expect(screen.getByText("Creation failed")).toBeInTheDocument()
		const second = create()
		expect(second).not.toBe(first)

		receive({ type: "worktreeResult", requestId: first, success: true })
		expect(onClose).not.toHaveBeenCalled()
		receive({ type: "worktreeResult", requestId: second, success: true })
		expect(onClose).toHaveBeenCalledTimes(1)
	})

	it("ignores an earlier create completion after closing and reopening", () => {
		const onClose = vi.fn()
		const { rerender } = render(<CreateWorktreeModal open onClose={onClose} openAfterCreate />)
		populate()
		const requestId = create()
		rerender(<CreateWorktreeModal open={false} onClose={onClose} openAfterCreate />)
		rerender(<CreateWorktreeModal open onClose={onClose} openAfterCreate />)

		receive({ type: "worktreeResult", requestId, success: true })

		expect(onClose).not.toHaveBeenCalled()
		expect(screen.getByRole("button", { name: "worktrees:create" })).toBeEnabled()
		expect(mockPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "switchWorktree" }))
	})
})
