import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { RequestUserInputForm } from "../RequestUserInputForm"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) =>
			(
				({
					"chat:requestUserInput.title": "Answer the questions",
					"chat:requestUserInput.other": "Other",
					"chat:requestUserInput.otherPlaceholder": "Enter an answer",
					"chat:requestUserInput.cancel": "Cancel",
					"chat:requestUserInput.submit": "Submit answers",
				}) as Record<string, string>
			)[key] ?? key,
	}),
}))

const request = {
	questions: [
		{
			id: "workspace_scope",
			header: "Scope",
			question: "Which workspace should I inspect?",
			options: [
				{ label: "Current workspace (Recommended)", description: "Use the active project folder." },
				{ label: "All workspaces", description: "Include every open project folder." },
			],
		},
		{
			id: "test_level",
			header: "Testing",
			question: "Which validation should I run?",
			options: [
				{ label: "Focused tests", description: "Run tests covering the changed behavior." },
				{ label: "Full suite", description: "Run all tests in the repository." },
			],
		},
	],
}

describe("RequestUserInputForm", () => {
	it("submits one structured response only after every question is answered", () => {
		const onSubmit = vi.fn()
		render(<RequestUserInputForm request={request} onSubmit={onSubmit} />)

		const submit = screen.getByRole("button", { name: "Submit answers" })
		expect(submit).toBeDisabled()
		fireEvent.click(screen.getByRole("radio", { name: /Current workspace \(Recommended\)/ }))
		expect(submit).toBeDisabled()
		fireEvent.click(screen.getByRole("radio", { name: /Focused tests/ }))
		expect(submit).toBeEnabled()
		fireEvent.click(submit)

		expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
			workspace_scope: { answers: ["Current workspace (Recommended)"] },
			test_level: { answers: ["Focused tests"] },
		})
	})

	it("submits free-form Other text for a question", () => {
		const onSubmit = vi.fn()
		render(<RequestUserInputForm request={{ questions: [request.questions[0]!] }} onSubmit={onSubmit} />)

		fireEvent.click(screen.getByRole("radio", { name: "Other" }))
		const otherAnswer = screen.getByRole("textbox", { name: "chat:requestUserInput.otherAnswer" })
		fireEvent.change(otherAnswer, { target: { value: "A linked workspace" } })
		fireEvent.click(screen.getByRole("button", { name: "Submit answers" }))

		expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
			workspace_scope: { answers: ["A linked workspace"] },
		})
	})
})
