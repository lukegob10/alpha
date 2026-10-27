import { defaultModeSlug } from "@alpha/modes"

import { render, fireEvent, screen, waitFor, act } from "@src/utils/test-utils"
import { useState } from "react"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"
import * as pathMentions from "@src/utils/path-mentions"

import { ChatTextArea } from "../ChatTextArea"

const { useExtensionState: mockUseExtensionState } = vi.hoisted(() => ({
	useExtensionState: vi.fn(),
}))

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@src/components/common/CodeBlock")
vi.mock("@src/components/common/MarkdownBlock")
vi.mock("@src/utils/path-mentions", () => ({
	convertToMentionPath: vi.fn((path, cwd) => {
		// Simple mock implementation that mimics the real function's behavior
		if (path.startsWith("file://")) {
			path = decodeURIComponent(path.substring("file://".length))
		}
		if (cwd && path.toLowerCase().startsWith(cwd.toLowerCase())) {
			const relativePath = path.substring(cwd.length)
			return "@" + (relativePath.startsWith("/") ? relativePath : "/" + relativePath)
		}
		return path
	}),
}))

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: mockUseExtensionState,
	useShellState: (...args: unknown[]) => mockUseExtensionState(...(args as [])),
}))

const mockPostMessage = vscode.postMessage as import("vitest").Mock
const mockConvertToMentionPath = pathMentions.convertToMentionPath as import("vitest").Mock
const getEnhancementRequest = () =>
	mockPostMessage.mock.calls.filter(([message]) => message.type === "enhancePrompt").at(-1)![0]

const getEnhancePromptButton = () => {
	const existing = screen.queryByRole("menuitem", { name: "Improve prompt" })
	if (existing) return existing
	fireEvent.keyDown(screen.getByRole("button", { name: "Draft actions" }), { key: "ArrowDown" })
	return screen.getByRole("menuitem", { name: "Improve prompt" })
}

const getCancelEnhancementButton = () => {
	const existing = screen.queryByRole("menuitem", { name: "Cancel prompt improvement" })
	if (existing) return existing
	fireEvent.keyDown(screen.getByRole("button", { name: "Draft actions" }), { key: "ArrowDown" })
	return screen.getByRole("menuitem", { name: "Cancel prompt improvement" })
}

