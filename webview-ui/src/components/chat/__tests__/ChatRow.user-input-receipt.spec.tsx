import { render, screen } from "@/utils/test-utils"
import type { AlphaMessage } from "@alpha-code/types"
import { describe, expect, it, vi } from "vitest"

import ChatRow, { type ChatRowEnvironment } from "../ChatRow"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
	initReactI18next: { type: "3rdParty", init: () => undefined },
	Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const feedback: AlphaMessage = {
	ts: 43,
	type: "say",
	say: "user_feedback",
	text: "Which environment should I use?\nStaging\n\nWhat deadline should I use?\nFriday\nBefore noon",
	userInputResponse: {
		questions: [
			{ header: "Environment", question: "Which environment should I use?", answers: ["Staging"] },
			{ header: "Deadline", question: "What deadline should I use?", answers: ["Friday", "Before noon"] },
		],
	},
}

const row = (message: AlphaMessage) => {
	const environment: ChatRowEnvironment = {
		mcpServers: [],
		alwaysAllowMcp: false,
		mode: "code",
		reasoningBlockCollapsed: true,
		currentTaskId: "task-a",
		getAlphaMessages: () => [message],
	}
	return (
		<ChatRow
			message={message}
			environment={environment}
			isExpanded
			isLast
			isStreaming={false}
			onToggleExpand={() => undefined}
		/>
	)
}

describe("ChatRow user input receipts", () => {
	it("renders full questions and answers from persisted feedback after remount", () => {
		const { unmount } = render(row(feedback))
		expect(screen.getByTestId("user-input-receipt")).toBeInTheDocument()
		unmount()

		render(row(JSON.parse(JSON.stringify(feedback))))

		expect(screen.getByText("Which environment should I use?")).toBeInTheDocument()
		expect(screen.getByText("What deadline should I use?")).toBeInTheDocument()
		expect(screen.getAllByRole("definition").map((definition) => definition.textContent)).toEqual([
			"Staging",
			"Friday\nBefore noon",
		])
		expect(screen.queryByRole("form")).not.toBeInTheDocument()
	})

	it("keeps historical feedback without receipt metadata readable", () => {
		render(row({ ...feedback, userInputResponse: undefined }))

		expect(screen.queryByTestId("user-input-receipt")).not.toBeInTheDocument()
		expect(screen.getByRole("article", { name: "chat:feedback.youSaid" })).toHaveTextContent(
			/Which environment should I use\? Staging What deadline should I use\? Friday Before noon/,
		)
	})

	it("uses actual edited text instead of stale receipt metadata", () => {
		render(row({ ...feedback, text: "Use a private staging environment instead." }))

		expect(screen.queryByTestId("user-input-receipt")).not.toBeInTheDocument()
		expect(screen.getByText("Use a private staging environment instead.")).toBeInTheDocument()
		expect(screen.queryByText("What deadline should I use?")).not.toBeInTheDocument()
	})

	it("ignores malformed receipt metadata without hiding the feedback", () => {
		const malformed = { ...feedback, userInputResponse: { questions: null } } as unknown as AlphaMessage
		render(row(malformed))

		expect(screen.queryByTestId("user-input-receipt")).not.toBeInTheDocument()
		expect(screen.getByRole("article", { name: "chat:feedback.youSaid" })).toHaveTextContent(
			/Which environment should I use\? Staging What deadline should I use\? Friday Before noon/,
		)
	})
})
