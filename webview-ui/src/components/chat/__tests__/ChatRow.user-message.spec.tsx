import { act, fireEvent, render, screen, within } from "@/utils/test-utils"
import userEvent from "@testing-library/user-event"
import type { AlphaMessage } from "@alpha-code/types"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import ChatRow, { type ChatRowEnvironment } from "../ChatRow"

vi.mock("@/i18n/TranslationContext", async () => {
	const { default: i18n } = await import("@/i18n/setup")
	return { useAppTranslation: () => ({ t: (key: string) => key, i18n }) }
})

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
const copyWithFeedback = vi.hoisted(() => vi.fn())
vi.mock("@src/utils/clipboard", () => ({
	useCopyToClipboard: () => ({ copyWithFeedback, showCopyFeedback: false }),
}))

const message: AlphaMessage = {
	ts: 10,
	type: "say",
	say: "user_feedback",
	text: "Keep paragraphs easy to scan.\n    Preserve indentation in pasted logs.",
}

const environment: ChatRowEnvironment = {
	mcpServers: [],
	alwaysAllowMcp: false,
	mode: "code",
	currentTaskId: "style-task",
	reasoningBlockCollapsed: true,
	modelSupportsImages: true,
	getAlphaMessages: () => [message],
}

function messageElement(
	isStreaming = false,
	isTaskPrompt = false,
	rowEnvironment = environment,
	messageActionsDisabled?: boolean,
) {
	return (
		<ExtensionStateContextProvider>
			<ChatRow
				message={
					isTaskPrompt ? { ...message, say: "text", images: ["data:image/png;base64,aGVsbG8="] } : message
				}
				isTaskPrompt={isTaskPrompt}
				environment={rowEnvironment}
				isExpanded={false}
				isLast={false}
				isStreaming={isStreaming}
				messageActionsDisabled={messageActionsDisabled}
				onToggleExpand={() => {}}
			/>
		</ExtensionStateContextProvider>
	)
}

function renderMessage(isStreaming = false, isTaskPrompt = false) {
	return render(messageElement(isStreaming, isTaskPrompt))
}

