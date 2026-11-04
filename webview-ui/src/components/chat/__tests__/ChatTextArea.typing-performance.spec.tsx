import { createRef, useState, type Ref } from "react"
import { expect } from "vitest"

import { defaultModeSlug } from "@alpha/modes"
import { act, fireEvent, render, screen } from "@src/utils/test-utils"

import { ChatTextArea } from "../ChatTextArea"
import type { RestoreHistoryDraft } from "../hooks/usePromptHistory"

const { mockUseShellState } = vi.hoisted(() => ({ mockUseShellState: vi.fn() }))

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@src/context/ExtensionStateContext", () => ({
	useShellState: mockUseShellState,
	useExtensionState: mockUseShellState,
}))
vi.mock("../ChatView", () => ({ MAX_IMAGES_PER_MESSAGE: 20 }))
vi.mock("../ModeSelector", () => ({ ModeSelector: () => null }))
vi.mock("../ApiConfigSelector", () => ({ ApiConfigSelector: () => null }))
vi.mock("../AutoApproveDropdown", () => ({ AutoApproveDropdown: () => null }))
vi.mock("../../reasoning/ChatReasoningControl", () => ({ ChatReasoningControl: () => null }))
vi.mock("../IndexingStatusBadge", () => ({ IndexingStatusBadge: () => null }))

const noOp = () => {}
const shellState = {
	filePaths: [],
	openedTabs: [],
	taskHistory: [],
	alphaMessages: [],
	commands: [],
	cwd: "/workspace",
	currentTaskId: "task-a",
}
const defaultProps = {
	inputValue: "",
	setInputValue: noOp,
	onSend: noOp,
	sendingDisabled: false,
	selectApiConfigDisabled: false,
	onSelectImages: noOp,
	shouldDisableImages: false,
	placeholderText: "Message",
	selectedImages: [],
	setSelectedImages: noOp,
	mode: defaultModeSlug,
	setMode: noOp,
	modeShortcutText: "Shift + Tab",
}

function DraftComposer({
	onSubmit,
	inputRef,
	isStreaming = false,
	isEditMode = false,
	onRestoreHistoryDraft,
}: {
	onSubmit: (draft: string) => void
	inputRef?: Ref<HTMLTextAreaElement>
	isStreaming?: boolean
	isEditMode?: boolean
	onRestoreHistoryDraft?: RestoreHistoryDraft
}) {
	const [inputValue, setInputValue] = useState("")
	return (
		<ChatTextArea
			{...defaultProps}
			ref={inputRef}
			inputValue={inputValue}
			setInputValue={setInputValue}
			onSend={() => onSubmit(inputValue)}
			isStreaming={isStreaming}
			isEditMode={isEditMode}
			onRestoreHistoryDraft={onRestoreHistoryDraft}
		/>
	)
}

