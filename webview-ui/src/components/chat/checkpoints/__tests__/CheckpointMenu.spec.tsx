import { expect } from "vitest"
import type { ReactNode } from "react"
import userEvent from "@testing-library/user-event"

import { act, fireEvent, render, screen } from "@/utils/test-utils"
import { installNativeTestFocus } from "@/utils/test-native-focus"
import { vscode } from "@src/utils/vscode"

import { CheckpointMenu } from "../CheckpointMenu"

const taskState = vi.hoisted(() => {
	const state: { currentTaskId?: string } = { currentTaskId: "task-a" }
	return state
})

let restoreOpenChange: ((open: boolean) => void) | undefined

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/context/ExtensionStateContext", () => ({ useShellState: () => taskState }))
vi.mock("@/components/ui/hooks", () => ({ useAlphaPortal: () => undefined }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@/components/ui", async () => ({
	Button: (await vi.importActual<typeof import("@/components/ui/button")>("@/components/ui/button")).Button,
	StandardTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
	Popover: ({
		children,
		open,
		onOpenChange,
		...props
	}: {
		children: ReactNode
		open: boolean
		onOpenChange: (open: boolean) => void
		"data-testid"?: string
	}) => {
		if (props["data-testid"] === "restore-popover") restoreOpenChange = onOpenChange
		return (
			<div data-testid={props["data-testid"]} data-open={open}>
				{children}
			</div>
		)
	},
	PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
	PopoverContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

const checkpointProps = {
	ts: 123,
	commitHash: "checkpoint-a",
	checkpoint: { from: "previous", to: "checkpoint-a" },
}

const restoreActions = [
	["preview", "restore-files-btn"],
	["restore", "restore-files-and-task-btn"],
] as const

function openRestore() {
	act(() => restoreOpenChange?.(true))
}

describe("CheckpointMenu restore safeguards", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		taskState.currentTaskId = "task-a"
		restoreOpenChange = undefined
	})

	it.each(restoreActions)("requires confirmation before dispatching %s restoration", (mode, actionId) => {
		render(<CheckpointMenu {...checkpointProps} />)
		openRestore()
		fireEvent.click(screen.getByTestId(actionId))

		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(screen.getByTestId("checkpoint-confirm-warning")).toHaveTextContent(
			"chat:checkpoint.menu.restoreWorkspaceWarning",
		)
		expect(screen.getByTestId("checkpoint-confirm-warning")).toHaveTextContent("chat:checkpoint.menu.cannotUndo")

		fireEvent.click(screen.getByTestId("confirm-restore-btn"))

		expect(vscode.postMessage).toHaveBeenCalledExactlyOnceWith({
			type: "checkpointRestore",
			taskId: "task-a",
			payload: { ts: 123, commitHash: "checkpoint-a", mode },
		})
		expect(screen.getByTestId("restore-popover")).toHaveAttribute("data-open", "false")
	})

	it.each(restoreActions)("cancels %s restoration without sending an event", (_mode, actionId) => {
		render(<CheckpointMenu {...checkpointProps} />)
		openRestore()
		fireEvent.click(screen.getByTestId(actionId))
		fireEvent.click(screen.getByRole("button", { name: "chat:checkpoint.menu.cancel" }))

		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(screen.queryByTestId("confirm-restore-btn")).not.toBeInTheDocument()
		expect(screen.getByTestId("restore-files-btn")).toBeInTheDocument()
		expect(screen.getByTestId("restore-files-and-task-btn")).toBeInTheDocument()
	})

	it.each(restoreActions)("returns keyboard focus to the %s action after Cancel", async (_mode, actionId) => {
		const restoreFocus = installNativeTestFocus()
		try {
			const user = userEvent.setup()
			render(<CheckpointMenu {...checkpointProps} />)
			openRestore()
			screen.getByTestId(actionId).focus()
			await user.keyboard("{Enter}")
			expect(screen.getByRole("button", { name: "chat:checkpoint.menu.cancel" })).toHaveFocus()

			await user.keyboard("{Enter}")

			expect(screen.getByTestId(actionId)).toHaveFocus()
			expect(vscode.postMessage).not.toHaveBeenCalled()
		} finally {
			restoreFocus()
		}
	})

	it("labels the diff action and routes it to the visible task", () => {
		render(<CheckpointMenu {...checkpointProps} />)
		fireEvent.click(screen.getByRole("button", { name: "chat:checkpoint.menu.viewDiff" }))

		expect(vscode.postMessage).toHaveBeenCalledExactlyOnceWith({
			type: "checkpointDiff",
			taskId: "task-a",
			payload: { ts: 123, previousCommitHash: "previous", commitHash: "checkpoint-a", mode: "checkpoint" },
		})
	})

	it.each(restoreActions)("clears pending %s confirmation when its popover closes", (_mode, actionId) => {
		render(<CheckpointMenu {...checkpointProps} />)
		openRestore()
		fireEvent.click(screen.getByTestId(actionId))
		act(() => restoreOpenChange?.(false))
		openRestore()

		expect(screen.queryByTestId("confirm-restore-btn")).not.toBeInTheDocument()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it.each(restoreActions)("does not carry %s confirmation into a different task", (_mode, actionId) => {
		const { rerender } = render(<CheckpointMenu {...checkpointProps} />)
		openRestore()
		fireEvent.click(screen.getByTestId(actionId))

		taskState.currentTaskId = "task-b"
		rerender(<CheckpointMenu {...checkpointProps} />)

		expect(screen.queryByTestId("confirm-restore-btn")).not.toBeInTheDocument()
		expect(vscode.postMessage).not.toHaveBeenCalled()
		taskState.currentTaskId = "task-a"
		rerender(<CheckpointMenu {...checkpointProps} />)
		expect(screen.queryByTestId("confirm-restore-btn")).not.toBeInTheDocument()
		taskState.currentTaskId = "task-b"
		rerender(<CheckpointMenu {...checkpointProps} />)
		fireEvent.click(screen.getByTestId(actionId))
		fireEvent.click(screen.getByTestId("confirm-restore-btn"))
		expect(vi.mocked(vscode.postMessage).mock.calls[0][0]).toMatchObject({ taskId: "task-b" })
	})

	it("does not carry confirmation to a different checkpoint", () => {
		const { rerender } = render(<CheckpointMenu {...checkpointProps} />)
		openRestore()
		fireEvent.click(screen.getByTestId("restore-files-btn"))
		rerender(<CheckpointMenu {...checkpointProps} ts={456} commitHash="checkpoint-b" />)

		expect(screen.queryByTestId("confirm-restore-btn")).not.toBeInTheDocument()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("does not offer restoration without a task destination", () => {
		taskState.currentTaskId = undefined
		render(<CheckpointMenu {...checkpointProps} />)
		openRestore()

		expect(screen.getByTestId("restore-files-btn")).toBeDisabled()
		expect(screen.getByTestId("restore-files-and-task-btn")).toBeDisabled()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})
})
