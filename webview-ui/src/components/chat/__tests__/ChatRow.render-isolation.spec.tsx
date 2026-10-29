import type { ReactNode } from "react"
import { fireEvent, render, screen } from "@/utils/test-utils"
import type { AlphaMessage } from "@alpha-code/types"

import ChatRow, { type ChatRowEnvironment } from "../ChatRow"

const mockUseExtensionState = vi.fn(() => {
	throw new Error("virtualized rows must not subscribe to root extension state")
})

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => mockUseExtensionState(),
}))

vi.mock("../ChatTextArea", () => ({
	ChatTextArea: ({ selectedImages, onCancel }: { selectedImages: string[]; onCancel?: () => void }) => (
		<>
			<output aria-label="Edit attachments">{selectedImages.join("\n")}</output>
			<button onClick={onCancel}>Cancel edit</button>
		</>
	),
}))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
		i18n: { exists: () => true },
	}),
	Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

describe("ChatRow render isolation", () => {
	afterEach(() => vi.restoreAllMocks())

	it("keeps inactive rows off the streamed message event path", () => {
		const messages: AlphaMessage[] = Array.from({ length: 100 }, (_, ts) => ({
			ts,
			type: "say",
			say: "text",
			text: `Completed response ${ts}`,
			partial: false,
		}))
		const environment: ChatRowEnvironment = {
			mcpServers: [],
			alwaysAllowMcp: false,
			mode: "code",
			reasoningBlockCollapsed: true,
			getAlphaMessages: () => messages,
		}
		const addListener = vi.spyOn(window, "addEventListener")
		const readEventType = vi.fn(() => "partialMessage")
		const { unmount } = render(
			<>
				{messages.map((message) => (
					<ChatRow
						key={message.ts}
						message={message}
						environment={environment}
						isExpanded={false}
						isLast={false}
						isStreaming={false}
						onToggleExpand={() => {}}
					/>
				))}
			</>,
		)

		expect(screen.getByText("Completed response 99")).toBeInTheDocument()
		expect(addListener.mock.calls.filter(([type]) => type === "message")).toHaveLength(0)
		for (let update = 0; update < 20; update++) {
			fireEvent(
				window,
				new MessageEvent("message", {
					data: {
						get type() {
							return readEventType()
						},
					},
				}),
			)
		}
		expect(readEventType).not.toHaveBeenCalled()
		unmount()
	})

	it("receives matching edit images and releases the listener on cancel and unmount", () => {
		const message: AlphaMessage = { ts: 42, type: "say", say: "user_feedback", text: "Edit this prompt" }
		const environment: ChatRowEnvironment = {
			mcpServers: [],
			alwaysAllowMcp: false,
			mode: "code",
			currentTaskId: "edited-task",
			reasoningBlockCollapsed: true,
			getAlphaMessages: () => [message],
		}
		const addListener = vi.spyOn(window, "addEventListener")
		const removeListener = vi.spyOn(window, "removeEventListener")
		const messageListeners = () => addListener.mock.calls.filter(([type]) => type === "message")
		const { unmount } = render(
			<ChatRow
				message={message}
				environment={environment}
				isExpanded={false}
				isLast={false}
				isStreaming={false}
				onToggleExpand={() => {}}
			/>,
		)
		const selectImages = (context: string, messageTs: number) =>
			fireEvent(
				window,
				new MessageEvent("message", {
					data: { type: "selectedImages", context, messageTs, images: ["data:image/png;base64,YQ=="] },
				}),
			)

		expect(messageListeners()).toHaveLength(0)
		fireEvent.click(screen.getByRole("button", { name: "chat:messageActions.edit" }))
		expect(messageListeners()).toHaveLength(1)
		const firstListener = messageListeners()[0][1]
		selectImages("composer", message.ts)
		selectImages("edit", message.ts + 1)
		expect(screen.getByLabelText("Edit attachments")).toBeEmptyDOMElement()
		selectImages("edit", message.ts)
		expect(screen.getByLabelText("Edit attachments")).toHaveTextContent("data:image/png;base64,YQ==")

		fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }))
		expect(removeListener).toHaveBeenCalledWith("message", firstListener)
		expect(messageListeners()).toHaveLength(1)
		selectImages("edit", message.ts)
		fireEvent.click(screen.getByRole("button", { name: "chat:messageActions.edit" }))
		expect(screen.getByLabelText("Edit attachments")).toBeEmptyDOMElement()
		expect(messageListeners()).toHaveLength(2)
		const secondListener = messageListeners()[1][1]
		unmount()
		expect(removeListener).toHaveBeenCalledWith("message", secondListener)
	})

	it.each(["completed", "interrupted", "failed", undefined] as const)(
		"keeps the report's %s terminal attribution when the current task status changes",
		(terminalStatus) => {
			const message: AlphaMessage = {
				ts: 2,
				type: "say",
				say: "completion_result",
				text: "A historical response.",
				partial: false,
				...(terminalStatus === undefined
					? {}
					: { turn: { runId: "run-one", turnId: "turn-one", terminalStatus } }),
			}
			const environment: ChatRowEnvironment = {
				mcpServers: [],
				alwaysAllowMcp: false,
				mode: "code",
				reasoningBlockCollapsed: true,
				currentTaskId: "original-task",
				currentTaskItem: {
					id: "original-task",
					status: "active",
				},
				getAlphaMessages: () => [message],
			}
			const row = (nextEnvironment: ChatRowEnvironment) => (
				<ChatRow
					message={message}
					environment={nextEnvironment}
					isExpanded={false}
					isLast={true}
					isStreaming={false}
					onToggleExpand={() => {}}
				/>
			)
			const { rerender } = render(row(environment))
			const label = terminalStatus === "completed" ? "chat:taskCompleted" : "chat:completionReport"
			expect(screen.getByRole("article", { name: label })).toBeInTheDocument()
			expect(screen.getByText(message.text!)).toBeInTheDocument()
			const completed = { ...environment.currentTaskItem!, status: "completed" as const }
			rerender(row({ ...environment, currentTaskItem: completed }))
			expect(screen.getByRole("article", { name: label })).toBeInTheDocument()
			rerender(row({ ...environment, currentTaskItem: { ...completed, status: "interrupted" } }))
			expect(screen.getByRole("article", { name: label })).toBeInTheDocument()
			rerender(row({ ...environment, currentTaskItem: { ...completed, id: "another-task" } }))
			expect(screen.getByRole("article", { name: label })).toBeInTheDocument()
			if (terminalStatus !== "completed")
				expect(screen.queryByRole("article", { name: "chat:taskCompleted" })).not.toBeInTheDocument()
			expect(mockUseExtensionState).not.toHaveBeenCalled()
		},
	)

	it("keeps a partial completion report neutral before its terminal row is accepted", () => {
		const message: AlphaMessage = {
			ts: 2,
			type: "say",
			say: "completion_result",
			text: "Still streaming",
			partial: true,
			turn: { runId: "run-one", turnId: "turn-one", terminalStatus: "completed" },
		}
		render(
			<ChatRow
				message={message}
				environment={{
					mcpServers: [],
					alwaysAllowMcp: false,
					mode: "code",
					reasoningBlockCollapsed: true,
					getAlphaMessages: () => [message],
				}}
				isExpanded={false}
				isLast={true}
				isStreaming={true}
				onToggleExpand={() => {}}
			/>,
		)
		expect(screen.getByRole("article", { name: "chat:completionReport" })).toBeInTheDocument()
		expect(screen.queryByRole("article", { name: "chat:taskCompleted" })).not.toBeInTheDocument()
	})

	it("renders from its stable environment without reading root transcript state", () => {
		const message: AlphaMessage = {
			ts: 1,
			type: "say",
			say: "text",
			text: "completed response",
			partial: false,
		}
		const environment: ChatRowEnvironment = {
			mcpServers: [],
			alwaysAllowMcp: false,
			mode: "code",
			reasoningBlockCollapsed: true,
			modelSupportsImages: true,
			getAlphaMessages: () => [message],
		}

		render(
			<ChatRow
				message={message}
				environment={environment}
				isExpanded={false}
				isLast={false}
				isStreaming={false}
				onToggleExpand={() => {}}
			/>,
		)

		expect(screen.getByText("completed response")).toBeInTheDocument()
		expect(mockUseExtensionState).not.toHaveBeenCalled()
	})
})
