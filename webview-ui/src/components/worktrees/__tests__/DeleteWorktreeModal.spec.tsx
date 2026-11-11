import { act, fireEvent, render, screen } from "@testing-library/react"

import type { ExtensionMessage, WebviewMessage, Worktree } from "@alpha-code/types"

import { DeleteWorktreeModal } from "../DeleteWorktreeModal"

const mockPostMessage = vi.fn<(message: WebviewMessage) => void>()

vi.mock("@/utils/vscode", () => ({
	vscode: { postMessage: (message: WebviewMessage) => mockPostMessage(message) },
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const worktree: Worktree = {
	path: "/worktrees/feature",
	branch: "feature",
	commitHash: "abc123",
	isCurrent: false,
	isBare: false,
	isDetached: false,
	isLocked: false,
}

const receive = (message: Partial<ExtensionMessage>) => {
	act(() => window.dispatchEvent(new MessageEvent("message", { data: message })))
}

const remove = () => {
	fireEvent.click(screen.getByRole("button", { name: "worktrees:delete" }))
	return mockPostMessage.mock.calls
		.map(([message]) => message)
		.findLast((message) => message.type === "deleteWorktree")!
}

describe("DeleteWorktreeModal", () => {
	beforeEach(() => mockPostMessage.mockClear())

	it("ignores operation results before the user requests deletion", () => {
		const onClose = vi.fn()
		const onSuccess = vi.fn()
		render(<DeleteWorktreeModal open worktree={worktree} onClose={onClose} onSuccess={onSuccess} />)

		receive({ type: "worktreeResult", success: true })
		receive({ type: "worktreeResult", requestId: "unrelated", success: false, text: "Unrelated failure" })

		expect(onClose).not.toHaveBeenCalled()
		expect(onSuccess).not.toHaveBeenCalled()
		expect(screen.queryByText("Unrelated failure")).not.toBeInTheDocument()
	})

	it("ignores unrelated results while the deletion is pending", () => {
		const onClose = vi.fn()
		render(<DeleteWorktreeModal open worktree={worktree} onClose={onClose} />)
		remove()

		receive({ type: "worktreeResult", requestId: "unrelated", success: true })
		receive({ type: "worktreeResult", success: true })

		expect(screen.getByRole("button", { name: "worktrees:deleting" })).toBeDisabled()
		expect(onClose).not.toHaveBeenCalled()
	})

	it("settles only once for the matching completion", () => {
		const onClose = vi.fn()
		const onSuccess = vi.fn()
		render(<DeleteWorktreeModal open worktree={worktree} onClose={onClose} onSuccess={onSuccess} />)
		const message = remove()
		expect(message).toMatchObject({
			requestId: expect.any(String),
			worktreePath: worktree.path,
			worktreeForce: true,
		})
		receive({ type: "worktreeResult", requestId: message.requestId, success: true })
		receive({ type: "worktreeResult", requestId: message.requestId, success: true })

		expect(onClose).toHaveBeenCalledTimes(1)
		expect(onSuccess).toHaveBeenCalledTimes(1)
	})

	it("keeps retries independent of late results for the previous deletion", () => {
		const onClose = vi.fn()
		render(<DeleteWorktreeModal open worktree={worktree} onClose={onClose} />)
		const first = remove()
		receive({ type: "worktreeResult", requestId: first.requestId, success: false, text: "Delete failed" })
		expect(screen.getByText("Delete failed")).toBeInTheDocument()
		const second = remove()
		expect(second.requestId).not.toBe(first.requestId)

		receive({ type: "worktreeResult", requestId: first.requestId, success: true })
		expect(onClose).not.toHaveBeenCalled()
		receive({ type: "worktreeResult", requestId: second.requestId, success: true })
		expect(onClose).toHaveBeenCalledTimes(1)
	})

	it("ignores an earlier completion after closing and reopening", () => {
		const onClose = vi.fn()
		const { rerender } = render(<DeleteWorktreeModal open worktree={worktree} onClose={onClose} />)
		const first = remove()
		rerender(<DeleteWorktreeModal open={false} worktree={worktree} onClose={onClose} />)
		rerender(<DeleteWorktreeModal open worktree={worktree} onClose={onClose} />)

		receive({ type: "worktreeResult", requestId: first.requestId, success: true })

		expect(onClose).not.toHaveBeenCalled()
		expect(screen.getByRole("button", { name: "worktrees:delete" })).toBeEnabled()
	})

	it("ignores an earlier worktree's completion after the target changes", () => {
		const onClose = vi.fn()
		const { rerender } = render(<DeleteWorktreeModal open worktree={worktree} onClose={onClose} />)
		const first = remove()
		rerender(<DeleteWorktreeModal open worktree={{ ...worktree, path: "/worktrees/other" }} onClose={onClose} />)

		receive({ type: "worktreeResult", requestId: first.requestId, success: true })

		expect(onClose).not.toHaveBeenCalled()
		expect(screen.getByRole("button", { name: "worktrees:delete" })).toBeEnabled()
	})
})
