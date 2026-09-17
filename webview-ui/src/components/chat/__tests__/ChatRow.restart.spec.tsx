import { fireEvent, render, screen } from "@/utils/test-utils"
import type { AlphaMessage } from "@alpha-code/types"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"
import ChatRow, { type ChatRowEnvironment } from "../ChatRow"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const opening: AlphaMessage = {
	ts: 1,
	type: "say",
	say: "text",
	text: "Original prompt",
	images: ["data:image/png;base64,aGVsbG8="],
}
const followup: AlphaMessage = { ts: 3, type: "say", say: "user_feedback", text: "Follow-up prompt" }
const environment: ChatRowEnvironment = {
	mcpServers: [],
	alwaysAllowMcp: false,
	mode: "code",
	currentTaskId: "restart-task",
	reasoningBlockCollapsed: true,
	getAlphaMessages: () => [],
}

describe("reply restart actions", () => {
	beforeEach(() => vi.clearAllMocks())
	it.each([
		{ type: "say", say: "text", text: "Assistant update" },
		{ type: "say", say: "completion_result", text: "Assistant answer" },
		{ type: "ask", ask: "completion_result", text: "Assistant answer" },
		{ type: "ask", ask: "followup", text: JSON.stringify({ question: "Which option?", suggest: [] }) },
	] as const)("restarts $type/$say/$ask from the preceding prompt, never a later prompt", (reply) => {
		const message: AlphaMessage = { ...reply, ts: 2 }
		render(
			<ExtensionStateContextProvider>
				<ChatRow
					message={message}
					environment={{ ...environment, getAlphaMessages: () => [opening, message, followup] }}
					isExpanded
					isLast={false}
					isStreaming={false}
					onToggleExpand={() => {}}
				/>
			</ExtensionStateContextProvider>,
		)
		expect(screen.getByRole("button", { name: "Copy" })).toBeEnabled()
		fireEvent.click(screen.getByRole("button", { name: "Restart from previous prompt" }))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "submitEditedMessage",
			value: 1,
			editedMessageContent: opening.text,
			images: opening.images,
			taskId: "restart-task",
			messageAction: "restart",
		})
	})

	it("uses the nearest follow-up and disables restart while work is running", () => {
		const message: AlphaMessage = { ts: 4, type: "say", say: "completion_result", text: "Second answer" }
		const props = {
			message,
			environment: { ...environment, getAlphaMessages: () => [opening, followup, message] },
			isExpanded: true,
			isLast: true,
			onToggleExpand: () => {},
		}
		const { rerender } = render(
			<ExtensionStateContextProvider>
				<ChatRow {...props} isStreaming />
			</ExtensionStateContextProvider>,
		)
		const restart = screen.getByRole("button", { name: "Restart from previous prompt" })
		expect(restart).toBeDisabled()
		fireEvent.click(restart)
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "submitEditedMessage" }))
		rerender(
			<ExtensionStateContextProvider>
				<ChatRow {...props} isStreaming={false} messageActionsDisabled />
			</ExtensionStateContextProvider>,
		)
		expect(restart).toBeDisabled()
		expect(screen.getByRole("button", { name: "Copy" })).toBeEnabled()
		rerender(
			<ExtensionStateContextProvider>
				<ChatRow {...props} isStreaming={false} />
			</ExtensionStateContextProvider>,
		)
		fireEvent.click(restart)
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ value: 3, editedMessageContent: followup.text }),
		)
	})
})
