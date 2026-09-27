import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { AsyncUserInputCard } from "../AsyncUserInputCard"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, values?: Record<string, string>) =>
			key === "chat:asyncUserInput.answerFor"
				? `Answer for ${values?.question ?? ""}`
				: ((
						{
							"chat:asyncUserInput.title": "Questions from the assistant",
							"chat:asyncUserInput.responsePrefix": "Answers to the earlier questions:",
							"chat:asyncUserInput.freeText": "Or enter an answer",
							"chat:asyncUserInput.replyHelp": "Answers are sent as your next message.",
							"chat:asyncUserInput.submit": "Send answers",
							"chat:asyncUserInput.sent": "Answers sent",
						} as Record<string, string>
					)[key] ?? key),
	}),
}))

const request = {
	questions: [
		{ title: "Which environment should I use?", options: ["Staging", "Production"] },
		{ title: "What deadline should I use?" },
	],
}

describe("AsyncUserInputCard", () => {
	it("waits for explicit submission and sends all answers as ordinary text", () => {
		const onSubmit = vi.fn(() => true)
		render(<AsyncUserInputCard request={request} onSubmit={onSubmit} />)

		const submit = screen.getByRole("button", { name: "Send answers" })
		expect(submit).toBeDisabled()
		fireEvent.click(screen.getByRole("radio", { name: "Production" }))
		fireEvent.change(screen.getByRole("textbox", { name: "Answer for What deadline should I use?" }), {
			target: { value: "Friday" },
		})
		expect(submit).toBeEnabled()
		expect(onSubmit).not.toHaveBeenCalled()
		fireEvent.click(submit)

		expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
			"Answers to the earlier questions:\n\nWhich environment should I use?\nAnswer: Production\n\nWhat deadline should I use?\nAnswer: Friday",
		)
		expect(submit).toBeDisabled()
	})

	it("keeps answers editable when the parent rejects a submission", () => {
		const onSubmit = vi.fn(() => false)
		render(<AsyncUserInputCard request={request} onSubmit={onSubmit} />)

		const answer = screen.getByRole("radio", { name: "Production" })
		fireEvent.click(answer)
		fireEvent.change(screen.getByRole("textbox", { name: "Answer for What deadline should I use?" }), {
			target: { value: "Friday" },
		})
		const submit = screen.getByRole("button", { name: "Send answers" })
		fireEvent.click(submit)

		expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
			"Answers to the earlier questions:\n\nWhich environment should I use?\nAnswer: Production\n\nWhat deadline should I use?\nAnswer: Friday",
		)
		expect(answer).toBeEnabled()
		expect(screen.queryByText("Answers sent")).not.toBeInTheDocument()
	})

	it("renders previously answered cards as sent", () => {
		const onSubmit = vi.fn()
		render(<AsyncUserInputCard request={request} isAnswered onSubmit={onSubmit} />)

		expect(screen.getByText("Answers sent")).toBeInTheDocument()
		expect(screen.getByRole("radio", { name: "Production" })).toBeDisabled()
		expect(screen.getByRole("textbox", { name: "Answer for Which environment should I use?" })).toBeDisabled()
		expect(screen.getByRole("button", { name: "Send answers" })).toBeDisabled()
	})

	it("keeps radio groups independent when two cards are visible together", () => {
		const onSubmit = vi.fn()
		render(
			<>
				<AsyncUserInputCard request={request} onSubmit={onSubmit} />
				<AsyncUserInputCard request={request} onSubmit={onSubmit} />
			</>,
		)

		const [firstCard, secondCard] = screen.getAllByTestId("async-user-input-card")
		const firstProduction = within(firstCard!).getByRole("radio", { name: "Production" })
		const secondStaging = within(secondCard!).getByRole("radio", { name: "Staging" })

		fireEvent.click(firstProduction)
		fireEvent.click(secondStaging)

		expect(firstProduction).toBeChecked()
		expect(secondStaging).toBeChecked()
		expect(within(firstCard!).getByRole("radio", { name: "Staging" })).not.toBeChecked()
		expect(within(secondCard!).getByRole("radio", { name: "Production" })).not.toBeChecked()
	})
})
