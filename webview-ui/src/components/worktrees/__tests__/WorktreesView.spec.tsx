import { expect } from "vitest"
import { act, fireEvent, render, screen } from "@/utils/test-utils"
import userEvent from "@testing-library/user-event"
import { installNativeTestFocus } from "@/utils/test-native-focus"

import type { Worktree, WorktreeListResponse } from "@alpha-code/types"

import { WorktreesView } from "../WorktreesView"

const mockPostMessage = vi.fn()

vi.mock("@/utils/vscode", () => ({
	vscode: { postMessage: (message: unknown) => mockPostMessage(message) },
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const currentWorktree: Worktree = {
	path: "/repo",
	branch: "main",
	commitHash: "abc123",
	isCurrent: true,
	isBare: false,
	isDetached: false,
	isLocked: false,
}

const receiveList = (overrides: Partial<WorktreeListResponse> = {}) => {
	act(() =>
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "worktreeList",
					worktrees: [currentWorktree],
					isGitRepo: true,
					isMultiRoot: false,
					isSubfolder: false,
					gitRootPath: "/repo",
					...overrides,
				},
			}),
		),
	)
}

describe("WorktreesView", () => {
	beforeEach(() => mockPostMessage.mockClear())

	it("opens as a resource manager without a home-screen preference", () => {
		render(<WorktreesView />)
		receiveList()

		expect(mockPostMessage).toHaveBeenCalledWith({ type: "listWorktrees" })
		expect(mockPostMessage).toHaveBeenCalledWith({ type: "getWorktreeIncludeStatus" })
		expect(screen.getByRole("button", { name: "worktrees:newWorktree" })).toBeInTheDocument()
		expect(screen.queryByRole("switch", { name: "worktrees:showInHomeScreen" })).not.toBeInTheDocument()
	})

	it("retains the edit-buffer callback for an existing preference consumer", () => {
		const onChange = vi.fn()
		render(<WorktreesView showWorktreesInHomeScreen onShowWorktreesInHomeScreenChange={onChange} />)
		receiveList()

		fireEvent.click(screen.getByRole("switch", { name: "worktrees:showInHomeScreen" }))

		expect(onChange).toHaveBeenCalledExactlyOnceWith(false)
		expect(mockPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateSettings" }))
	})

	it("explains multi-root support before considering Git status", () => {
		render(<WorktreesView />)
		receiveList({ worktrees: [], isGitRepo: false, isMultiRoot: true })

		expect(screen.getByText("worktrees:multiRootNotSupported")).toBeInTheDocument()
		expect(screen.queryByText("worktrees:notGitRepo")).not.toBeInTheDocument()
	})

	it("keeps the last list visible when refreshing fails and clears the error after recovery", () => {
		render(<WorktreesView />)
		receiveList()
		receiveList({ worktrees: [], error: "Git listing failed" })

		expect(screen.getByRole("alert")).toHaveTextContent("Git listing failed")
		expect(screen.getByText("/repo")).toBeInTheDocument()
		mockPostMessage.mockClear()
		fireEvent.click(screen.getByRole("button", { name: "worktrees:refresh" }))

		expect(mockPostMessage).toHaveBeenCalledWith({ type: "listWorktrees" })
		expect(screen.getByRole("alert")).toHaveTextContent("Git listing failed")
		receiveList()
		expect(screen.queryByRole("alert")).not.toBeInTheDocument()
	})

	it("renders an empty response explicitly", () => {
		render(<WorktreesView />)
		receiveList({ worktrees: [] })

		expect(screen.getByText("worktrees:emptyList")).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "worktrees:refresh" })).toBeEnabled()
	})

	it("does not offer deletion of a locked worktree", () => {
		render(<WorktreesView />)
		receiveList({
			worktrees: [{ ...currentWorktree, path: "/locked", isCurrent: false, isLocked: true }],
		})

		expect(screen.getByRole("button", { name: "worktrees:delete" })).toBeDisabled()
	})

	it.each(["{Enter}", " "])("switches in the current window with the %s key", async (key) => {
		const restoreFocus = installNativeTestFocus()
		try {
			const user = userEvent.setup()
			render(<WorktreesView />)
			receiveList({ worktrees: [{ ...currentWorktree, path: "/feature", branch: "feature", isCurrent: false }] })
			const switchButton = screen.getByRole("button", {
				name: "worktrees:switchInThisWindow: feature (/feature)",
			})
			switchButton.focus()
			expect(switchButton).toHaveFocus()

			await user.keyboard(key)

			expect(mockPostMessage).toHaveBeenCalledWith({
				type: "switchWorktree",
				worktreePath: "/feature",
				worktreeNewWindow: false,
			})
		} finally {
			restoreFocus()
		}
	})
})