describe("composer typing resources", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockUseShellState.mockReturnValue(shellState)
	})
	afterEach(() => {
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	it.each([
		{ action: "send", isStreaming: false, autoSteer: false },
		{ action: "queue", isStreaming: true, autoSteer: false },
		{ action: "steer", isStreaming: true, autoSteer: true },
	])("keeps listeners and refs attached across 40 keystrokes before $action", ({ isStreaming, autoSteer }) => {
		mockUseShellState.mockReturnValue({ ...shellState, autoSteer })
		const addListener = vi.spyOn(window, "addEventListener")
		const removeListener = vi.spyOn(window, "removeEventListener")
		const inputRef = vi.fn()
		const onSubmit = vi.fn()
		const view = render(<DraftComposer inputRef={inputRef} onSubmit={onSubmit} isStreaming={isStreaming} />)
		const textarea = screen.getByRole("textbox")
		const messageListeners = addListener.mock.calls.filter(([type]) => type === "message")
		expect(messageListeners).toHaveLength(1)
		const messageListener = messageListeners[0][1]
		addListener.mockClear()
		removeListener.mockClear()
		inputRef.mockClear()

		const draft = "A prompt typed without opening a menu.  ".slice(0, 40)
		for (let index = 1; index <= draft.length; index++) {
			fireEvent.change(textarea, { target: { value: draft.slice(0, index), selectionStart: index } })
		}

		expect({
			messageSubscriptions: addListener.mock.calls.filter(([type]) => type === "message").length,
			messageUnsubscriptions: removeListener.mock.calls.filter(([type]) => type === "message").length,
			forwardedRefCallbacks: inputRef.mock.calls.length,
		}).toEqual({ messageSubscriptions: 0, messageUnsubscriptions: 0, forwardedRefCallbacks: 0 })
		expect(screen.getByRole("textbox")).toBe(textarea)
		expect(textarea).toHaveValue(draft)
		expect(
			screen.getByRole("button", {
				name: (_, button) => button.querySelector(".lucide-send-horizontal") !== null,
			}),
		).toBeEnabled()
		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(onSubmit).toHaveBeenCalledExactlyOnceWith(draft)

		view.unmount()
		expect(removeListener.mock.calls.filter(([type]) => type === "message")).toEqual([["message", messageListener]])
		expect(inputRef).toHaveBeenLastCalledWith(null)
	})

	it("inserts into the latest typed draft without renewing its message subscription", () => {
		vi.useFakeTimers()
		render(<DraftComposer onSubmit={noOp} />)
		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
		for (const value of ["Original draft", "Latest expanded draft"]) {
			fireEvent.change(textarea, { target: { value } })
		}
		const cursor = textarea.value.indexOf("draft")
		textarea.setSelectionRange(cursor, cursor)
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "insertTextIntoTextarea", text: "extra" } }),
			)
		})
		expect(textarea).toHaveValue("Latest expanded extra draft")
		act(() => vi.runOnlyPendingTimers())
		expect(textarea.selectionStart).toBe(cursor + "extra ".length)
		expect(textarea.selectionEnd).toBe(cursor + "extra ".length)
	})

	it("routes inserted text to a replacement draft setter and releases it on unmount", () => {
		vi.useFakeTimers()
		const previousSetter = vi.fn()
		const currentSetter = vi.fn()
		const view = render(
			<ChatTextArea {...defaultProps} inputValue="Previous draft" setInputValue={previousSetter} />,
		)
		view.rerender(<ChatTextArea {...defaultProps} inputValue="Current draft" setInputValue={currentSetter} />)
		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
		textarea.setSelectionRange("Current ".length, "Current ".length)
		const message = new MessageEvent("message", { data: { type: "insertTextIntoTextarea", text: "extra" } })
		act(() => window.dispatchEvent(message))
		expect(previousSetter).not.toHaveBeenCalled()
		expect(currentSetter).toHaveBeenCalledExactlyOnceWith("Current extra draft")
		act(() => vi.runOnlyPendingTimers())
		view.unmount()
		currentSetter.mockClear()
		act(() => window.dispatchEvent(message))
		expect(currentSetter).not.toHaveBeenCalled()
	})

	it("detaches a replaced callback ref and clears the current ref on unmount", () => {
		const previousRef = vi.fn()
		const currentRef = vi.fn()
		const view = render(<ChatTextArea {...defaultProps} ref={previousRef} />)
		const textarea = screen.getByRole("textbox")
		previousRef.mockClear()
		view.rerender(<ChatTextArea {...defaultProps} ref={currentRef} />)
		expect(previousRef).toHaveBeenLastCalledWith(null)
		expect(currentRef).toHaveBeenLastCalledWith(textarea)
		view.unmount()
		expect(currentRef).toHaveBeenLastCalledWith(null)
	})

	it("preserves object ref ownership when the caller replaces its ref", () => {
		const previousRef = createRef<HTMLTextAreaElement>()
		const currentRef = createRef<HTMLTextAreaElement>()
		const view = render(<ChatTextArea {...defaultProps} ref={previousRef} />)
		const textarea = screen.getByRole("textbox")
		expect(previousRef.current).toBe(textarea)
		view.rerender(<ChatTextArea {...defaultProps} ref={currentRef} />)
		expect(previousRef.current).toBeNull()
		expect(currentRef.current).toBe(textarea)
		view.unmount()
		expect(currentRef.current).toBeNull()
	})

	it("keeps composing Enter and Shift+Enter local while allowing an immediate send", () => {
		const onSubmit = vi.fn()
		render(<DraftComposer onSubmit={onSubmit} />)
		const textarea = screen.getByRole("textbox")
		fireEvent.change(textarea, { target: { value: "Draft with an IME" } })
		expect(fireEvent.keyDown(textarea, { key: "Enter", isComposing: true })).toBe(true)
		expect(fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true })).toBe(true)
		expect(onSubmit).not.toHaveBeenCalled()
		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(onSubmit).toHaveBeenCalledExactlyOnceWith("Draft with an IME")
	})

	it.each([false, true])("leaves completion-menu keys with the active IME (edit=%s)", (isEditMode) => {
		vi.useFakeTimers()
		mockUseShellState.mockReturnValue({
			...shellState,
			openedTabs: [{ path: "fixture.ts" }, { path: "fixture-two.ts" }],
		})
		const onSubmit = vi.fn()
		render(<DraftComposer onSubmit={onSubmit} isEditMode={isEditMode} />)
		const textarea = screen.getByRole("textbox")
		fireEvent.change(textarea, { target: { value: "@f", selectionStart: 2 } })
		const menu = screen.getByRole("listbox")
		expect(screen.getAllByRole("option")).toHaveLength(2)
		const selectedOption = textarea.getAttribute("aria-activedescendant")
		expect(selectedOption).toBeTruthy()
		for (const key of ["Enter", "ArrowUp", "ArrowDown", "Tab", "Escape"]) {
			expect(fireEvent.keyDown(textarea, { key, isComposing: true })).toBe(true)
			expect(textarea).toHaveValue("@f")
			expect(screen.getByRole("listbox")).toBe(menu)
			expect(textarea).toHaveAttribute("aria-activedescendant", selectedOption)
		}
		expect(onSubmit).not.toHaveBeenCalled()
		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(textarea).toHaveValue("@/fixture.ts ")
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
		expect(onSubmit).not.toHaveBeenCalled()
	})

	it.each(["keyboard", "button"])("ends draft recovery after a %s submission", (submission) => {
		vi.useFakeTimers()
		mockUseShellState.mockReturnValue({
			...shellState,
			alphaMessages: [{ type: "say", say: "user_feedback", text: "previous prompt", ts: 1 }],
		})
		const onSubmit = vi.fn()
		const restore = vi.fn()
		const view = render(<DraftComposer onSubmit={onSubmit} onRestoreHistoryDraft={restore} />)
		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: "unsent draft" } })
		textarea.setSelectionRange(0, 0)
		fireEvent.keyDown(textarea, { key: "ArrowUp" })
		expect(textarea).toHaveValue("previous prompt")
		if (submission === "keyboard") {
			fireEvent.keyDown(textarea, { key: "Enter" })
		} else {
			fireEvent.click(
				screen.getByRole("button", {
					name: (_, button) => button.querySelector(".lucide-send-horizontal") !== null,
				}),
			)
		}
		expect(onSubmit).toHaveBeenCalledExactlyOnceWith("previous prompt")
		view.unmount()
		expect(restore).not.toHaveBeenCalled()
	})

	it("preserves Enter=newline and the Ctrl+Enter send shortcut", () => {
		mockUseShellState.mockReturnValue({ ...shellState, enterBehavior: "newline" })
		const onSubmit = vi.fn()
		render(<DraftComposer onSubmit={onSubmit} />)
		const textarea = screen.getByRole("textbox")
		fireEvent.change(textarea, { target: { value: "Multiline draft" } })
		expect(fireEvent.keyDown(textarea, { key: "Enter" })).toBe(true)
		expect(fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true, isComposing: true })).toBe(true)
		expect(onSubmit).not.toHaveBeenCalled()
		fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true })
		expect(onSubmit).toHaveBeenCalledExactlyOnceWith("Multiline draft")
	})
})
