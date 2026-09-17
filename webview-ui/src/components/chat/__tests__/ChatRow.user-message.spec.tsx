import { fireEvent, render, screen, within } from "@/utils/test-utils"
import type { ClineMessage } from "@alpha-code/types"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import ChatRow, { type ChatRowEnvironment } from "../ChatRow"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
const copyWithFeedback = vi.hoisted(() => vi.fn())
vi.mock("@src/utils/clipboard", () => ({
	useCopyToClipboard: () => ({ copyWithFeedback, showCopyFeedback: false }),
}))

const message: ClineMessage = {
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
	getClineMessages: () => [message],
}

function renderMessage(isStreaming = false, isTaskPrompt = false) {
	return render(
		<ExtensionStateContextProvider>
			<ChatRow
				message={
					isTaskPrompt ? { ...message, say: "text", images: ["data:image/png;base64,aGVsbG8="] } : message
				}
				isTaskPrompt={isTaskPrompt}
				environment={environment}
				isExpanded={false}
				isLast={false}
				isStreaming={isStreaming}
				onToggleExpand={() => {}}
			/>
		</ExtensionStateContextProvider>,
	)
}

describe("user message bubbles", () => {
	beforeEach(() => vi.clearAllMocks())

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

	it("keeps edit and delete unavailable while streaming", () => {
		renderMessage(true)
		expect(screen.getByRole("button", { name: "Edit and resend" })).toBeDisabled()
		expect(screen.getByRole("button", { name: "Delete Message" })).toBeDisabled()
		expect(screen.getByRole("button", { name: "Copy" })).toBeEnabled()
		fireEvent.click(screen.getByText(/Keep paragraphs easy to scan/))
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
	})
})
