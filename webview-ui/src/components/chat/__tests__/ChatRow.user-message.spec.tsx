import { fireEvent, render, screen, within } from "@/utils/test-utils"
import type { ClineMessage } from "@alpha-code/types"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import ChatRow, { type ChatRowEnvironment } from "../ChatRow"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const message: ClineMessage = {
	ts: 10,
	type: "say",
	say: "user_feedback",
	text: "Keep the text centered.\nMake long messages easy to read.",
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

function renderMessage(isStreaming = false) {
	return render(
		<ExtensionStateContextProvider>
			<ChatRow
				message={message}
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

	it("right-aligns the message and its actions without losing their labels or task routing", () => {
		const { container } = renderMessage()
		const article = screen.getByRole("article", { name: "You said" })
		const bubble = container.querySelector(".user-message")!
		expect(article).toHaveClass("items-end")
		expect(bubble.textContent).toBe(message.text)
		const edit = within(article).getByRole("button", { name: "Edit" })
		const remove = within(article).getByRole("button", { name: "Delete Message" })
		expect(bubble).not.toContainElement(edit)
		expect(bubble).not.toContainElement(remove)
		fireEvent.click(remove)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "deleteMessage", value: 10, taskId: "style-task" })
	})

	it("opens the message edit buffer and restores the bubble when editing is cancelled", () => {
		const { container } = renderMessage()
		fireEvent.click(screen.getByRole("button", { name: "Edit" }))
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
		expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "Delete Message" })).not.toBeInTheDocument()
		fireEvent.click(screen.getByText(/Keep the text centered/))
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
	})
})