describe("ChatTextArea", () => {
	const defaultProps = {
		inputValue: "",
		setInputValue: vi.fn(),
		onSend: vi.fn(),
		sendingDisabled: false,
		selectApiConfigDisabled: false,
		onSelectImages: vi.fn(),
		shouldDisableImages: false,
		placeholderText: "Type a message...",
		selectedImages: [],
		setSelectedImages: vi.fn(),
		onHeightChange: vi.fn(),
		mode: defaultModeSlug,
		setMode: vi.fn(),
		modeShortcutText: "Shift + Tab",
	}

	beforeEach(() => {
		vi.clearAllMocks()
		// Default mock implementation for useExtensionState
		;(useExtensionState as import("vitest").Mock).mockReturnValue({
			filePaths: [],
			openedTabs: [],
			apiConfiguration: {
				apiProvider: "anthropic",
			},
			taskHistory: [],
			cwd: "/test/workspace",
		})
	})

	it.each(Array.from({ length: 12 }, (_, index) => `F${index + 13}`))(
		"leaves %s available to VS Code keybindings without submitting the draft",
		(key) => {
			render(<ChatTextArea {...defaultProps} inputValue="Unsent draft" />)
			const textarea = screen.getByRole("textbox")
			const received = vi.fn()
			window.addEventListener("keydown", received)
			try {
				for (const modifiers of [{}, { ctrlKey: true }, { shiftKey: true }, { altKey: true }]) {
					const event = new KeyboardEvent("keydown", {
						key,
						code: key,
						bubbles: true,
						cancelable: true,
						...modifiers,
					})
					fireEvent(textarea, event)
					expect(event.defaultPrevented).toBe(false)
					expect(received).toHaveBeenLastCalledWith(event)
				}
				expect(defaultProps.onSend).not.toHaveBeenCalled()
				expect(defaultProps.setInputValue).not.toHaveBeenCalled()
				expect(textarea).toHaveValue("Unsent draft")
			} finally {
				window.removeEventListener("keydown", received)
			}
		},
	)

	describe("composer scrolling", () => {
		it.each(["default", "newTask"] as const)("keeps the %s text viewport square", (appearance) => {
			render(<ChatTextArea {...defaultProps} appearance={appearance} />)
			const textarea = screen.getByRole("textbox")
			const highlights = screen.getByTestId("highlight-layer")
			for (const viewport of [textarea, highlights, textarea.parentElement!]) {
				expect(viewport).toHaveClass("rounded-none")
				expect(viewport).not.toHaveClass("rounded-xl")
			}
		})

		it("synchronizes scrolling without replacing highlighted text", () => {
			render(<ChatTextArea {...defaultProps} inputValue={"@/file.ts\n".repeat(30)} />)
			const textarea = screen.getByRole("textbox")
			const highlights = screen.getByTestId("highlight-layer")
			const mark = highlights.querySelector("mark")
			expect(mark).not.toBeNull()
			for (const scrollTop of [21, 84, 210, 42, 0]) {
				textarea.scrollTop = scrollTop
				textarea.scrollLeft = 7
				fireEvent.scroll(textarea)
				expect(highlights.scrollTop).toBe(scrollTop)
				expect(highlights.scrollLeft).toBe(7)
				expect(highlights.querySelector("mark")).toBe(mark)
			}
		})
	})

	it.each(["", "NEW_DIRECTION"])("uses the streaming action appropriate to draft %j", (inputValue) => {
		const onStop = vi.fn()
		render(<ChatTextArea {...defaultProps} inputValue={inputValue} isStreaming onStop={onStop} />)
		const button = screen.getByRole("button", {
			name: (_, element) =>
				element.querySelector(inputValue ? ".lucide-send-horizontal" : ".lucide-square") !== null,
		})
		fireEvent.click(button)
		expect(defaultProps.onSend).toHaveBeenCalledTimes(inputValue ? 1 : 0)
		expect(onStop).toHaveBeenCalledTimes(inputValue ? 0 : 1)
	})

	it.each([
		{ draft: "text", inputValue: "Keep this correction", selectedImages: [] },
		{ draft: "images", inputValue: "", selectedImages: ["data:image/png;base64,aGVsbG8="] },
	])("preserves a streaming $draft draft when Stop is clicked", ({ inputValue, selectedImages }) => {
		const onStop = vi.fn()
		render(
			<ChatTextArea
				{...defaultProps}
				inputValue={inputValue}
				selectedImages={selectedImages}
				isStreaming
				onStop={onStop}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: "Stop" }))
		expect(onStop).toHaveBeenCalledTimes(1)
		expect(defaultProps.onSend).not.toHaveBeenCalled()
		expect(defaultProps.setInputValue).not.toHaveBeenCalled()
		expect(defaultProps.setSelectedImages).not.toHaveBeenCalled()
		expect(screen.getByRole("textbox")).toHaveValue(inputValue)
		if (selectedImages.length > 0) expect(screen.getByRole("img")).toHaveAttribute("src", selectedImages[0])
	})

	it.each([false, true])("retains Stop while streaming submission is pending with autoSteer=%s", (autoSteer) => {
		;(useExtensionState as import("vitest").Mock).mockReturnValue({
			filePaths: [],
			openedTabs: [],
			apiConfiguration: { apiProvider: "anthropic" },
			taskHistory: [],
			cwd: "/test/workspace",
			autoSteer,
		})
		const onStop = vi.fn()
		const view = render(
			<ChatTextArea
				{...defaultProps}
				inputValue="NEW_DIRECTION"
				isStreaming
				sendingDisabled
				enqueueDisabled
				onStop={onStop}
			/>,
		)
		const send = screen.getByRole("button", {
			name: (_, element) => element.querySelector(".lucide-send-horizontal") !== null,
		})
		expect(send).toBeDisabled()
		fireEvent.click(send)
		expect(defaultProps.onSend).not.toHaveBeenCalled()
		const draftStop = screen.getByRole("button", { name: "Stop" })
		expect(draftStop).toBeEnabled()
		fireEvent.click(draftStop)
		expect(onStop).toHaveBeenCalledTimes(1)
		expect(screen.getByRole("textbox")).toHaveValue("NEW_DIRECTION")
		view.rerender(<ChatTextArea {...defaultProps} inputValue="" isStreaming enqueueDisabled onStop={onStop} />)
		const stop = screen.getByRole("button", { name: "Stop" })
		expect(stop).toBeEnabled()
		fireEvent.click(stop)
		expect(onStop).toHaveBeenCalledTimes(2)
	})

	it.each([
		{ isStreaming: false, isEditMode: false },
		{ isStreaming: true, isEditMode: true },
	])("does not offer Stop with streaming=$isStreaming and editing=$isEditMode", (state) => {
		render(<ChatTextArea {...defaultProps} {...state} inputValue="Keep this draft" onStop={vi.fn()} />)
		expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument()
	})

	it.each([undefined, false, true])("labels streaming submission with autoSteer=%s", (autoSteer) => {
		;(useExtensionState as import("vitest").Mock).mockReturnValue({
			filePaths: [],
			openedTabs: [],
			apiConfiguration: { apiProvider: "anthropic" },
			taskHistory: [],
			cwd: "/test/workspace",
			autoSteer,
		})
		const onEnqueueMessage = vi.fn()
		render(
			<ChatTextArea
				{...defaultProps}
				inputValue="NEW_DIRECTION"
				isStreaming
				onEnqueueMessage={onEnqueueMessage}
			/>,
		)
		fireEvent.click(
			screen.getByRole("button", { name: autoSteer ? "Press Enter to steer" : "Press Enter to queue" }),
		)
		expect(defaultProps.onSend).toHaveBeenCalledTimes(1)
		if (autoSteer) {
			fireEvent.click(screen.getByRole("button", { name: /Add message to queue/ }))
			expect(onEnqueueMessage).toHaveBeenCalledTimes(1)
		} else {
			expect(screen.queryByRole("button", { name: /Add message to queue/ })).not.toBeInTheDocument()
		}
	})

	describe("new task appearance", () => {
		it("uses the same compact settings as active chats without changing Enter submission", () => {
			const { rerender } = render(<ChatTextArea {...defaultProps} appearance="newTask" />)
			for (const label of ["Mode", "Model", "Effort", "Approvals"]) {
				expect(screen.queryByText(label)).not.toBeInTheDocument()
			}
			for (const testId of [
				"mode-selector-trigger",
				"dropdown-trigger",
				"reasoning-trigger",
				"auto-approve-dropdown-trigger",
			]) {
				expect(screen.getByTestId(testId)).toBeInTheDocument()
			}
			expect(screen.queryByText(/hold shift to drag in files/)).not.toBeInTheDocument()
			rerender(<ChatTextArea {...defaultProps} appearance="newTask" inputValue="Inspect this project" />)
			fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
			expect(defaultProps.onSend).toHaveBeenCalledTimes(1)
		})

		it.each([false, true])("keeps edit cancellation separate from composer utilities (edit=%s)", (isEditMode) => {
			render(
				<ChatTextArea
					{...defaultProps}
					isEditMode={isEditMode}
					appearance={isEditMode ? "newTask" : "default"}
				/>,
			)
			expect(screen.queryByText("Effort")).not.toBeInTheDocument()
			expect(screen.queryByText(/hold shift to drag in files/)).not.toBeInTheDocument()
			if (isEditMode) {
				expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
				expect(screen.queryByRole("button", { name: "Draft actions" })).not.toBeInTheDocument()
			} else {
				expect(screen.getByRole("button", { name: "Draft actions" })).toBeInTheDocument()
			}
		})

		it("puts context inside the composer and indexing below it while preserving pasted attachments", () => {
			const { container } = render(
				<ChatTextArea
					{...defaultProps}
					contextControl={<button>Context usage</button>}
					selectedImages={["data:image/png;base64,image"]}
				/>,
			)
			const composer = container.querySelector(".chat-composer")!
			expect(composer).toContainElement(screen.getByRole("button", { name: "Context usage" }))
			expect(composer).toContainElement(screen.getByAltText("Attachment 1"))
			expect(screen.queryByRole("button", { name: "Add images to message" })).not.toBeInTheDocument()
			const indexing = screen.getByRole("button", { name: "Index ready" })
			expect(container.querySelector(".chat-composer-utility")).toContainElement(indexing)
			expect(composer).not.toContainElement(indexing)
		})
	})

	describe("draft actions lifecycle", () => {
		it("closes the portal menu when hidden without remounting the textarea or losing the draft", () => {
			const portal = document.createElement("div")
			portal.id = "alpha-portal"
			document.body.append(portal)
			try {
				const view = render(<ChatTextArea {...defaultProps} inputValue="Keep this draft" />)
				const textarea = screen.getByRole("textbox")
				expect(portal).toContainElement(getEnhancePromptButton())
				view.rerender(<ChatTextArea {...defaultProps} inputValue="Keep this draft" isVisible={false} />)
				expect(screen.queryByRole("menuitem", { name: "Improve prompt" })).not.toBeInTheDocument()
				expect(screen.queryByRole("button", { name: "Draft actions" })).not.toBeInTheDocument()
				expect(screen.getByRole("textbox")).toBe(textarea)
				expect(textarea).toHaveValue("Keep this draft")
				view.rerender(<ChatTextArea {...defaultProps} inputValue="Keep this draft" />)
				expect(screen.getByRole("textbox")).toBe(textarea)
				expect(screen.getByRole("button", { name: "Draft actions" })).toHaveAttribute("aria-expanded", "false")
			} finally {
				portal.remove()
			}
		})

		it.each([false, true])("closes when the effective conversation changes (explicit=%s)", (explicit) => {
			const shellState = {
				filePaths: [],
				openedTabs: [],
				taskHistory: [],
				cwd: "/test/workspace",
				currentTaskId: "task-a",
			}
			mockUseExtensionState.mockReturnValue(shellState)
			const view = render(
				<ChatTextArea
					{...defaultProps}
					inputValue="Draft A"
					conversationClineMessages={explicit ? [] : undefined}
					conversationTaskId={explicit ? "task-a" : undefined}
				/>,
			)
			getEnhancePromptButton()
			mockUseExtensionState.mockReturnValue({ ...shellState, currentTaskId: "task-b" })
			view.rerender(
				<ChatTextArea
					{...defaultProps}
					inputValue="Draft B"
					conversationClineMessages={explicit ? [] : undefined}
					conversationTaskId={explicit ? "task-b" : undefined}
				/>,
			)
			expect(screen.queryByRole("menuitem", { name: "Improve prompt" })).not.toBeInTheDocument()
			expect(screen.getByRole("button", { name: "Draft actions" })).toHaveAttribute("aria-expanded", "false")
			expect(screen.getByRole("textbox")).toHaveValue("Draft B")
		})

		it("keeps the pending enhancement listener mounted while hidden", () => {
			const view = render(<ChatTextArea {...defaultProps} inputValue="Original prompt" />)
			fireEvent.click(getEnhancePromptButton())
			view.rerender(<ChatTextArea {...defaultProps} inputValue="Original prompt" isVisible={false} />)
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: "enhancedPrompt",
							requestId: getEnhancementRequest().requestId,
							text: "Improved prompt",
						},
					}),
				)
			})
			expect(defaultProps.setInputValue).toHaveBeenCalledWith("Improved prompt")
		})
	})

	describe("mode selection surface", () => {
		it.each(["@tickets:PM", "@ticket:PM-", "@PM-0", "@PM"])(
			"searches a typed ticket reference: %s",
			async (text) => {
				function Composer() {
					const [inputValue, setInputValue] = useState("")
					return <ChatTextArea {...defaultProps} inputValue={inputValue} setInputValue={setInputValue} />
				}
				const { container } = render(<Composer />)
				const textarea = container.querySelector("textarea")!
				fireEvent.change(textarea, { target: { value: text, selectionStart: text.length } })
				const query = text.replace(/^@(?:tickets?:)?/, "")
				await waitFor(() =>
					expect(mockPostMessage).toHaveBeenCalledWith(
						expect.objectContaining({ type: "searchTickets", query }),
					),
				)
				const request = mockPostMessage.mock.calls.find(([message]) => message.type === "searchTickets")![0]
				act(() =>
					window.dispatchEvent(
						new MessageEvent("message", {
							data: {
								type: "ticketSearchResults",
								ticketSearch: {
									type: "ticketSearchResults",
									requestId: request.requestId,
									tickets: [
										{
											id: "a97392fe-59bf-4f80-8a10-51b2cb62a38f",
											reference: "PM-01",
											name: "Backend cleanup",
											status: "backlog",
											updatedAt: "2026-09-07T00:00:00.000Z",
										},
									],
								},
							},
						}),
					),
				)
				expect(screen.getByRole("option", { name: /PM-01 · Backend cleanup/ })).toBeInTheDocument()
				fireEvent.keyDown(textarea, { key: "Tab" })
				expect(textarea).toHaveValue("@ticket:PM-01 ")
				expect(defaultProps.onSend).not.toHaveBeenCalled()
			},
		)
		it("leaves ticket search when the input switches to slash commands", () => {
			const { container } = render(<ChatTextArea {...defaultProps} />)
			const textarea = container.querySelector("textarea")!
			fireEvent.change(textarea, { target: { value: "@ticket:", selectionStart: 8 } })
			fireEvent.change(textarea, { target: { value: "/", selectionStart: 1 } })
			expect(screen.getByText("/plan")).toBeInTheDocument()
			expect(screen.getByText("/code")).toBeInTheDocument()
		})
		it("searches Alpha Tickets by title, ignores stale replies, and inserts the selected reference", async () => {
			function Composer() {
				const [inputValue, setInputValue] = useState("")
				return <ChatTextArea {...defaultProps} inputValue={inputValue} setInputValue={setInputValue} />
			}
			const { container } = render(<Composer />)
			const textarea = container.querySelector("textarea")!
			fireEvent.change(textarea, { target: { value: "Work on @", selectionStart: 9 } })
			fireEvent.click(screen.getByRole("option", { name: "Alpha Tickets" }))
			expect(textarea).toHaveValue("Work on @ticket:")
			await waitFor(() =>
				expect(mockPostMessage).toHaveBeenCalledWith(
					expect.objectContaining({ type: "searchTickets", query: "" }),
				),
			)
			const first = mockPostMessage.mock.calls.find(([message]) => message.type === "searchTickets")![0]
			const text = "Work on @ticket:backend cleanup"
			fireEvent.change(textarea, { target: { value: text, selectionStart: text.length } })
			await waitFor(() =>
				expect(mockPostMessage).toHaveBeenCalledWith(
					expect.objectContaining({ type: "searchTickets", query: "backend cleanup" }),
				),
			)
			const current = mockPostMessage.mock.calls
				.filter(([message]) => message.type === "searchTickets")
				.at(-1)![0]
			const result = {
				id: "a97392fe-59bf-4f80-8a10-51b2cb62a38f",
				reference: "PM-01",
				name: "Backend cleanup",
				status: "in-progress",
				updatedAt: "2026-09-07T00:00:00.000Z",
			}
			const reply = (requestId: string, name: string) =>
				act(() =>
					window.dispatchEvent(
						new MessageEvent("message", {
							data: {
								type: "ticketSearchResults",
								ticketSearch: {
									type: "ticketSearchResults",
									requestId,
									tickets: [{ ...result, name }],
								},
							},
						}),
					),
				)
			reply(first.requestId, "Stale ticket")
			expect(screen.queryByText(/Stale ticket/)).not.toBeInTheDocument()
			reply(current.requestId, "Backend cleanup")
			expect(screen.getByRole("option", { name: /PM-01 · Backend cleanup/ })).toBeInTheDocument()
			fireEvent.keyDown(textarea, { key: "Enter" })
			expect(textarea).toHaveValue("Work on @ticket:PM-01 ")
			expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
			expect(defaultProps.onSend).not.toHaveBeenCalled()
		})
		it("offers only Plan and Code built-ins through slash-mode suggestions", () => {
			const { container } = render(<ChatTextArea {...defaultProps} />)
			const textarea = container.querySelector("textarea")!
			expect(textarea).toHaveAttribute("aria-keyshortcuts", "Shift+Tab")

			fireEvent.change(textarea, { target: { value: "/", selectionStart: 1 } })

			expect(screen.getByText("/plan")).toBeInTheDocument()
			expect(screen.getByText("/code")).toBeInTheDocument()
			expect(screen.queryByText("/ask")).not.toBeInTheDocument()
			expect(screen.queryByText("/debug")).not.toBeInTheDocument()
			expect(screen.queryByText("/orchestrator")).not.toBeInTheDocument()
			expect(screen.getByRole("listbox", { name: /add context/i })).toBeInTheDocument()
			expect(textarea).toHaveAttribute("aria-expanded", "true")
			expect(textarea).toHaveAttribute("aria-controls", screen.getByRole("listbox").id)
		})

		it("dismisses the root suggestions with Escape", () => {
			const { container } = render(<ChatTextArea {...defaultProps} />)
			const textarea = container.querySelector("textarea")!
			fireEvent.change(textarea, { target: { value: "/", selectionStart: 1 } })

			fireEvent.keyDown(textarea, { key: "Escape" })

			expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
			expect(textarea).toHaveAttribute("aria-expanded", "false")
		})

		it("does not latch mouse interaction state after the menu pointer is released", () => {
			const { container } = render(<ChatTextArea {...defaultProps} />)
			const textarea = container.querySelector("textarea")!
			fireEvent.change(textarea, { target: { value: "/", selectionStart: 1 } })
			const menu = screen.getByRole("listbox")

			fireEvent.mouseDown(menu)
			fireEvent.mouseUp(menu)
			fireEvent.blur(textarea)

			expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
		})

		it.each([
			["code", "architect"],
			["architect", "code"],
			["debug", "code"],
		] as const)("toggles %s to %s with Shift+Tab in the composer", (currentMode, expectedMode) => {
			const setMode = vi.fn()
			const { container } = render(<ChatTextArea {...defaultProps} mode={currentMode} setMode={setMode} />)
			const textarea = container.querySelector("textarea")!
			const event = new KeyboardEvent("keydown", {
				key: "Tab",
				shiftKey: true,
				bubbles: true,
				cancelable: true,
			})

			fireEvent(textarea, event)

			expect(event.defaultPrevented).toBe(true)
			expect(setMode).toHaveBeenCalledWith(expectedMode)
			expect(mockPostMessage).toHaveBeenCalledWith({ type: "mode", text: expectedMode })
		})

		it("leaves ordinary Tab behavior untouched", () => {
			const setMode = vi.fn()
			const { container } = render(<ChatTextArea {...defaultProps} setMode={setMode} />)
			const textarea = container.querySelector("textarea")!
			const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })

			fireEvent(textarea, event)

			expect(event.defaultPrevented).toBe(false)
			expect(setMode).not.toHaveBeenCalled()
			expect(mockPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "mode" }))
		})

		it.each([{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { repeat: true }])(
			"does not intercept modified or repeated Shift+Tab: %o",
			(eventOptions) => {
				const setMode = vi.fn()
				const { container } = render(<ChatTextArea {...defaultProps} setMode={setMode} />)
				const textarea = container.querySelector("textarea")!

				fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true, ...eventOptions })

				expect(setMode).not.toHaveBeenCalled()
			},
		)

		it("does not switch modes while an IME composition is active", () => {
			const setMode = vi.fn()
			const { container } = render(<ChatTextArea {...defaultProps} setMode={setMode} />)
			const textarea = container.querySelector("textarea")!
			const event = new KeyboardEvent("keydown", {
				key: "Tab",
				shiftKey: true,
				bubbles: true,
				cancelable: true,
			})
			Object.defineProperty(event, "isComposing", { value: true })

			fireEvent(textarea, event)

			expect(event.defaultPrevented).toBe(false)
			expect(setMode).not.toHaveBeenCalled()
		})

		it("respects a Shift+Tab event already owned by another handler", () => {
			const setMode = vi.fn()
			const { container } = render(<ChatTextArea {...defaultProps} setMode={setMode} />)
			const textarea = container.querySelector("textarea")!
			const event = new KeyboardEvent("keydown", {
				key: "Tab",
				shiftKey: true,
				bubbles: true,
				cancelable: true,
			})
			event.preventDefault()

			fireEvent(textarea, event)

			expect(setMode).not.toHaveBeenCalled()
		})

		it("does not switch modes while streaming", () => {
			const setMode = vi.fn()
			const { container } = render(<ChatTextArea {...defaultProps} setMode={setMode} isStreaming={true} />)
			const textarea = container.querySelector("textarea")!
			expect(screen.getByTestId("mode-selector-trigger")).toBeDisabled()
			expect(textarea).not.toHaveAttribute("aria-keyshortcuts")

			fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true })
			fireEvent.change(textarea, { target: { value: "/", selectionStart: 1 } })

			expect(setMode).not.toHaveBeenCalled()
			expect(screen.queryByText("/plan")).not.toBeInTheDocument()
			expect(screen.queryByText("/code")).not.toBeInTheDocument()
		})

		it("does not switch modes while editing a queued message", () => {
			const setMode = vi.fn()
			const { container } = render(<ChatTextArea {...defaultProps} setMode={setMode} isEditMode={true} />)
			const textarea = container.querySelector("textarea")!

			expect(screen.getByTestId("mode-selector-trigger")).toBeDisabled()
			expect(textarea).not.toHaveAttribute("aria-keyshortcuts")
			fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true })

			expect(setMode).not.toHaveBeenCalled()
			expect(mockPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "mode" }))
		})

		it("leaves Shift+Tab to context-menu navigation while suggestions are open", () => {
			const setMode = vi.fn()
			const { container } = render(<ChatTextArea {...defaultProps} setMode={setMode} />)
			const textarea = container.querySelector("textarea")!
			fireEvent.change(textarea, { target: { value: "/", selectionStart: 1 } })
			expect(screen.getByText("Modes")).toBeInTheDocument()

			const event = new KeyboardEvent("keydown", {
				key: "Tab",
				shiftKey: true,
				bubbles: true,
				cancelable: true,
			})
			fireEvent(textarea, event)

			expect(event.defaultPrevented).toBe(false)
			expect(setMode).not.toHaveBeenCalled()
		})
	})

	describe("enhance prompt button", () => {
		it("should be enabled even when sendingDisabled is true (for message queueing)", () => {
			;(useExtensionState as import("vitest").Mock).mockReturnValue({
				filePaths: [],
				openedTabs: [],
				taskHistory: [],
				cwd: "/test/workspace",
			})
			render(<ChatTextArea {...defaultProps} sendingDisabled={true} />)
			const enhanceButton = getEnhancePromptButton()
			expect(enhanceButton).not.toHaveAttribute("data-disabled")
		})
	})

	describe("handleEnhancePrompt", () => {
		it("should send message with correct configuration when clicked", () => {
			const apiConfiguration = {
				apiProvider: "openrouter",
				apiKey: "test-key",
			}

			;(useExtensionState as import("vitest").Mock).mockReturnValue({
				filePaths: [],
				openedTabs: [],
				apiConfiguration,
				taskHistory: [],
				cwd: "/test/workspace",
			})

			render(<ChatTextArea {...defaultProps} inputValue="Test prompt" />)

			const enhanceButton = getEnhancePromptButton()
			fireEvent.click(enhanceButton)

			expect(mockPostMessage).toHaveBeenCalledWith({
				type: "enhancePrompt",
				requestId: expect.any(String),
				text: "Test prompt",
			})
		})

		it("should not send message when input is empty", () => {
			;(useExtensionState as import("vitest").Mock).mockReturnValue({
				filePaths: [],
				openedTabs: [],
				apiConfiguration: {
					apiProvider: "openrouter",
				},
				taskHistory: [],
				cwd: "/test/workspace",
			})

			render(<ChatTextArea {...defaultProps} inputValue="" />)

			// Clear any calls from component initialization (e.g., IndexingStatusBadge)
			mockPostMessage.mockClear()

			const enhanceButton = getEnhancePromptButton()
			fireEvent.click(enhanceButton)

			expect(mockPostMessage).not.toHaveBeenCalled()
		})

		it("should show loading state while enhancing", () => {
			;(useExtensionState as import("vitest").Mock).mockReturnValue({
				filePaths: [],
				openedTabs: [],
				apiConfiguration: {
					apiProvider: "openrouter",
				},
				taskHistory: [],
				cwd: "/test/workspace",
			})

			render(<ChatTextArea {...defaultProps} inputValue="Test prompt" />)

			const enhanceButton = getEnhancePromptButton()
			fireEvent.click(enhanceButton)

			// Check if the WandSparkles icon has the animate-spin class
			const animatingIcon = screen.getByRole("button", { name: "Draft actions" }).querySelector(".animate-spin")
			expect(animatingIcon).toBeInTheDocument()
		})
	})

	describe("effect dependencies", () => {
		it("should update when apiConfiguration changes", () => {
			const { rerender } = render(<ChatTextArea {...defaultProps} />)

			// Update apiConfiguration
			;(useExtensionState as import("vitest").Mock).mockReturnValue({
				filePaths: [],
				openedTabs: [],
				apiConfiguration: {
					apiProvider: "openrouter",
					newSetting: "test",
				},
				taskHistory: [],
				cwd: "/test/workspace",
			})

			rerender(<ChatTextArea {...defaultProps} />)

			// Verify the enhance button appears after apiConfiguration changes
			expect(getEnhancePromptButton()).toBeInTheDocument()
		})
	})

	describe("reasoning control integration", () => {
		it("preserves a draft, mentions, image attachments, and keyboard send behavior", () => {
			const onSend = vi.fn()
			const draft = "Review @/src/feature.ts before sending"
			const selectedImages = ["data:image/png;base64,test-image"]
			;(useExtensionState as import("vitest").Mock).mockReturnValue({
				filePaths: [],
				openedTabs: [],
				apiConfiguration: { apiProvider: "openai", apiModelId: "gpt-5" },
				currentApiConfigName: "default",
				currentTaskId: "task-1",
				taskReasoning: {
					taskId: "task-1",
					requested: { kind: "effort", effort: "medium" },
					effective: { kind: "effort", effort: "medium" },
					capabilities: { kind: "effort", efforts: ["low", "medium", "high"], canDisable: true },
				},
				taskHistory: [],
				clineMessages: [],
				cwd: "/test/workspace",
			})

			const { container } = render(
				<ChatTextArea {...defaultProps} inputValue={draft} selectedImages={selectedImages} onSend={onSend} />,
			)

			const textarea = container.querySelector("textarea")!
			expect(textarea).toHaveValue(draft)
			expect(screen.getByAltText("Attachment 1")).toHaveAttribute("src", selectedImages[0])
			expect(screen.getByTestId("reasoning-trigger")).toBeInTheDocument()

			const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
			fireEvent(textarea, enter)

			expect(enter.defaultPrevented).toBe(true)
			expect(onSend).toHaveBeenCalledTimes(1)
			expect(textarea).toHaveValue(draft)
			expect(screen.getByAltText("Attachment 1")).toBeInTheDocument()
		})
	})

	describe("enhanced prompt response", () => {
		it("cancels prompt improvement without changing or submitting the draft and ignores its late result", () => {
			const setInputValue = vi.fn()
			render(
				<ChatTextArea
					{...defaultProps}
					conversationClineMessages={[]}
					conversationTaskId="task-a"
					inputValue="Keep my draft"
					setInputValue={setInputValue}
				/>,
			)
			fireEvent.click(getEnhancePromptButton())
			const request = getEnhancementRequest()
			fireEvent.click(getCancelEnhancementButton())
			expect(mockPostMessage).toHaveBeenCalledWith({
				type: "cancelEnhancePrompt",
				requestId: request.requestId,
				taskId: "task-a",
			})
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: { type: "enhancedPrompt", requestId: request.requestId, text: "Too late" },
					}),
				)
			})
			expect(setInputValue).not.toHaveBeenCalled()
			expect(defaultProps.onSend).not.toHaveBeenCalled()
			expect(screen.getByRole("textbox")).toHaveValue("Keep my draft")
			expect(screen.getByRole("button", { name: "Draft actions" })).toHaveAttribute("aria-busy", "false")
		})

		it("cancels an enhancement immediately on a native edit before the controlled draft rerenders", () => {
			const setInputValue = vi.fn()
			Object.defineProperty(document, "execCommand", { value: undefined, writable: true })
			render(<ChatTextArea {...defaultProps} inputValue="Original draft" setInputValue={setInputValue} />)
			fireEvent.click(getEnhancePromptButton())
			const request = getEnhancementRequest()
			fireEvent.change(screen.getByRole("textbox"), { target: { value: "Newer draft" } })
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: { type: "enhancedPrompt", requestId: request.requestId, text: "Stale enhancement" },
					}),
				)
			})
			expect(mockPostMessage).toHaveBeenCalledWith({ type: "cancelEnhancePrompt", requestId: request.requestId })
			expect(setInputValue).toHaveBeenCalledWith("Newer draft")
			expect(setInputValue).not.toHaveBeenCalledWith("Stale enhancement")
		})

		it("cancels once on Escape and preserves input without submitting", () => {
			render(<ChatTextArea {...defaultProps} inputValue="Keep my draft" />)
			fireEvent.click(getEnhancePromptButton())
			const request = getEnhancementRequest()
			const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
			fireEvent(screen.getByRole("textbox"), escape)
			fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" })
			expect(escape.defaultPrevented).toBe(true)
			expect(mockPostMessage.mock.calls.filter(([message]) => message.type === "cancelEnhancePrompt")).toEqual([
				[{ type: "cancelEnhancePrompt", requestId: request.requestId }],
			])
			expect(defaultProps.setInputValue).not.toHaveBeenCalled()
			expect(defaultProps.onSend).not.toHaveBeenCalled()
			expect(screen.getByRole("button", { name: "Draft actions" })).toHaveAttribute("aria-busy", "false")
		})

		it("keeps a retry pending when a prior cancellation or result arrives late", () => {
			Object.defineProperty(document, "execCommand", { value: undefined, writable: true })
			render(<ChatTextArea {...defaultProps} inputValue="Keep my draft" />)
			fireEvent.click(getEnhancePromptButton())
			const original = getEnhancementRequest()
			fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" })
			fireEvent.click(getEnhancePromptButton())
			const retry = getEnhancementRequest()
			expect(retry.requestId).not.toBe(original.requestId)
			act(() => {
				for (const response of [{ enhancementStatus: "cancelled" }, { text: "Late original" }]) {
					window.dispatchEvent(
						new MessageEvent("message", {
							data: { type: "enhancedPrompt", requestId: original.requestId, ...response },
						}),
					)
				}
			})
			expect(defaultProps.setInputValue).not.toHaveBeenCalled()
			expect(screen.getByRole("button", { name: "Draft actions" })).toHaveAttribute("aria-busy", "true")
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: "enhancedPrompt",
							requestId: retry.requestId,
							enhancementStatus: "success",
							text: "Improved retry",
						},
					}),
				)
			})
			expect(defaultProps.setInputValue).toHaveBeenCalledWith("Improved retry")
			expect(screen.getByRole("button", { name: "Draft actions" })).toHaveAttribute("aria-busy", "false")
		})

		it("cancels the originating request when the composer unmounts", () => {
			const view = render(<ChatTextArea {...defaultProps} inputValue="Keep my draft" />)
			fireEvent.click(getEnhancePromptButton())
			const request = getEnhancementRequest()
			view.unmount()
			expect(mockPostMessage).toHaveBeenCalledWith({ type: "cancelEnhancePrompt", requestId: request.requestId })
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "enhancedPrompt", requestId: request.requestId, text: "Too late" },
				}),
			)
			expect(defaultProps.setInputValue).not.toHaveBeenCalled()
		})

		it.each(["error", "cancelled"])("does not insert %s result text into the draft", (enhancementStatus) => {
			Object.defineProperty(document, "execCommand", { value: undefined, writable: true })
			render(<ChatTextArea {...defaultProps} inputValue="Keep my draft" />)
			fireEvent.click(getEnhancePromptButton())
			const request = getEnhancementRequest()
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: "enhancedPrompt",
							requestId: request.requestId,
							enhancementStatus,
							text: "Provider diagnostic text",
						},
					}),
				)
			})
			expect(defaultProps.setInputValue).not.toHaveBeenCalled()
			expect(screen.getByRole("button", { name: "Draft actions" })).toHaveAttribute("aria-busy", "false")
			expect(mockPostMessage.mock.calls.filter(([message]) => message.type === "cancelEnhancePrompt")).toEqual([])
		})

		it.each(["Prompt for A", "Keep B's draft"])(
			"keeps a delayed enhancement from replacing another chat's draft (%s)",
			(otherDraft) => {
				const setInputValue = vi.fn()
				Object.defineProperty(document, "execCommand", { value: undefined, writable: true })
				const view = render(
					<ChatTextArea
						{...defaultProps}
						conversationClineMessages={[]}
						conversationTaskId="task-a"
						inputValue="Prompt for A"
						setInputValue={setInputValue}
					/>,
				)
				fireEvent.click(getEnhancePromptButton())
				const request = getEnhancementRequest()
				expect(request.taskId).toBe("task-a")
				view.rerender(
					<ChatTextArea
						{...defaultProps}
						conversationClineMessages={[]}
						conversationTaskId="task-b"
						inputValue={otherDraft}
						setInputValue={setInputValue}
					/>,
				)
				act(() => {
					window.dispatchEvent(
						new MessageEvent("message", {
							data: { type: "enhancedPrompt", requestId: request.requestId, text: "Enhanced A" },
						}),
					)
				})
				expect(setInputValue).not.toHaveBeenCalledWith("Enhanced A")
				expect(screen.getByRole("textbox")).toHaveValue(otherDraft)
				expect(mockPostMessage).toHaveBeenCalledWith({
					type: "cancelEnhancePrompt",
					requestId: request.requestId,
					taskId: "task-a",
				})
			},
		)

		it("keeps a delayed enhancement from replacing a newer edit to the same draft", () => {
			const setInputValue = vi.fn()
			Object.defineProperty(document, "execCommand", { value: undefined, writable: true })
			const view = render(
				<ChatTextArea {...defaultProps} inputValue="Original draft" setInputValue={setInputValue} />,
			)
			fireEvent.click(getEnhancePromptButton())
			const request = getEnhancementRequest()
			view.rerender(<ChatTextArea {...defaultProps} inputValue="New draft" setInputValue={setInputValue} />)
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: { type: "enhancedPrompt", requestId: request.requestId, text: "Enhanced original" },
					}),
				)
			})
			expect(setInputValue).not.toHaveBeenCalledWith("Enhanced original")
		})

		it("ignores out-of-order and ID-less replies while a newer enhancement remains pending", () => {
			const setInputValue = vi.fn()
			Object.defineProperty(document, "execCommand", { value: undefined, writable: true })
			const view = render(
				<ChatTextArea {...defaultProps} inputValue="Original draft" setInputValue={setInputValue} />,
			)
			fireEvent.click(getEnhancePromptButton())
			const originalRequest = getEnhancementRequest()
			view.rerender(<ChatTextArea {...defaultProps} inputValue="Updated draft" setInputValue={setInputValue} />)
			fireEvent.click(getEnhancePromptButton())
			const latestRequest = getEnhancementRequest()
			expect(latestRequest.requestId).not.toBe(originalRequest.requestId)
			expect(mockPostMessage).toHaveBeenCalledWith({
				type: "cancelEnhancePrompt",
				requestId: originalRequest.requestId,
			})
			act(() => {
				for (const requestId of [originalRequest.requestId, undefined]) {
					window.dispatchEvent(
						new MessageEvent("message", {
							data: { type: "enhancedPrompt", requestId, text: "Stale response" },
						}),
					)
				}
			})
			expect(setInputValue).not.toHaveBeenCalledWith("Stale response")
			expect(
				screen.getByRole("button", { name: "Draft actions" }).querySelector(".animate-spin"),
			).toBeInTheDocument()
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: { type: "enhancedPrompt", requestId: latestRequest.requestId, text: "Enhanced latest" },
					}),
				)
			})
			expect(setInputValue).toHaveBeenCalledWith("Enhanced latest")
			expect(screen.getByRole("button", { name: "Draft actions" }).querySelector(".animate-spin")).toBeNull()
		})

		it("preserves the draft and permits retry after its own enhancement fails", () => {
			render(<ChatTextArea {...defaultProps} inputValue="Keep my draft" />)
			fireEvent.click(getEnhancePromptButton())
			const request = getEnhancementRequest()
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", { data: { type: "enhancedPrompt", requestId: request.requestId } }),
				)
			})
			expect(screen.getByRole("textbox")).toHaveValue("Keep my draft")
			expect(screen.getByRole("button", { name: "Draft actions" }).querySelector(".animate-spin")).toBeNull()
			fireEvent.click(getEnhancePromptButton())
			expect(getEnhancementRequest().requestId).not.toBe(request.requestId)
		})

		it("should update input value using native browser methods when receiving enhanced prompt", () => {
			const setInputValue = vi.fn()

			// Mock document.execCommand
			const mockExecCommand = vi.fn().mockReturnValue(true)
			Object.defineProperty(document, "execCommand", {
				value: mockExecCommand,
				writable: true,
			})

			const { container } = render(
				<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="Original prompt" />,
			)

			const textarea = container.querySelector("textarea")!

			// Mock textarea methods
			const mockSelect = vi.fn()
			const mockFocus = vi.fn()
			textarea.select = mockSelect
			textarea.focus = mockFocus
			fireEvent.click(getEnhancePromptButton())

			// Simulate receiving enhanced prompt message
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "enhancedPrompt",
						requestId: getEnhancementRequest().requestId,
						text: "Enhanced test prompt",
					},
				}),
			)

			// Verify native browser methods were used
			expect(mockFocus).toHaveBeenCalled()
			expect(mockSelect).toHaveBeenCalled()
			expect(mockExecCommand).toHaveBeenCalledWith("insertText", false, "Enhanced test prompt")
		})

		it("should fallback to setInputValue when execCommand is not available", () => {
			const setInputValue = vi.fn()

			// Mock document.execCommand to be undefined (not available)
			Object.defineProperty(document, "execCommand", {
				value: undefined,
				writable: true,
			})

			render(<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="Original prompt" />)
			fireEvent.click(getEnhancePromptButton())

			// Simulate receiving enhanced prompt message
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "enhancedPrompt",
						requestId: getEnhancementRequest().requestId,
						text: "Enhanced test prompt",
					},
				}),
			)

			// Verify fallback to setInputValue was used
			expect(setInputValue).toHaveBeenCalledWith("Enhanced test prompt")
		})

		it("falls back to the controlled draft when native insertion declines the command", () => {
			const setInputValue = vi.fn()
			Object.defineProperty(document, "execCommand", { value: vi.fn().mockReturnValue(false), writable: true })
			render(<ChatTextArea {...defaultProps} inputValue="Original prompt" setInputValue={setInputValue} />)
			fireEvent.click(getEnhancePromptButton())
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: "enhancedPrompt",
							requestId: getEnhancementRequest().requestId,
							text: "Enhanced test prompt",
						},
					}),
				)
			})
			expect(setInputValue).toHaveBeenCalledWith("Enhanced test prompt")
		})

		it("ignores unsolicited enhanced prompt responses", () => {
			const setInputValue = vi.fn()

			render(<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="Original prompt" />)

			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "enhancedPrompt", text: "Foreign enhanced prompt" },
				}),
			)

			expect(setInputValue).not.toHaveBeenCalledWith("Foreign enhanced prompt")
		})

		it("does not submit a second enhancement while one is pending", () => {
			render(<ChatTextArea {...defaultProps} inputValue="Original prompt" />)
			const enhanceButton = getEnhancePromptButton()

			fireEvent.click(enhanceButton)
			fireEvent.click(enhanceButton)

			expect(mockPostMessage.mock.calls.filter(([message]) => message.type === "enhancePrompt")).toHaveLength(1)
			expect(getCancelEnhancementButton()).not.toHaveAttribute("data-disabled")
		})
	})

	describe("file search debounce", () => {
		it("cancels a pending search when the mention is cleared", () => {
			vi.useFakeTimers()
			try {
				const { container, rerender } = render(<ChatTextArea {...defaultProps} inputValue="" />)
				const textarea = container.querySelector("textarea")!

				fireEvent.change(textarea, { target: { value: "@query", selectionStart: 6 } })
				rerender(<ChatTextArea {...defaultProps} inputValue="@query" />)
				fireEvent.change(textarea, { target: { value: "", selectionStart: 0 } })
				vi.advanceTimersByTime(250)

				expect(mockPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "searchFiles" }))
			} finally {
				vi.useRealTimers()
			}
		})
	})

	describe("clipboard paste", () => {
		const mockCwd = "/Users/test/project"

		beforeEach(() => {
			;(useExtensionState as import("vitest").Mock).mockReturnValue({
				filePaths: [],
				openedTabs: [],
				apiConfiguration: {
					apiProvider: "anthropic",
				},
				taskHistory: [],
				cwd: mockCwd,
			})
		})

		it("inserts pasted URLs at the textarea selection instead of a stale cursor position", () => {
			const setInputValue = vi.fn()
			const { container } = render(
				<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="before selected after" />,
			)

			const textarea = container.querySelector("textarea")!
			textarea.setSelectionRange("before ".length, "before selected".length)

			fireEvent.paste(textarea, {
				clipboardData: {
					items: [],
					getData: vi.fn(() => "https://example.com"),
				},
			})

			expect(setInputValue).toHaveBeenCalledWith("before https://example.com after")
		})

		it("converts pasted VS Code URI lists into clean mentions", () => {
			const setInputValue = vi.fn()
			const { container } = render(
				<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="Review " />,
			)

			const textarea = container.querySelector("textarea")!
			textarea.setSelectionRange("Review ".length, "Review ".length)

			const getData = vi.fn((type: string) => {
				if (type === "application/vnd.code.uri-list") {
					return "file:///Users/test/project/src/file1.ts\nfile:///Users/test/project/src/file2.ts"
				}

				return ""
			})

			fireEvent.paste(textarea, {
				clipboardData: {
					items: [],
					getData,
				},
			})

			expect(mockConvertToMentionPath).toHaveBeenCalledWith("file:///Users/test/project/src/file1.ts", mockCwd)
			expect(mockConvertToMentionPath).toHaveBeenCalledWith("file:///Users/test/project/src/file2.ts", mockCwd)
			expect(setInputValue).toHaveBeenCalledWith("Review @/src/file1.ts @/src/file2.ts ")
		})

		it("extracts VS Code resource paths from raw clipboard metadata instead of pasting the metadata blob", () => {
			const setInputValue = vi.fn()
			const { container } = render(<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="" />)

			const textarea = container.querySelector("textarea")!
			const rawMetadata =
				'{"changed":[],"resource":{"$mid":1,"fsPath":"c:\\\\Users\\\\Luke Goblirsch\\\\AppData\\\\Roaming\\\\Code\\\\User\\\\globalStorage","scheme":"file"}}\u0002\u0006'

			fireEvent.paste(textarea, {
				clipboardData: {
					items: [],
					getData: vi.fn((type: string) => (type === "text" ? rawMetadata : "")),
				},
			})

			expect(mockConvertToMentionPath).toHaveBeenCalledWith(
				"c:\\Users\\Luke Goblirsch\\AppData\\Roaming\\Code\\User\\globalStorage",
				mockCwd,
			)
			expect(setInputValue).toHaveBeenCalledWith(
				"c:\\Users\\Luke Goblirsch\\AppData\\Roaming\\Code\\User\\globalStorage ",
			)
		})
	})

	describe("multi-file drag and drop", () => {
		const mockCwd = "/Users/test/project"

		beforeEach(() => {
			vi.clearAllMocks()
			;(useExtensionState as import("vitest").Mock).mockReturnValue({
				filePaths: [],
				openedTabs: [],
				cwd: mockCwd,
			})
			mockConvertToMentionPath.mockClear()
		})

		it("should process multiple file paths separated by newlines", () => {
			const setInputValue = vi.fn()

			const { container } = render(
				<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="Initial text" />,
			)

			// Create a mock dataTransfer object with text data containing multiple file paths
			const dataTransfer = {
				getData: vi.fn().mockReturnValue("/Users/test/project/file1.js\n/Users/test/project/file2.js"),
				files: [],
			}

			// Simulate drop event
			fireEvent.drop(container.querySelector(".chat-text-area")!, {
				dataTransfer,
				preventDefault: vi.fn(),
			})

			// Verify convertToMentionPath was called for each file path
			expect(mockConvertToMentionPath).toHaveBeenCalledTimes(2)
			expect(mockConvertToMentionPath).toHaveBeenCalledWith("/Users/test/project/file1.js", mockCwd)
			expect(mockConvertToMentionPath).toHaveBeenCalledWith("/Users/test/project/file2.js", mockCwd)

			// Verify setInputValue was called with the correct value
			// The mock implementation of convertToMentionPath will convert the paths to @/file1.js and @/file2.js
			expect(setInputValue).toHaveBeenCalledWith("@/file1.js @/file2.js Initial text")
		})

		it("should filter out empty lines in the dragged text", () => {
			const setInputValue = vi.fn()

			const { container } = render(
				<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="Initial text" />,
			)

			// Create a mock dataTransfer object with text data containing empty lines
			const dataTransfer = {
				getData: vi.fn().mockReturnValue("/Users/test/project/file1.js\n\n/Users/test/project/file2.js\n\n"),
				files: [],
			}

			// Simulate drop event
			fireEvent.drop(container.querySelector(".chat-text-area")!, {
				dataTransfer,
				preventDefault: vi.fn(),
			})

			// Verify convertToMentionPath was called only for non-empty lines
			expect(mockConvertToMentionPath).toHaveBeenCalledTimes(2)

			// Verify setInputValue was called with the correct value
			expect(setInputValue).toHaveBeenCalledWith("@/file1.js @/file2.js Initial text")
		})

		it("should correctly update cursor position after adding multiple mentions", () => {
			const setInputValue = vi.fn()
			const initialCursorPosition = 5

			const { container } = render(
				<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="Hello world" />,
			)

			// Set the cursor position manually
			const textArea = container.querySelector("textarea")
			if (textArea) {
				textArea.selectionStart = initialCursorPosition
				textArea.selectionEnd = initialCursorPosition
			}

			// Create a mock dataTransfer object with text data
			const dataTransfer = {
				getData: vi.fn().mockReturnValue("/Users/test/project/file1.js\n/Users/test/project/file2.js"),
				files: [],
			}

			// Simulate drop event
			fireEvent.drop(container.querySelector(".chat-text-area")!, {
				dataTransfer,
				preventDefault: vi.fn(),
			})

			// The cursor position should be updated based on the implementation in the component
			expect(setInputValue).toHaveBeenCalledWith("@/file1.js @/file2.js Hello world")
		})

		it("should handle very long file paths correctly", () => {
			const setInputValue = vi.fn()

			const { container } = render(<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="" />)

			// Create a very long file path
			const longPath =
				"/Users/test/project/very/long/path/with/many/nested/directories/and/a/very/long/filename/with/extension.typescript"

			// Create a mock dataTransfer object with the long path
			const dataTransfer = {
				getData: vi.fn().mockReturnValue(longPath),
				files: [],
			}

			// Simulate drop event
			fireEvent.drop(container.querySelector(".chat-text-area")!, {
				dataTransfer,
				preventDefault: vi.fn(),
			})

			// Verify convertToMentionPath was called with the long path
			expect(mockConvertToMentionPath).toHaveBeenCalledWith(longPath, mockCwd)

			// The mock implementation will convert it to @/very/long/path/...
			expect(setInputValue).toHaveBeenCalledWith(
				"@/very/long/path/with/many/nested/directories/and/a/very/long/filename/with/extension.typescript ",
			)
		})

		it("should handle paths with special characters correctly", () => {
			const setInputValue = vi.fn()

			const { container } = render(<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="" />)

			// Create paths with special characters
			const specialPath1 = "/Users/test/project/file with spaces.js"
			const specialPath2 = "/Users/test/project/file-with-dashes.js"
			const specialPath3 = "/Users/test/project/file_with_underscores.js"
			const specialPath4 = "/Users/test/project/file.with.dots.js"

			// Create a mock dataTransfer object with the special paths
			const dataTransfer = {
				getData: vi.fn().mockReturnValue(`${specialPath1}\n${specialPath2}\n${specialPath3}\n${specialPath4}`),
				files: [],
			}

			// Simulate drop event
			fireEvent.drop(container.querySelector(".chat-text-area")!, {
				dataTransfer,
				preventDefault: vi.fn(),
			})

			// Verify convertToMentionPath was called for each path
			expect(mockConvertToMentionPath).toHaveBeenCalledTimes(4)
			expect(mockConvertToMentionPath).toHaveBeenCalledWith(specialPath1, mockCwd)
			expect(mockConvertToMentionPath).toHaveBeenCalledWith(specialPath2, mockCwd)
			expect(mockConvertToMentionPath).toHaveBeenCalledWith(specialPath3, mockCwd)
			expect(mockConvertToMentionPath).toHaveBeenCalledWith(specialPath4, mockCwd)

			// Verify setInputValue was called with the correct value
			expect(setInputValue).toHaveBeenCalledWith(
				"@/file with spaces.js @/file-with-dashes.js @/file_with_underscores.js @/file.with.dots.js ",
			)
		})

		it("should handle paths outside the current working directory", () => {
			const setInputValue = vi.fn()

			const { container } = render(<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="" />)

			// Create paths outside the current working directory
			const outsidePath = "/Users/other/project/file.js"

			// Mock the convertToMentionPath function to return the original path for paths outside cwd
			mockConvertToMentionPath.mockImplementationOnce((path, _cwd) => {
				return path // Return original path for this test
			})

			// Create a mock dataTransfer object with the outside path
			const dataTransfer = {
				getData: vi.fn().mockReturnValue(outsidePath),
				files: [],
			}

			// Simulate drop event
			fireEvent.drop(container.querySelector(".chat-text-area")!, {
				dataTransfer,
				preventDefault: vi.fn(),
			})

			// Verify convertToMentionPath was called with the outside path
			expect(mockConvertToMentionPath).toHaveBeenCalledWith(outsidePath, mockCwd)

			// Verify setInputValue was called with the original path
			expect(setInputValue).toHaveBeenCalledWith("/Users/other/project/file.js ")
		})

		it("should do nothing when dropped text is empty", () => {
			const setInputValue = vi.fn()

			const { container } = render(
				<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="Initial text" />,
			)

			// Create a mock dataTransfer object with empty text
			const dataTransfer = {
				getData: vi.fn().mockReturnValue(""),
				files: [],
			}

			// Simulate drop event
			fireEvent.drop(container.querySelector(".chat-text-area")!, {
				dataTransfer,
				preventDefault: vi.fn(),
			})

			// Verify convertToMentionPath was not called
			expect(mockConvertToMentionPath).not.toHaveBeenCalled()

			// Verify setInputValue was not called
			expect(setInputValue).not.toHaveBeenCalled()
		})

		describe("prompt history navigation", () => {
			it("resets navigation by displayed chat identity even when shell selection is unchanged", () => {
				const setInputValue = vi.fn()
				const messages = [{ type: "say" as const, say: "user_feedback" as const, text: "same prompt", ts: 1 }]
				const { container, rerender } = render(
					<ChatTextArea
						{...defaultProps}
						conversationClineMessages={messages}
						conversationTaskId="task-a"
						isInTask
						setInputValue={setInputValue}
						inputValue="draft A"
					/>,
				)
				const textarea = container.querySelector("textarea")!
				textarea.setSelectionRange(0, 0)
				fireEvent.keyDown(textarea, { key: "ArrowUp" })
				expect(setInputValue).toHaveBeenCalledWith("same prompt")
				setInputValue.mockClear()
				rerender(
					<ChatTextArea
						{...defaultProps}
						conversationClineMessages={messages}
						conversationTaskId="task-b"
						isInTask
						setInputValue={setInputValue}
						inputValue="draft B"
					/>,
				)
				textarea.setSelectionRange(0, 0)
				fireEvent.keyDown(textarea, { key: "ArrowDown" })
				expect(setInputValue).not.toHaveBeenCalled()
			})

			const mockAlphaMessages = [
				{ type: "say", say: "user_feedback", text: "First prompt", ts: 1000 },
				{ type: "say", say: "user_feedback", text: "Second prompt", ts: 2000 },
				{ type: "say", say: "user_feedback", text: "Third prompt", ts: 3000 },
			]

			beforeEach(() => {
				;(useExtensionState as import("vitest").Mock).mockReturnValue({
					filePaths: [],
					openedTabs: [],
					apiConfiguration: {
						apiProvider: "anthropic",
					},
					taskHistory: [],
					clineMessages: mockAlphaMessages,
					cwd: "/test/workspace",
				})
			})

			it("should navigate to previous prompt on arrow up when cursor is at beginning", () => {
				const setInputValue = vi.fn()
				const { container } = render(
					<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="" />,
				)

				const textarea = container.querySelector("textarea")!
				// Ensure cursor is at the beginning
				textarea.setSelectionRange(0, 0)

				// Simulate arrow up key press
				fireEvent.keyDown(textarea, { key: "ArrowUp" })

				// Should set the newest conversation message (first in reversed array)
				expect(setInputValue).toHaveBeenCalledWith("Third prompt")
			})

			it("should navigate through history with multiple arrow up presses", () => {
				const setInputValue = vi.fn()
				const { container } = render(
					<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="" />,
				)

				const textarea = container.querySelector("textarea")!

				// First arrow up - newest conversation message
				fireEvent.keyDown(textarea, { key: "ArrowUp" })
				expect(setInputValue).toHaveBeenCalledWith("Third prompt")

				// Update input value to simulate the state change
				setInputValue.mockClear()

				// Second arrow up - previous conversation message
				fireEvent.keyDown(textarea, { key: "ArrowUp" })
				expect(setInputValue).toHaveBeenCalledWith("Second prompt")
			})

			it("should navigate forward with arrow down", () => {
				const setInputValue = vi.fn()
				const { container } = render(
					<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="" />,
				)

				const textarea = container.querySelector("textarea")!

				// Go back in history first (index 0 -> "Third prompt", then index 1 -> "Second prompt")
				fireEvent.keyDown(textarea, { key: "ArrowUp" })
				fireEvent.keyDown(textarea, { key: "ArrowUp" })
				setInputValue.mockClear()

				// Navigate forward (from index 1 back to index 0)
				fireEvent.keyDown(textarea, { key: "ArrowDown" })
				expect(setInputValue).toHaveBeenCalledWith("Third prompt")
			})

			it("should preserve current input when starting navigation", () => {
				const setInputValue = vi.fn()
				const { container } = render(
					<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="Current input" />,
				)

				const textarea = container.querySelector("textarea")!

				// Navigate to history
				fireEvent.keyDown(textarea, { key: "ArrowUp" })
				expect(setInputValue).toHaveBeenCalledWith("Third prompt")

				setInputValue.mockClear()

				// Navigate back to current input
				fireEvent.keyDown(textarea, { key: "ArrowDown" })
				expect(setInputValue).toHaveBeenCalledWith("Current input")
			})

			it("should reset history navigation when user types", () => {
				const setInputValue = vi.fn()
				const { container } = render(
					<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="" />,
				)

				const textarea = container.querySelector("textarea")!

				// Navigate to history
				fireEvent.keyDown(textarea, { key: "ArrowUp" })
				setInputValue.mockClear()

				// Type something
				fireEvent.change(textarea, { target: { value: "New input", selectionStart: 9 } })

				// Should reset history navigation
				expect(setInputValue).toHaveBeenCalledWith("New input")
			})

			it("should reset history navigation when sending message", () => {
				const onSend = vi.fn()
				const setInputValue = vi.fn()
				const { container } = render(
					<ChatTextArea
						{...defaultProps}
						onSend={onSend}
						setInputValue={setInputValue}
						inputValue="Test message"
					/>,
				)

				const textarea = container.querySelector("textarea")!

				// Navigate to history first
				fireEvent.keyDown(textarea, { key: "ArrowUp" })
				setInputValue.mockClear()

				// Send message
				fireEvent.keyDown(textarea, { key: "Enter" })

				expect(onSend).toHaveBeenCalled()
			})

			it("should navigate history when cursor is at first line", () => {
				const setInputValue = vi.fn()
				const { container } = render(
					<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="" />,
				)

				const textarea = container.querySelector("textarea")!

				// Clear any calls from initial render
				setInputValue.mockClear()

				// With empty input, cursor is at first line by default
				// Arrow up should navigate history
				fireEvent.keyDown(textarea, { key: "ArrowUp" })
				expect(setInputValue).toHaveBeenCalledWith("Third prompt")
			})

			it("should filter history by current workspace", () => {
				const mixedAlphaMessages = [
					{ type: "say", say: "user_feedback", text: "Workspace 1 prompt", ts: 1000 },
					{ type: "say", say: "user_feedback", text: "Other workspace prompt", ts: 2000 },
					{ type: "say", say: "user_feedback", text: "Workspace 1 prompt 2", ts: 3000 },
				]

				;(useExtensionState as import("vitest").Mock).mockReturnValue({
					filePaths: [],
					openedTabs: [],
					apiConfiguration: {
						apiProvider: "anthropic",
					},
					taskHistory: [],
					clineMessages: mixedAlphaMessages,
					cwd: "/test/workspace",
				})

				const setInputValue = vi.fn()
				const { container } = render(
					<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="" />,
				)

				const textarea = container.querySelector("textarea")!

				// Should show conversation messages newest first (after reverse)
				fireEvent.keyDown(textarea, { key: "ArrowUp" })
				expect(setInputValue).toHaveBeenCalledWith("Workspace 1 prompt 2")

				setInputValue.mockClear()
				fireEvent.keyDown(textarea, { key: "ArrowUp" })
				expect(setInputValue).toHaveBeenCalledWith("Other workspace prompt")
			})

			it("should handle empty conversation history gracefully", () => {
				;(useExtensionState as import("vitest").Mock).mockReturnValue({
					filePaths: [],
					openedTabs: [],
					apiConfiguration: {
						apiProvider: "anthropic",
					},
					taskHistory: [],
					clineMessages: [],
					cwd: "/test/workspace",
				})

				const setInputValue = vi.fn()
				const { container } = render(
					<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="" />,
				)

				const textarea = container.querySelector("textarea")!

				// Should not crash or call setInputValue
				fireEvent.keyDown(textarea, { key: "ArrowUp" })
				expect(setInputValue).not.toHaveBeenCalled()
			})

			it("should ignore empty or whitespace-only messages", () => {
				const alphaMessagesWithEmpty = [
					{ type: "say", say: "user_feedback", text: "Valid prompt", ts: 1000 },
					{ type: "say", say: "user_feedback", text: "", ts: 2000 },
					{ type: "say", say: "user_feedback", text: "   ", ts: 3000 },
					{ type: "say", say: "user_feedback", text: "Another valid prompt", ts: 4000 },
				]

				;(useExtensionState as import("vitest").Mock).mockReturnValue({
					filePaths: [],
					openedTabs: [],
					apiConfiguration: {
						apiProvider: "anthropic",
					},
					taskHistory: [],
					clineMessages: alphaMessagesWithEmpty,
					cwd: "/test/workspace",
				})

				const setInputValue = vi.fn()
				const { container } = render(
					<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="" />,
				)

				const textarea = container.querySelector("textarea")!

				// Should skip empty messages, newest first for conversation
				fireEvent.keyDown(textarea, { key: "ArrowUp" })
				expect(setInputValue).toHaveBeenCalledWith("Another valid prompt")

				setInputValue.mockClear()
				fireEvent.keyDown(textarea, { key: "ArrowUp" })
				expect(setInputValue).toHaveBeenCalledWith("Valid prompt")
			})

			it("should use task history (oldest first) when no conversation messages exist", () => {
				const mockTaskHistory = [
					{ task: "First task", workspace: "/test/workspace" },
					{ task: "Second task", workspace: "/test/workspace" },
					{ task: "Third task", workspace: "/test/workspace" },
				]

				;(useExtensionState as import("vitest").Mock).mockReturnValue({
					filePaths: [],
					openedTabs: [],
					apiConfiguration: {
						apiProvider: "anthropic",
					},
					taskHistory: mockTaskHistory,
					clineMessages: [], // No conversation messages
					cwd: "/test/workspace",
				})

				const setInputValue = vi.fn()
				const { container } = render(
					<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="" />,
				)

				const textarea = container.querySelector("textarea")!

				// Should show task history oldest first (chronological order)
				fireEvent.keyDown(textarea, { key: "ArrowUp" })
				expect(setInputValue).toHaveBeenCalledWith("First task")

				setInputValue.mockClear()
				fireEvent.keyDown(textarea, { key: "ArrowUp" })
				expect(setInputValue).toHaveBeenCalledWith("Second task")
			})

			it("should reset navigation position when switching between history sources", () => {
				const setInputValue = vi.fn()
				const { rerender } = render(
					<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="" />,
				)

				// Start with task history
				;(useExtensionState as import("vitest").Mock).mockReturnValue({
					filePaths: [],
					openedTabs: [],
					apiConfiguration: {
						apiProvider: "anthropic",
					},
					taskHistory: [
						{ task: "Task 1", workspace: "/test/workspace" },
						{ task: "Task 2", workspace: "/test/workspace" },
					],
					clineMessages: [],
					cwd: "/test/workspace",
				})

				rerender(
					<ChatTextArea
						{...defaultProps}
						setInputValue={setInputValue}
						inputValue=""
						placeholderText="task-history"
					/>,
				)

				const textarea = document.querySelector("textarea")!

				// Navigate in task history
				fireEvent.keyDown(textarea, { key: "ArrowUp" })
				expect(setInputValue).toHaveBeenCalledWith("Task 1")

				// Switch to conversation messages
				;(useExtensionState as import("vitest").Mock).mockReturnValue({
					filePaths: [],
					openedTabs: [],
					apiConfiguration: {
						apiProvider: "anthropic",
					},
					taskHistory: [],
					clineMessages: [
						{ type: "say", say: "user_feedback", text: "Message 1", ts: 1000 },
						{ type: "say", say: "user_feedback", text: "Message 2", ts: 2000 },
					],
					cwd: "/test/workspace",
				})

				setInputValue.mockClear()
				rerender(
					<ChatTextArea
						{...defaultProps}
						setInputValue={setInputValue}
						inputValue=""
						placeholderText="conversation"
					/>,
				)

				// Should start from beginning of conversation history (newest first)
				fireEvent.keyDown(textarea, { key: "ArrowUp" })
				expect(setInputValue).toHaveBeenCalledWith("Message 2")
			})

			it("should not navigate history with arrow up when cursor is not at beginning", () => {
				const setInputValue = vi.fn()
				const { container } = render(
					<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="Some text here" />,
				)

				const textarea = container.querySelector("textarea")!
				// Set cursor to middle of text (not at beginning)
				textarea.setSelectionRange(5, 5)

				// Clear any calls from initial render
				setInputValue.mockClear()

				// Simulate arrow up key press
				fireEvent.keyDown(textarea, { key: "ArrowUp" })

				// Should not navigate history, allowing default behavior (move cursor to start)
				expect(setInputValue).not.toHaveBeenCalled()
			})

			it("should navigate history with arrow up when cursor is at beginning", () => {
				const setInputValue = vi.fn()
				const { container } = render(
					<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="Some text here" />,
				)

				const textarea = container.querySelector("textarea")!
				// Set cursor to beginning of text
				textarea.setSelectionRange(0, 0)

				// Clear any calls from initial render
				setInputValue.mockClear()

				// Simulate arrow up key press
				fireEvent.keyDown(textarea, { key: "ArrowUp" })

				// Should navigate to history since cursor is at beginning
				expect(setInputValue).toHaveBeenCalledWith("Third prompt")
			})

			it("should navigate history with Command+Up when cursor is at beginning", () => {
				const setInputValue = vi.fn()
				const { container } = render(
					<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="Some text here" />,
				)

				const textarea = container.querySelector("textarea")!
				// Set cursor to beginning of text
				textarea.setSelectionRange(0, 0)

				// Clear any calls from initial render
				setInputValue.mockClear()

				// Simulate Command+Up key press
				fireEvent.keyDown(textarea, { key: "ArrowUp", metaKey: true })

				// Should navigate to history since cursor is at beginning (same as regular Up)
				expect(setInputValue).toHaveBeenCalledWith("Third prompt")
			})

			it("should not navigate history with Command+Up when cursor is not at beginning", () => {
				const setInputValue = vi.fn()
				const { container } = render(
					<ChatTextArea {...defaultProps} setInputValue={setInputValue} inputValue="Some text here" />,
				)

				const textarea = container.querySelector("textarea")!
				// Set cursor to middle of text (not at beginning)
				textarea.setSelectionRange(5, 5)

				// Clear any calls from initial render
				setInputValue.mockClear()

				// Simulate Command+Up key press
				fireEvent.keyDown(textarea, { key: "ArrowUp", metaKey: true })

				// Should not navigate history, allowing default behavior (same as regular Up)
				expect(setInputValue).not.toHaveBeenCalled()
			})
		})
	})

	describe("slash command highlighting", () => {
		const mockCommands = [
			{ name: "setup", source: "project", description: "Setup the project" },
			{ name: "deploy", source: "global", description: "Deploy the application" },
			{ name: "test-command", source: "project", description: "Test command with dash" },
		]

		beforeEach(() => {
			;(useExtensionState as import("vitest").Mock).mockReturnValue({
				filePaths: [],
				openedTabs: [],
				taskHistory: [],
				cwd: "/test/workspace",
				commands: mockCommands,
			})
		})

		it("should highlight valid slash commands", () => {
			const { getByTestId } = render(<ChatTextArea {...defaultProps} inputValue="/setup the project" />)

			const highlightLayer = getByTestId("highlight-layer")
			expect(highlightLayer).toBeInTheDocument()

			// The highlighting is applied via innerHTML, so we need to check the content
			// The valid command "/setup" should be highlighted
			expect(highlightLayer.innerHTML).toContain('<mark class="mention-context-textarea-highlight">/setup</mark>')
		})

		it("should not highlight invalid slash commands", () => {
			const { getByTestId } = render(<ChatTextArea {...defaultProps} inputValue="/invalid command" />)

			const highlightLayer = getByTestId("highlight-layer")
			expect(highlightLayer).toBeInTheDocument()

			// The invalid command "/invalid" should not be highlighted
			expect(highlightLayer.innerHTML).not.toContain(
				'<mark class="mention-context-textarea-highlight">/invalid</mark>',
			)
			// But it should still contain the text without highlighting
			expect(highlightLayer.innerHTML).toContain("/invalid")
		})

		it("should highlight only the command portion, not arguments", () => {
			const { getByTestId } = render(<ChatTextArea {...defaultProps} inputValue="/deploy to production" />)

			const highlightLayer = getByTestId("highlight-layer")
			expect(highlightLayer).toBeInTheDocument()

			// Only "/deploy" should be highlighted, not "to production"
			expect(highlightLayer.innerHTML).toContain(
				'<mark class="mention-context-textarea-highlight">/deploy</mark>',
			)
			expect(highlightLayer.innerHTML).not.toContain(
				'<mark class="mention-context-textarea-highlight">/deploy to production</mark>',
			)
		})

		it("should handle commands with dashes and underscores", () => {
			const { getByTestId } = render(<ChatTextArea {...defaultProps} inputValue="/test-command with args" />)

			const highlightLayer = getByTestId("highlight-layer")
			expect(highlightLayer).toBeInTheDocument()

			// The command with dash should be highlighted
			expect(highlightLayer.innerHTML).toContain(
				'<mark class="mention-context-textarea-highlight">/test-command</mark>',
			)
		})

		it("should be case-sensitive when matching commands", () => {
			const { getByTestId } = render(<ChatTextArea {...defaultProps} inputValue="/Setup the project" />)

			const highlightLayer = getByTestId("highlight-layer")
			expect(highlightLayer).toBeInTheDocument()

			// "/Setup" (capital S) should not be highlighted since the command is "setup" (lowercase)
			expect(highlightLayer.innerHTML).not.toContain(
				'<mark class="mention-context-textarea-highlight">/Setup</mark>',
			)
			expect(highlightLayer.innerHTML).toContain("/Setup")
		})

		it("should highlight multiple valid commands in the same text", () => {
			const { getByTestId } = render(<ChatTextArea {...defaultProps} inputValue="/setup first then /deploy" />)

			const highlightLayer = getByTestId("highlight-layer")
			expect(highlightLayer).toBeInTheDocument()

			// Both valid commands should be highlighted
			expect(highlightLayer.innerHTML).toContain('<mark class="mention-context-textarea-highlight">/setup</mark>')
			expect(highlightLayer.innerHTML).toContain(
				'<mark class="mention-context-textarea-highlight">/deploy</mark>',
			)
		})

		it("should handle mixed valid and invalid commands", () => {
			const { getByTestId } = render(
				<ChatTextArea {...defaultProps} inputValue="/setup first then /invalid then /deploy" />,
			)

			const highlightLayer = getByTestId("highlight-layer")
			expect(highlightLayer).toBeInTheDocument()

			// Valid commands should be highlighted
			expect(highlightLayer.innerHTML).toContain('<mark class="mention-context-textarea-highlight">/setup</mark>')
			expect(highlightLayer.innerHTML).toContain(
				'<mark class="mention-context-textarea-highlight">/deploy</mark>',
			)

			// Invalid command should not be highlighted
			expect(highlightLayer.innerHTML).not.toContain(
				'<mark class="mention-context-textarea-highlight">/invalid</mark>',
			)
			expect(highlightLayer.innerHTML).toContain("/invalid")
		})

		it("should work when no commands are available", () => {
			;(useExtensionState as import("vitest").Mock).mockReturnValue({
				filePaths: [],
				openedTabs: [],
				taskHistory: [],
				cwd: "/test/workspace",
				commands: undefined,
			})

			const { getByTestId } = render(<ChatTextArea {...defaultProps} inputValue="/setup the project" />)

			const highlightLayer = getByTestId("highlight-layer")
			expect(highlightLayer).toBeInTheDocument()

			// No commands should be highlighted when commands array is undefined
			expect(highlightLayer.innerHTML).not.toContain(
				'<mark class="mention-context-textarea-highlight">/setup</mark>',
			)
			expect(highlightLayer.innerHTML).toContain("/setup")
		})
	})

	describe("selectApiConfig", () => {
		// Helper function to get the API config dropdown
		const getApiConfigDropdown = () => {
			return screen.getByTestId("dropdown-trigger")
		}
		it("should be enabled independently of sendingDisabled", () => {
			render(<ChatTextArea {...defaultProps} sendingDisabled={true} selectApiConfigDisabled={false} />)
			const apiConfigDropdown = getApiConfigDropdown()
			expect(apiConfigDropdown).not.toHaveAttribute("disabled")
		})
		it("should be disabled when selectApiConfigDisabled is true", () => {
			render(<ChatTextArea {...defaultProps} sendingDisabled={true} selectApiConfigDisabled={true} />)
			const apiConfigDropdown = getApiConfigDropdown()
			expect(apiConfigDropdown).toHaveAttribute("disabled")
		})

		describe("enter key behavior", () => {
			it("blocks keyboard submission while disabled", () => {
				const onSend = vi.fn()
				const { container } = render(
					<ChatTextArea
						{...defaultProps}
						inputValue="pending admission"
						sendingDisabled={true}
						onSend={onSend}
					/>,
				)
				const textarea = container.querySelector("textarea")!
				const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })

				fireEvent(textarea, event)

				expect(event.defaultPrevented).toBe(true)
				expect(onSend).not.toHaveBeenCalled()
				expect(container.querySelector("button:has(.lucide-send-horizontal)")).toBeDisabled()
			})

			it("should send on Enter and allow newline on Shift+Enter in default mode", () => {
				const onSend = vi.fn()

				;(useExtensionState as import("vitest").Mock).mockReturnValue({
					filePaths: [],
					openedTabs: [],
					taskHistory: [],
					cwd: "/test/workspace",
				})

				const { container } = render(
					<ChatTextArea {...defaultProps} inputValue="Ready to send" onSend={onSend} />,
				)

				const textarea = container.querySelector("textarea")!

				fireEvent.keyDown(textarea, { key: "Enter" })
				expect(onSend).toHaveBeenCalledTimes(1)

				const shiftEnterEvent = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true })
				fireEvent(textarea, shiftEnterEvent)
				expect(onSend).toHaveBeenCalledTimes(1)
				expect(shiftEnterEvent.defaultPrevented).toBe(false)
			})

			it("should treat Ctrl/Cmd/Shift+Enter as send and plain Enter as newline in newline mode", () => {
				const onSend = vi.fn()

				;(useExtensionState as import("vitest").Mock).mockReturnValue({
					filePaths: [],
					openedTabs: [],
					taskHistory: [],
					cwd: "/test/workspace",
					enterBehavior: "newline",
				})

				const { container } = render(
					<ChatTextArea {...defaultProps} inputValue="Ready to send" onSend={onSend} />,
				)

				const textarea = container.querySelector("textarea")!

				const plainEnterEvent = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
				fireEvent(textarea, plainEnterEvent)
				expect(onSend).not.toHaveBeenCalled()
				expect(plainEnterEvent.defaultPrevented).toBe(false)

				const ctrlEnterEvent = new KeyboardEvent("keydown", {
					key: "Enter",
					ctrlKey: true,
					bubbles: true,
					cancelable: true,
				})
				fireEvent(textarea, ctrlEnterEvent)
				expect(onSend).toHaveBeenCalledTimes(1)
				expect(ctrlEnterEvent.defaultPrevented).toBe(true)

				const shiftEnterEvent = new KeyboardEvent("keydown", {
					key: "Enter",
					shiftKey: true,
					bubbles: true,
					cancelable: true,
				})
				fireEvent(textarea, shiftEnterEvent)
				expect(onSend).toHaveBeenCalledTimes(2)
				expect(shiftEnterEvent.defaultPrevented).toBe(true)
			})

			it("should save queued edit on plain Enter even when normal Enter behavior is newline", () => {
				const onSend = vi.fn()

				;(useExtensionState as import("vitest").Mock).mockReturnValue({
					filePaths: [],
					openedTabs: [],
					taskHistory: [],
					cwd: "/test/workspace",
					enterBehavior: "newline",
				})

				const { container } = render(
					<ChatTextArea
						{...defaultProps}
						inputValue="Updated queued prompt"
						isEditMode={true}
						onSend={onSend}
					/>,
				)

				const textarea = container.querySelector("textarea")!
				const plainEnterEvent = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
				fireEvent(textarea, plainEnterEvent)

				expect(onSend).toHaveBeenCalledTimes(1)
				expect(plainEnterEvent.defaultPrevented).toBe(true)
			})
		})
	})

	describe("send button visibility", () => {
		it.each([
			{ enterBehavior: "send", shiftKey: true },
			{ enterBehavior: "newline", shiftKey: false },
		] as const)(
			"allows an empty draft newline when Enter behavior is $enterBehavior",
			({ enterBehavior, shiftKey }) => {
				vi.mocked(useExtensionState).mockReturnValue({
					...vi.mocked(useExtensionState)(),
					enterBehavior,
				})
				render(<ChatTextArea {...defaultProps} inputValue="" />)
				const event = new KeyboardEvent("keydown", { key: "Enter", shiftKey, bubbles: true, cancelable: true })
				fireEvent(screen.getByRole("textbox"), event)
				expect(event.defaultPrevented).toBe(false)
				expect(defaultProps.onSend).not.toHaveBeenCalled()
			},
		)

		it("should show send button when there are images but no text", () => {
			const { container } = render(
				<ChatTextArea
					{...defaultProps}
					inputValue=""
					selectedImages={["data:image/png;base64,test1", "data:image/png;base64,test2"]}
				/>,
			)

			// Find the send button by looking for the button with SendHorizontal icon
			const buttons = container.querySelectorAll("button")
			const sendButton = Array.from(buttons).find(
				(button) => button.querySelector(".lucide-send-horizontal") !== null,
			)

			expect(sendButton).toBeInTheDocument()

			// Check that the button is visible (has opacity-100 class when content exists)
			expect(sendButton).toHaveClass("opacity-100")
			expect(sendButton).toHaveClass("pointer-events-auto")
			expect(sendButton).not.toHaveClass("opacity-0")
			expect(sendButton).not.toHaveClass("pointer-events-none")
		})

		it.each(
			(["default", "newTask"] as const).flatMap((appearance) =>
				["", " \n"].map((inputValue) => ({ appearance, inputValue })),
			),
		)("keeps empty Send visible and disabled in $appearance for $inputValue", ({ appearance, inputValue }) => {
			render(
				<ChatTextArea {...defaultProps} appearance={appearance} inputValue={inputValue} selectedImages={[]} />,
			)
			const sendButton = screen.getByRole("button", { name: "Press Enter to send" })
			expect(sendButton).toBeVisible()
			expect(sendButton).toBeDisabled()
			expect(sendButton).toHaveClass("opacity-50")
			expect(sendButton).not.toHaveClass("opacity-0", "pointer-events-none")
			fireEvent.click(sendButton)
			fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
			expect(defaultProps.onSend).not.toHaveBeenCalled()
		})

		it("brightens the same Send button when text is entered and dims it again when cleared", () => {
			const { rerender } = render(<ChatTextArea {...defaultProps} inputValue="" />)
			const sendButton = screen.getByRole("button", { name: "Press Enter to send" })
			expect(sendButton).toBeDisabled()
			rerender(<ChatTextArea {...defaultProps} inputValue="Send this" />)
			expect(screen.getByRole("button", { name: "Press Enter to send" })).toBe(sendButton)
			expect(sendButton).toBeEnabled()
			expect(sendButton).toHaveClass("opacity-100")
			expect(sendButton).not.toHaveClass("opacity-50")
			fireEvent.click(sendButton)
			expect(defaultProps.onSend).toHaveBeenCalledTimes(1)
			rerender(<ChatTextArea {...defaultProps} inputValue="" />)
			expect(sendButton).toBeDisabled()
			expect(sendButton).toHaveClass("opacity-50")
			fireEvent.click(sendButton)
			expect(defaultProps.onSend).toHaveBeenCalledTimes(1)
		})

		it("should show send button when there is text but no images", () => {
			const { container } = render(<ChatTextArea {...defaultProps} inputValue="Some text" selectedImages={[]} />)

			// Find the send button by looking for the button with SendHorizontal icon
			const buttons = container.querySelectorAll("button")
			const sendButton = Array.from(buttons).find(
				(button) => button.querySelector(".lucide-send-horizontal") !== null,
			)

			expect(sendButton).toBeInTheDocument()

			// Check that the button is visible
			expect(sendButton).toHaveClass("opacity-100")
			expect(sendButton).toHaveClass("pointer-events-auto")
		})

		it("should show send button when there is both text and images", () => {
			const { container } = render(
				<ChatTextArea
					{...defaultProps}
					inputValue="Some text"
					selectedImages={["data:image/png;base64,test1"]}
				/>,
			)

			// Find the send button by looking for the button with SendHorizontal icon
			const buttons = container.querySelectorAll("button")
			const sendButton = Array.from(buttons).find(
				(button) => button.querySelector(".lucide-send-horizontal") !== null,
			)

			expect(sendButton).toBeInTheDocument()

			// Check that the button is visible
			expect(sendButton).toHaveClass("opacity-100")
			expect(sendButton).toHaveClass("pointer-events-auto")
		})
	})
})
