import { fireEvent, render, screen } from "@/utils/test-utils"
import { describe, expect, it, vi } from "vitest"

import type { AlphaMessage } from "@alpha-code/types"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"

import ChatRow, { ChatRowContent, type ChatRowEnvironment } from "../ChatRow"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, values?: Record<string, string>) =>
			key === "chat:asyncUserInput.answerFor"
				? `Answer for ${values?.question ?? ""}`
				: key === "chat:asyncUserInput.responsePrefix"
					? "Answers to the earlier questions:"
					: key,
	}),
	initReactI18next: { type: "3rdParty", init: () => undefined },
	Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
}))

describe("ChatRow async user input", () => {
	it("renders one question card and returns its response with the message id", () => {
		const onAsyncUserInputSubmit = vi.fn(() => true)
		const message: AlphaMessage = {
			ts: 42,
			type: "say",
			say: "async_user_input",
			asyncUserInput: { questions: [{ title: "Which environment?", options: ["Staging", "Production"] }] },
		}

		render(
			<ExtensionStateContextProvider>
				<ChatRowContent
					message={message}
					isExpanded={false}
					isLast={false}
					isStreaming={false}
					onToggleExpand={() => undefined}
					onAsyncUserInputSubmit={onAsyncUserInputSubmit}
				/>
			</ExtensionStateContextProvider>,
		)

		expect(screen.getByTestId("async-user-input-card")).toBeVisible()
		fireEvent.click(screen.getByRole("radio", { name: "Production" }))
		fireEvent.click(screen.getByRole("button", { name: "chat:asyncUserInput.submit" }))

		expect(onAsyncUserInputSubmit).toHaveBeenCalledExactlyOnceWith(
			42,
			"Answers to the earlier questions:\n\nWhich environment?\nAnswer: Production",
		)
	})

	it("projects pending delivery and rejection into the same card", () => {
		const onAsyncUserInputSubmit = vi.fn(() => true)
		const message: AlphaMessage = {
			ts: 42,
			type: "say",
			say: "async_user_input",
			asyncUserInput: { questions: [{ title: "Which environment?", options: ["Staging", "Production"] }] },
		}
		const row = (isAsyncUserInputPending: boolean) => (
			<ExtensionStateContextProvider>
				<ChatRowContent
					message={message}
					isExpanded={false}
					isLast={false}
					isStreaming={false}
					isAsyncUserInputPending={isAsyncUserInputPending}
					onToggleExpand={() => undefined}
					onAsyncUserInputSubmit={onAsyncUserInputSubmit}
				/>
			</ExtensionStateContextProvider>
		)
		const { rerender } = render(row(false))
		fireEvent.click(screen.getByRole("radio", { name: "Production" }))
		const submit = screen.getByRole("button", { name: "chat:asyncUserInput.submit" })
		fireEvent.click(submit)

		rerender(row(true))
		expect(screen.getByText("chat:asyncUserInput.pending")).toBeInTheDocument()
		expect(screen.queryByText("chat:asyncUserInput.sent")).not.toBeInTheDocument()
		expect(submit).toBeDisabled()
		rerender(row(false))
		expect(submit).toBeEnabled()
		expect(screen.getByRole("radio", { name: "Production" })).toBeChecked()
		fireEvent.click(submit)
		expect(onAsyncUserInputSubmit).toHaveBeenCalledTimes(2)
		expect(onAsyncUserInputSubmit.mock.calls[0]).toEqual(onAsyncUserInputSubmit.mock.calls[1])
	})

	it("does not reuse an answer draft for the same question timestamp in another task", () => {
		const message: AlphaMessage = {
			ts: 42,
			type: "say",
			say: "async_user_input",
			asyncUserInput: { questions: [{ title: "Which environment?", options: ["Staging", "Production"] }] },
		}
		const environment: ChatRowEnvironment = {
			mcpServers: [],
			alwaysAllowMcp: false,
			mode: "code",
			reasoningBlockCollapsed: true,
			currentTaskId: "task-a",
			getAlphaMessages: () => [message],
		}
		const row = (currentTaskId: string) => (
			<ChatRow
				message={message}
				environment={{ ...environment, currentTaskId }}
				isExpanded={false}
				isLast={false}
				isStreaming={false}
				onToggleExpand={() => undefined}
			/>
		)
		const { rerender } = render(row("task-a"))
		fireEvent.click(screen.getByRole("radio", { name: "Production" }))
		rerender(row("task-b"))

		expect(screen.getByRole("radio", { name: "Production" })).not.toBeChecked()
		expect(screen.getByRole("textbox", { name: "Answer for Which environment?" })).toHaveValue("")
		expect(screen.getByRole("button", { name: "chat:asyncUserInput.submit" })).toBeDisabled()
	})
})
