import { fireEvent, render, screen } from "@/utils/test-utils"
import { describe, expect, it, vi } from "vitest"

import type { AlphaMessage } from "@alpha-code/types"

import ChatRow, { type ChatRowEnvironment } from "../ChatRow"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
	initReactI18next: { type: "3rdParty", init: () => undefined },
	Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/context/ExtensionStateContext", async (importOriginal) => ({
	...(await importOriginal<typeof import("@src/context/ExtensionStateContext")>()),
	useShellState: () => ({
		autoApprovalEnabled: false,
		alwaysAllowFollowupQuestions: false,
		followupAutoApproveTimeoutMs: 60_000,
	}),
}))

const message: AlphaMessage = {
	ts: 42,
	type: "ask",
	ask: "followup",
	text: JSON.stringify({
		requestUserInput: {
			questions: [
				{
					id: "environment",
					header: "Environment",
					question: "Which environment should I use?",
					options: [
						{ label: "Staging", description: "Use the staging environment." },
						{ label: "Production", description: "Use the production environment." },
					],
				},
			],
		},
	}),
}

describe("ChatRow grouped user input", () => {
	const row = (
		text: string,
		onSuggestionClick = vi.fn(),
		onSubmit = vi.fn(),
		onCancel?: (askMessageTs: number) => void,
	) => {
		const currentMessage = { ...message, text }
		const environment: ChatRowEnvironment = {
			mcpServers: [],
			alwaysAllowMcp: false,
			mode: "code",
			reasoningBlockCollapsed: true,
			currentTaskId: "task-a",
			getAlphaMessages: () => [currentMessage],
		}
		return (
			<ChatRow
				message={currentMessage}
				environment={environment}
				isExpanded={false}
				isLast
				isStreaming={false}
				onToggleExpand={() => undefined}
				onSuggestionClick={onSuggestionClick}
				onRequestUserInputSubmit={onSubmit}
				onRequestUserInputCancel={onCancel}
			/>
		)
	}

	it.each([
		{ name: "null questions", requestUserInput: { questions: null } },
		{
			name: "null option",
			requestUserInput: {
				questions: [
					{
						id: "environment",
						header: "Environment",
						question: "Which environment should I use?",
						options: [null],
					},
				],
			},
		},
	])("ignores malformed persisted input with $name without crashing the chat", ({ requestUserInput }) => {
		render(row(JSON.stringify({ requestUserInput })))

		expect(screen.getByText("chat:questions.hasQuestion")).toBeInTheDocument()
		expect(screen.queryByRole("form")).not.toBeInTheDocument()
		expect(screen.queryByRole("radio")).not.toBeInTheDocument()
	})

	it("keeps ordinary follow-up questions and suggested answers", () => {
		const suggestion = { answer: "Use staging" }
		const onSuggestionClick = vi.fn()
		render(
			row(
				JSON.stringify({ question: "Which environment should I use?", suggest: [suggestion] }),
				onSuggestionClick,
			),
		)

		expect(screen.getByText("Which environment should I use?")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Use staging" }))
		expect(onSuggestionClick).toHaveBeenCalledWith(suggestion, expect.anything())
	})

	it("keeps valid grouped questions and structured submission", () => {
		const onSubmit = vi.fn()
		render(row(message.text!, undefined, onSubmit))

		expect(screen.getByText("Which environment should I use?")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("radio", { name: /Staging/ }))
		fireEvent.click(screen.getByRole("button", { name: "chat:requestUserInput.review" }))
		fireEvent.click(screen.getByRole("button", { name: "chat:requestUserInput.submit" }))
		expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ environment: { answers: ["Staging"] } }, message.ts)
	})

	it("keeps the review editable when the host rejects the submission", () => {
		const onSubmit = vi.fn(() => false)
		render(row(message.text!, undefined, onSubmit))
		fireEvent.click(screen.getByRole("radio", { name: /Staging/ }))
		fireEvent.click(screen.getByRole("button", { name: "chat:requestUserInput.review" }))
		fireEvent.click(screen.getByRole("button", { name: "chat:requestUserInput.submit" }))

		expect(screen.getByRole("button", { name: "chat:requestUserInput.submit" })).toBeEnabled()
		expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ environment: { answers: ["Staging"] } }, message.ts)
	})

	it("cancels only the native request represented by this row", () => {
		const onCancel = vi.fn()
		const onSubmit = vi.fn()
		render(row(message.text!, undefined, onSubmit, onCancel))
		fireEvent.click(screen.getByRole("button", { name: "chat:requestUserInput.cancel" }))

		expect(onCancel).toHaveBeenCalledExactlyOnceWith(message.ts)
		expect(onSubmit).not.toHaveBeenCalled()
	})

	it("collapses a closed native question instead of leaving its form and active header", () => {
		const currentMessage = { ...message, isAnswered: true }
		const environment: ChatRowEnvironment = {
			mcpServers: [],
			alwaysAllowMcp: false,
			mode: "code",
			reasoningBlockCollapsed: true,
			currentTaskId: "task-a",
			getAlphaMessages: () => [currentMessage],
		}
		render(
			<ChatRow
				message={currentMessage}
				environment={environment}
				isExpanded={false}
				isLast
				isStreaming={false}
				isFollowUpAnswered
				onToggleExpand={() => undefined}
			/>,
		)

		expect(screen.queryByRole("form")).not.toBeInTheDocument()
		expect(screen.queryByRole("radio")).not.toBeInTheDocument()
		expect(screen.queryByText("chat:questions.hasQuestion")).not.toBeInTheDocument()
	})

	it.each([
		{ name: "another task with the same timestamp", taskId: "task-b", ts: 42 },
		{ name: "another question in the same task", taskId: "task-a", ts: 43 },
	])("does not reuse an answer draft for $name", ({ taskId, ts }) => {
		const onInteraction = vi.fn()
		const onSubmit = vi.fn()
		const row = (currentTaskId: string, messageTs: number) => {
			const currentMessage = { ...message, ts: messageTs }
			const environment: ChatRowEnvironment = {
				mcpServers: [],
				alwaysAllowMcp: false,
				mode: "code",
				reasoningBlockCollapsed: true,
				currentTaskId,
				getAlphaMessages: () => [currentMessage],
			}
			return (
				<ChatRow
					message={currentMessage}
					environment={environment}
					isExpanded={false}
					isLast
					isStreaming={false}
					onToggleExpand={() => undefined}
					onRequestUserInputSubmit={onSubmit}
					onFollowUpUnmount={onInteraction}
				/>
			)
		}
		const { rerender } = render(row("task-a", 42))
		fireEvent.click(screen.getByRole("radio", { name: "chat:requestUserInput.other" }))
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "A private testing environment" } })
		expect(screen.getByRole("button", { name: "chat:requestUserInput.review" })).toBeEnabled()

		rerender(row(taskId, ts))

		expect(screen.getByRole("radio", { name: "chat:requestUserInput.other" })).not.toBeChecked()
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: "chat:requestUserInput.review" })).toBeDisabled()
		fireEvent.click(screen.getByRole("radio", { name: /Staging/ }))
		expect(onInteraction).toHaveBeenCalledTimes(2)
	})
})
