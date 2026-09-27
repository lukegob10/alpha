import { fireEvent, render, screen } from "@/utils/test-utils"
import { describe, expect, it, vi } from "vitest"

import type { AlphaMessage } from "@alpha-code/types"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"

import { ChatRowContent } from "../ChatRow"

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
})