describe("user message bubbles", () => {
	beforeEach(() => vi.clearAllMocks())

	it.each([
		["requested", "Stop requested by another chat"],
		["stopped", "Stopped by another chat"],
	] as const)("shows a %s stop with its reason in the attributed bubble", (stopStatus, label) => {
		const incoming: AlphaMessage = {
			ts: 11,
			type: "say",
			say: "agent_message",
			text: "Stop: all requested work is complete.",
			agentMessage: { id: "stop-1", senderTaskId: "peer-chat", stopStatus },
		}
		const { container } = render(
			<ExtensionStateContextProvider>
				<ChatRow
					message={incoming}
					environment={environment}
					isExpanded={false}
					isLast={true}
					isStreaming={false}
					onToggleExpand={() => {}}
				/>
			</ExtensionStateContextProvider>,
		)
		const article = screen.getByRole("article", { name: "From another chat" })
		expect(within(article).getByRole("status")).toHaveTextContent(label)
		expect(container.querySelector(".user-message")?.textContent).toBe(incoming.text)
		expect(within(article).queryByRole("button", { name: "Edit and resend" })).not.toBeInTheDocument()
		fireEvent.click(within(article).getByRole("button", { name: "Copy" }))
		expect(copyWithFeedback).toHaveBeenCalledWith(incoming.text, expect.anything())
	})

	it.each([
		[undefined, "API Request Cancelled"],
		["stop-1", "Stopped by another chat"],
	] as const)("identifies the cancellation source for API receipt %s", (agentStopMessageId, label) => {
		const request: AlphaMessage = {
			ts: 11,
			type: "say",
			say: "api_req_started",
			text: JSON.stringify({ cancelReason: "user_cancelled", agentStopMessageId, cost: 0 }),
		}
		render(
			<ExtensionStateContextProvider>
				<ChatRow
					message={request}
					environment={environment}
					isExpanded={false}
					isLast={true}
					isStreaming={false}
					onToggleExpand={() => {}}
				/>
			</ExtensionStateContextProvider>,
		)
		expect(screen.getByText(label)).toBeInTheDocument()
	})

	it("shows incoming chat input in the same colored bubble with attribution and copy only", () => {
		const incoming: AlphaMessage = {
			ts: 11,
			type: "say",
			say: "agent_message",
			text: "The parser review is ready.\nPlease check the result.",
			agentMessage: { id: "message-1", senderTaskId: "peer-chat" },
		}
		const { container } = render(
			<ExtensionStateContextProvider>
				<ChatRow
					message={incoming}
					environment={environment}
					isExpanded={false}
					isLast={true}
					isStreaming={false}
					onToggleExpand={() => {}}
				/>
			</ExtensionStateContextProvider>,
		)
		const article = screen.getByRole("article", { name: "From another chat" })
		expect(article).toHaveClass("items-end")
		expect(container.querySelector(".user-message")?.textContent).toBe(incoming.text)
		expect(within(article).getByText("From another chat")).toBeInTheDocument()
		fireEvent.click(within(article).getByRole("button", { name: "Copy" }))
		expect(copyWithFeedback).toHaveBeenCalledWith(incoming.text, expect.anything())
		expect(within(article).queryByRole("button", { name: "Edit and resend" })).not.toBeInTheDocument()
		expect(within(article).queryByRole("button", { name: "Delete Message" })).not.toBeInTheDocument()
		fireEvent.click(within(article).getByText(/The parser review is ready/))
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
	})

	it("lets the opening prompt be copied, edited and resent with its attachments", () => {
		const { container } = renderMessage(false, true)
		const article = screen.getByRole("article", { name: "You said" })
		expect(article).toHaveClass("items-end")
		expect(container.querySelector(".user-message")).toHaveTextContent("Keep paragraphs easy to scan.")
		expect(within(article).getByRole("img")).toHaveAttribute("src", "data:image/png;base64,aGVsbG8=")
		fireEvent.click(within(article).getByRole("button", { name: "Copy" }))
		expect(copyWithFeedback).toHaveBeenCalledWith(message.text, expect.anything())
		fireEvent.click(within(article).getByRole("button", { name: "Edit and resend" }))
		expect(screen.queryByRole("button", { name: "Delete Message" })).not.toBeInTheDocument()
		const editor = screen.getByRole("textbox", { name: "Edit your message..." })
		expect(editor).toHaveValue(message.text)
		fireEvent.change(editor, { target: { value: "A revised opening prompt" } })
		fireEvent.click(screen.getByRole("button", { name: "chat:pressToSend" }))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "submitEditedMessage",
			value: 10,
			taskId: "style-task",
			editedMessageContent: "A revised opening prompt",
			images: ["data:image/png;base64,aGVsbG8="],
		})
	})

	it("retains edited text and attachments while host confirmation is cancelled or the restart fails", () => {
		const { rerender } = renderMessage(false, true)
		fireEvent.click(screen.getByRole("button", { name: "Edit and resend" }))
		const editor = screen.getByRole("textbox", { name: "Edit your message..." })
		fireEvent.change(editor, { target: { value: "Keep this revised prompt" } })
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "selectedImages",
						context: "edit",
						messageTs: message.ts,
						images: ["data:image/png;base64,bmV3"],
					},
				}),
			)
		})
		const request = {
			type: "submitEditedMessage",
			value: message.ts,
			taskId: environment.currentTaskId,
			editedMessageContent: "Keep this revised prompt",
			images: ["data:image/png;base64,aGVsbG8=", "data:image/png;base64,bmV3"],
		}
		fireEvent.click(screen.getByRole("button", { name: "chat:pressToSend" }))
		expect(vscode.postMessage).toHaveBeenCalledWith(request)
		expect(editor).toHaveValue(request.editedMessageContent)
		expect(screen.getAllByRole("img")).toHaveLength(2)
		// Cancelling confirmation leaves the same transcript. A failed restart can
		// also refresh task state without replacing the original prompt.
		rerender(messageElement(false, true))
		expect(screen.getByRole("textbox", { name: "Edit your message..." })).toBe(editor)
		rerender(
			messageElement(false, true, {
				...environment,
				currentTaskItem: { id: "style-task", status: "failed" },
			}),
		)
		expect(editor).toHaveValue(request.editedMessageContent)
		expect(screen.getAllByRole("img")).toHaveLength(2)
		fireEvent.click(screen.getByRole("button", { name: "chat:pressToSend" }))
		expect(vscode.postMessage).toHaveBeenLastCalledWith(request)
	})

	it("right-aligns the message and its actions without losing their labels or task routing", () => {
		const { container } = renderMessage()
		const article = screen.getByRole("article", { name: "You said" })
		const bubble = container.querySelector(".user-message")!
		expect(article).toHaveClass("items-end")
		expect(bubble.textContent).toBe(message.text)
		const edit = within(article).getByRole("button", { name: "Edit and resend" })
		fireEvent.click(within(article).getByRole("button", { name: "Copy" }))
		expect(copyWithFeedback).toHaveBeenCalledWith(message.text, expect.anything())
		const remove = within(article).getByRole("button", { name: "Delete Message" })
		expect(bubble).not.toContainElement(edit)
		expect(bubble).not.toContainElement(remove)
		fireEvent.click(remove)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "deleteMessage", value: 10, taskId: "style-task" })
	})

	it("opens the message edit buffer and restores the bubble when editing is cancelled", () => {
		const { container } = renderMessage()
		fireEvent.click(screen.getByRole("button", { name: "Edit and resend" }))
		const editor = screen.getByRole("textbox", { name: "Edit your message..." })
		expect(editor).toHaveValue(message.text)
		expect(container.querySelector(".user-message")).not.toBeInTheDocument()
		fireEvent.change(editor, { target: { value: "Unsaved changes" } })
		fireEvent.keyDown(editor, { key: "Escape" })
		expect(container.querySelector(".user-message")?.textContent).toBe(message.text)
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "submitEditedMessage" }))
	})

	it("lets keyboard users copy and edit a message without hovering over it", async () => {
		// The shared FAST setup replaces focus with a no-op; use the DOM's implementation for keyboard navigation.
		const focusDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "focus")!
		const frame = document.createElement("iframe")
		document.body.append(frame)
		const nativeFocus = frame.contentDocument!.createElement("button").focus
		frame.remove()
		Object.defineProperty(HTMLElement.prototype, "focus", { configurable: true, value: nativeFocus })
		try {
			const user = userEvent.setup()
			renderMessage()
			const copy = screen.getByRole("button", { name: "Copy" })
			await user.tab()
			expect(copy).toHaveFocus()
			await user.keyboard("{Enter}")
			expect(copyWithFeedback).toHaveBeenCalledWith(message.text, expect.anything())
			await user.tab()
			expect(screen.getByRole("button", { name: "Edit and resend" })).toHaveFocus()
			await user.keyboard("{Enter}")
			expect(screen.getByRole("textbox", { name: "Edit your message..." })).toHaveValue(message.text)
		} finally {
			Object.defineProperty(HTMLElement.prototype, "focus", focusDescriptor)
		}
	})

	it("targets the selected follow-up by its persisted timestamp and task ID", () => {
		renderMessage()
		fireEvent.click(screen.getByRole("button", { name: "Edit and resend" }))
		fireEvent.change(screen.getByRole("textbox", { name: "Edit your message..." }), {
			target: { value: "Use the smaller layout" },
		})
		fireEvent.click(screen.getByRole("button", { name: "chat:pressToSend" }))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "submitEditedMessage",
			value: message.ts,
			taskId: environment.currentTaskId,
			editedMessageContent: "Use the smaller layout",
			images: [],
		})
	})

	it("keeps edit and delete unavailable while streaming", () => {
		renderMessage(true)
		expect(screen.getByRole("button", { name: "Edit and resend" })).toBeDisabled()
		expect(screen.getByRole("button", { name: "Delete Message" })).toBeDisabled()
		expect(screen.getByRole("button", { name: "Copy" })).toBeEnabled()
		fireEvent.click(screen.getByText(/Keep paragraphs easy to scan/))
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
	})

	it.each([
		["an active turn", environment, true],
		[
			"a parent-managed sub-agent",
			{ ...environment, currentTaskItem: { id: "style-task", taskKind: "subagent" as const } },
			false,
		],
		["a missing task", { ...environment, currentTaskId: undefined }, false],
	] as const)("keeps copying available while mutations are restricted for %s", (_, rowEnvironment, disabled) => {
		render(messageElement(false, false, rowEnvironment, disabled))
		expect(screen.getByRole("button", { name: "Edit and resend" })).toBeDisabled()
		expect(screen.getByRole("button", { name: "Delete Message" })).toBeDisabled()
		fireEvent.click(screen.getByRole("button", { name: "Copy" }))
		expect(copyWithFeedback).toHaveBeenCalledWith(message.text, expect.anything())
		fireEvent.click(screen.getByText(/Keep paragraphs easy to scan/))
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "submitEditedMessage" }))
	})

	it("disables an open editor when a turn starts without losing its draft", () => {
		const { rerender } = renderMessage()
		fireEvent.click(screen.getByRole("button", { name: "Edit and resend" }))
		const editor = screen.getByRole("textbox", { name: "Edit your message..." })
		fireEvent.change(editor, { target: { value: "Keep this draft" } })
		rerender(messageElement(false, false, environment, true))
		expect(screen.getByRole("button", { name: "chat:pressToSend" })).toBeDisabled()
		expect(editor).toHaveValue("Keep this draft")
		fireEvent.click(screen.getByRole("button", { name: "chat:pressToSend" }))
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "submitEditedMessage" }))
		rerender(messageElement())
		fireEvent.click(screen.getByRole("button", { name: "chat:pressToSend" }))
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				value: message.ts,
				taskId: "style-task",
				editedMessageContent: "Keep this draft",
			}),
		)
	})
})
