import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { RequestUserInputForm } from "../RequestUserInputForm"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, values?: Record<string, string | number>) => {
			const text = {
				"chat:requestUserInput.title": "Answer the questions",
				"chat:requestUserInput.intro": "One question at a time. You can go back to any answer.",
				"chat:requestUserInput.progress": "{{answered}} of {{total}} answered",
				"chat:requestUserInput.questions": "Questions",
				"chat:requestUserInput.stepLabel": "{{header}}, question {{index}} of {{total}}",
				"chat:requestUserInput.other": "Write your own",
				"chat:requestUserInput.otherAnswer": "Custom answer for {{header}}, question {{index}}",
				"chat:requestUserInput.otherPlaceholder": "Enter an answer",
				"chat:requestUserInput.otherDescription": "Add a different answer in your own words.",
				"chat:requestUserInput.recommended": "Recommended",
				"chat:requestUserInput.cancel": "Cancel",
				"chat:requestUserInput.back": "Back",
				"chat:requestUserInput.continue": "Continue",
				"chat:requestUserInput.review": "Review answers",
				"chat:requestUserInput.reviewTitle": "Review your answers",
				"chat:requestUserInput.reviewDescription": "You can edit any answer before sending.",
				"chat:requestUserInput.edit": "Edit",
				"chat:requestUserInput.editQuestion": "Edit answer for {{header}}",
				"chat:requestUserInput.submit": "Send answers",
				"chat:requestUserInput.closed": "Question request closed",
				"chat:requestUserInput.pending": "Sending answers…",
				"chat:requestUserInput.sendFailed": "Could not send your answers. You can try again.",
			} as Record<string, string>
			const translation = text[key] ?? key
			return Object.entries(values ?? {}).reduce(
				(result, [name, value]) => result.replace(`{{${name}}}`, String(value)),
				translation,
			)
		},
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
	const originalFocus = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "focus")!
	let focusFrame: HTMLIFrameElement
	beforeEach(() => {
		// The shared FAST setup stubs focus. Use the untouched JSDOM implementation to test real focus ownership.
		focusFrame = document.createElement("iframe")
		document.body.append(focusFrame)
		Object.defineProperty(HTMLElement.prototype, "focus", {
			configurable: true,
			value: focusFrame.contentDocument!.createElement("button").focus,
		})
	})
	afterEach(() => {
		Object.defineProperty(HTMLElement.prototype, "focus", originalFocus)
		focusFrame.remove()
	})

	const completeQuestions = () => {
		fireEvent.click(screen.getByRole("radio", { name: "Current workspace (Recommended)" }))
		fireEvent.click(screen.getByRole("button", { name: "Continue" }))
		fireEvent.click(screen.getByRole("radio", { name: "Focused tests" }))
		fireEvent.click(screen.getByRole("button", { name: "Review answers" }))
	}

	it("shows one question at a time and submits one packet only after reviewing every answer", () => {
		const onSubmit = vi.fn()
		render(<RequestUserInputForm request={request} onSubmit={onSubmit} />)

		expect(screen.getByRole("heading", { name: request.questions[0]!.question })).toBeInTheDocument()
		expect(screen.queryByText(request.questions[1]!.question)).not.toBeInTheDocument()
		expect(screen.getByText("0 of 2 answered")).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled()
		expect(screen.getByRole("button", { name: "Testing, question 2 of 2" })).toBeDisabled()
		fireEvent.submit(screen.getByRole("form"))
		expect(onSubmit).not.toHaveBeenCalled()

		fireEvent.click(screen.getByRole("radio", { name: "Current workspace (Recommended)" }))
		expect(screen.getByText("1 of 2 answered")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Continue" }))
		expect(screen.queryByText(request.questions[0]!.question)).not.toBeInTheDocument()
		expect(screen.getByRole("heading", { name: request.questions[1]!.question })).toHaveFocus()
		expect(onSubmit).not.toHaveBeenCalled()

		fireEvent.click(screen.getByRole("radio", { name: "Focused tests" }))
		expect(screen.getByText("2 of 2 answered")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Review answers" }))
		expect(screen.getByRole("heading", { name: "Review your answers" })).toHaveFocus()
		for (const question of request.questions) expect(screen.getByText(question.question)).toBeInTheDocument()
		expect(screen.getByText("Current workspace (Recommended)")).toBeInTheDocument()
		expect(screen.getByText("Focused tests")).toBeInTheDocument()
		expect(screen.queryByRole("radio")).not.toBeInTheDocument()
		expect(onSubmit).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole("button", { name: "Send answers" }))

		expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
			workspace_scope: { answers: ["Current workspace (Recommended)"] },
			test_level: { answers: ["Focused tests"] },
		})
	})

	it("reviews and submits multiline free-form text for a single question", () => {
		const onSubmit = vi.fn()
		render(<RequestUserInputForm request={{ questions: [request.questions[0]!] }} onSubmit={onSubmit} />)

		fireEvent.click(screen.getByRole("radio", { name: "Write your own" }))
		const otherAnswer = screen.getByRole("textbox", { name: "Custom answer for Scope, question 1" })
		expect(otherAnswer.tagName).toBe("TEXTAREA")
		fireEvent.change(otherAnswer, { target: { value: "  A linked workspace\nInclude the shared package  " } })
		fireEvent.click(screen.getByRole("button", { name: "Review answers" }))
		expect(onSubmit).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole("button", { name: "Send answers" }))

		expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
			workspace_scope: { answers: ["A linked workspace\nInclude the shared package"] },
		})
	})

	it("supports a constructor question id without inheriting an incomplete answer draft", () => {
		const onSubmit = vi.fn()
		const constructorRequest = { questions: [{ ...request.questions[0]!, id: "constructor" }] }
		render(<RequestUserInputForm request={constructorRequest} onSubmit={onSubmit} />)

		fireEvent.click(screen.getByRole("radio", { name: "Write your own" }))
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "Inspect the linked workspace" } })
		fireEvent.click(screen.getByRole("button", { name: "Review answers" }))
		expect(screen.getByText("Inspect the linked workspace")).toBeVisible()
		fireEvent.click(screen.getByRole("button", { name: "Send answers" }))

		expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
			constructor: { answers: ["Inspect the linked workspace"] },
		})
	})

	it("keeps a draft when the same questions are refreshed", () => {
		const onSubmit = vi.fn()
		const onInteraction = vi.fn()
		const currentRequest = { questions: [request.questions[0]!] }
		const { rerender } = render(
			<RequestUserInputForm request={currentRequest} onSubmit={onSubmit} onInteraction={onInteraction} />,
		)
		fireEvent.click(screen.getByRole("radio", { name: "Write your own" }))
		const customAnswer = screen.getByRole("textbox")
		fireEvent.change(customAnswer, { target: { value: "A linked workspace" } })
		expect(customAnswer).toHaveFocus()

		rerender(
			<RequestUserInputForm
				request={JSON.parse(JSON.stringify(currentRequest))}
				onSubmit={onSubmit}
				onInteraction={onInteraction}
			/>,
		)

		expect(screen.getByRole("textbox")).toHaveValue("A linked workspace")
		expect(screen.getByRole("radio", { name: "Write your own" })).toBeChecked()
		expect(screen.getByRole("textbox")).toHaveFocus()
		expect(screen.getByRole("button", { name: "Review answers" })).toBeEnabled()
		expect(onInteraction).toHaveBeenCalledTimes(1)
	})

	it.each([
		{
			name: "prompt",
			question: { ...request.questions[0]!, question: "Which workspace should I modify?" },
		},
		{
			name: "options",
			question: {
				...request.questions[0]!,
				options: [
					{ label: "Linked workspace", description: "Use a linked project folder." },
					{ label: "A new workspace", description: "Create a new project folder." },
				],
			},
		},
	])("clears the previous draft when the $name changes with the same question id", ({ question }) => {
		const onSubmit = vi.fn()
		const onInteraction = vi.fn()
		const { rerender } = render(
			<RequestUserInputForm
				request={{ questions: [request.questions[0]!] }}
				onSubmit={onSubmit}
				onInteraction={onInteraction}
			/>,
		)
		fireEvent.click(screen.getByRole("radio", { name: /Current workspace/ }))
		expect(screen.getByRole("button", { name: "Review answers" })).toBeEnabled()

		rerender(
			<RequestUserInputForm
				request={{ questions: [question] }}
				onSubmit={onSubmit}
				onInteraction={onInteraction}
			/>,
		)

		for (const radio of screen.getAllByRole("radio")) expect(radio).not.toBeChecked()
		expect(screen.getByRole("button", { name: "Review answers" })).toBeDisabled()
		fireEvent.submit(screen.getByRole("form"))
		expect(onSubmit).not.toHaveBeenCalled()
		fireEvent.click(screen.getAllByRole("radio")[0]!)
		expect(onInteraction).toHaveBeenCalledTimes(2)
	})

	it("rejects blank Other text and trims a valid answer", () => {
		const onSubmit = vi.fn()
		render(<RequestUserInputForm request={{ questions: [request.questions[0]!] }} onSubmit={onSubmit} />)
		fireEvent.click(screen.getByRole("radio", { name: "Write your own" }))
		const answer = screen.getByRole("textbox")
		fireEvent.change(answer, { target: { value: "   " } })
		expect(screen.getByRole("button", { name: "Review answers" })).toBeDisabled()
		fireEvent.submit(screen.getByRole("form"))
		expect(onSubmit).not.toHaveBeenCalled()

		fireEvent.change(answer, { target: { value: "  A linked workspace  " } })
		fireEvent.submit(screen.getByRole("form"))
		expect(onSubmit).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole("button", { name: "Send answers" }))
		expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ workspace_scope: { answers: ["A linked workspace"] } })
	})

	it("collapses closed requests without implying that cancellation sent answers", () => {
		const onSubmit = vi.fn()
		const onCancel = vi.fn()
		const currentRequest = { questions: [request.questions[0]!] }
		const { rerender } = render(
			<RequestUserInputForm request={currentRequest} onSubmit={onSubmit} onCancel={onCancel} />,
		)
		fireEvent.click(screen.getByRole("radio", { name: "Write your own" }))
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "A linked workspace" } })

		rerender(<RequestUserInputForm request={currentRequest} isAnswered onSubmit={onSubmit} onCancel={onCancel} />)
		expect(screen.getByRole("status")).toHaveTextContent("Question request closed")
		expect(screen.queryByRole("form")).not.toBeInTheDocument()
		expect(screen.queryByRole("radio")).not.toBeInTheDocument()
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
		expect(screen.queryByRole("button")).not.toBeInTheDocument()
		expect(onSubmit).not.toHaveBeenCalled()
		expect(onCancel).not.toHaveBeenCalled()
	})

	it("retains all historical questions and options behind a collapsed read-only request", () => {
		const onSubmit = vi.fn()
		const onCancel = vi.fn()
		const onInteraction = vi.fn()
		render(
			<RequestUserInputForm
				request={request}
				isAnswered
				onSubmit={onSubmit}
				onCancel={onCancel}
				onInteraction={onInteraction}
			/>,
		)

		const closedStatus = screen.getByRole("status")
		expect(closedStatus).toHaveTextContent("Question request closed")
		const disclosure = closedStatus.closest("details")!
		expect(disclosure).not.toHaveAttribute("open")
		for (const item of request.questions) expect(screen.getByText(item.question)).not.toBeVisible()
		fireEvent.click(disclosure.querySelector("summary")!)
		expect(disclosure).toHaveAttribute("open")
		for (const item of request.questions) {
			expect(screen.getByText(item.question)).toBeVisible()
			for (const option of item.options) {
				expect(screen.getByText(option.label)).toBeVisible()
				expect(screen.getByText(option.description)).toBeVisible()
			}
		}
		expect(screen.queryByRole("form")).not.toBeInTheDocument()
		expect(screen.queryByRole("radio")).not.toBeInTheDocument()
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
		expect(screen.queryByRole("button")).not.toBeInTheDocument()
		expect(onSubmit).not.toHaveBeenCalled()
		expect(onCancel).not.toHaveBeenCalled()
		expect(onInteraction).not.toHaveBeenCalled()
	})

	it("cancels without submitting an incomplete response", () => {
		const onSubmit = vi.fn()
		const onCancel = vi.fn()
		render(<RequestUserInputForm request={request} onSubmit={onSubmit} onCancel={onCancel} />)
		fireEvent.click(screen.getByRole("radio", { name: /Current workspace/ }))
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

		expect(onCancel).toHaveBeenCalledTimes(1)
		expect(onSubmit).not.toHaveBeenCalled()
	})

	it("preserves a custom draft when switching to a suggestion and back", () => {
		render(<RequestUserInputForm request={{ questions: [request.questions[0]!] }} onSubmit={vi.fn()} />)
		fireEvent.click(screen.getByRole("radio", { name: "Write your own" }))
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "Include the linked workspace" } })
		fireEvent.click(screen.getByRole("radio", { name: "All workspaces" }))
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("radio", { name: "Write your own" }))

		expect(screen.getByRole("textbox")).toHaveValue("Include the linked workspace")
		expect(screen.getByRole("textbox")).toHaveFocus()
		expect(screen.getByText("1 of 1 answered")).toBeInTheDocument()
	})

	it("keeps custom answers when going back and editing from review", () => {
		const onSubmit = vi.fn()
		render(<RequestUserInputForm request={request} onSubmit={onSubmit} />)
		fireEvent.click(screen.getByRole("radio", { name: "Write your own" }))
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "Linked workspace" } })
		fireEvent.click(screen.getByRole("button", { name: "Continue" }))
		fireEvent.click(screen.getByRole("radio", { name: "Focused tests" }))
		fireEvent.click(screen.getByRole("button", { name: "Back" }))
		expect(screen.getByRole("heading", { name: request.questions[0]!.question })).toHaveFocus()
		expect(screen.getByRole("textbox")).toHaveValue("Linked workspace")
		expect(screen.getByText("2 of 2 answered")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Testing, question 2 of 2" }))
		fireEvent.click(screen.getByRole("button", { name: "Review answers" }))
		fireEvent.click(screen.getByRole("button", { name: "Edit answer for Scope" }))
		expect(screen.getByRole("heading", { name: request.questions[0]!.question })).toHaveFocus()
		expect(screen.getByRole("textbox")).toHaveValue("Linked workspace")
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "Linked workspace with shared packages" } })
		fireEvent.click(screen.getByRole("button", { name: "Review answers" }))
		fireEvent.click(screen.getByRole("button", { name: "Send answers" }))

		expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
			workspace_scope: { answers: ["Linked workspace with shared packages"] },
			test_level: { answers: ["Focused tests"] },
		})
	})

	it("focuses headings after navigation and keeps the custom textarea focused while typing", () => {
		render(<RequestUserInputForm request={request} onSubmit={vi.fn()} />)
		completeQuestions()
		expect(screen.getByRole("heading", { name: "Review your answers" })).toHaveFocus()
		fireEvent.click(screen.getByRole("button", { name: "Back" }))
		expect(screen.getByRole("heading", { name: request.questions[1]!.question })).toHaveFocus()
		fireEvent.click(screen.getByRole("button", { name: "Back" }))
		expect(screen.getByRole("heading", { name: request.questions[0]!.question })).toHaveFocus()
		fireEvent.click(screen.getByRole("radio", { name: "Write your own" }))
		const textarea = screen.getByRole("textbox")
		expect(textarea).toHaveFocus()
		fireEvent.change(textarea, { target: { value: "Linked" } })
		fireEvent.change(textarea, { target: { value: "Linked workspace" } })
		expect(textarea).toHaveFocus()
	})

	it("separates the Recommended badge visually and preserves the original submitted label", () => {
		const onSubmit = vi.fn()
		render(<RequestUserInputForm request={{ questions: [request.questions[0]!] }} onSubmit={onSubmit} />)
		expect(screen.getByText("Current workspace")).toBeInTheDocument()
		expect(screen.getByText("Recommended")).toBeInTheDocument()
		expect(screen.queryByText("Current workspace (Recommended)")).not.toBeInTheDocument()
		const radio = screen.getByRole("radio", { name: "Current workspace (Recommended)" })
		expect(radio).toHaveAttribute("value", "Current workspace (Recommended)")
		fireEvent.click(radio)
		fireEvent.click(screen.getByRole("button", { name: "Review answers" }))
		fireEvent.click(screen.getByRole("button", { name: "Send answers" }))
		expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
			workspace_scope: { answers: ["Current workspace (Recommended)"] },
		})
	})

	it("retains review and allows retry when submission is rejected", () => {
		const onSubmit = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
		render(<RequestUserInputForm request={request} onSubmit={onSubmit} />)
		completeQuestions()
		fireEvent.click(screen.getByRole("button", { name: "Send answers" }))
		expect(screen.getByRole("alert")).toHaveTextContent("Could not send your answers. You can try again.")
		expect(screen.getByRole("button", { name: "Send answers" })).toBeEnabled()
		expect(screen.getByText("Current workspace (Recommended)")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Send answers" }))
		expect(onSubmit).toHaveBeenCalledTimes(2)
		expect(onSubmit.mock.calls[1]).toEqual(onSubmit.mock.calls[0])
		expect(screen.getByRole("status")).toHaveTextContent("Sending answers…")
	})

	it.each([true, undefined])("locks duplicate submissions when the callback accepts with %s", (acceptance) => {
		const onSubmit = vi.fn(() => acceptance)
		render(<RequestUserInputForm request={request} onSubmit={onSubmit} />)
		completeQuestions()
		const form = screen.getByRole("form")
		act(() => {
			fireEvent.submit(form)
			fireEvent.submit(form)
		})
		expect(onSubmit).toHaveBeenCalledTimes(1)
		expect(screen.queryByRole("form")).not.toBeInTheDocument()
	})

	it("reopens the retained review when the host rejects an optimistic answer acknowledgement", () => {
		const onSubmit = vi.fn(() => true)
		const { rerender } = render(<RequestUserInputForm request={request} onSubmit={onSubmit} />)
		completeQuestions()
		fireEvent.click(screen.getByRole("button", { name: "Send answers" }))
		rerender(<RequestUserInputForm request={request} isAnswered onSubmit={onSubmit} />)
		expect(screen.getByRole("status")).toHaveTextContent("Question request closed")
		rerender(<RequestUserInputForm request={request} isAnswered={false} onSubmit={onSubmit} />)
		expect(screen.getByRole("heading", { name: "Review your answers" })).toHaveFocus()
		expect(screen.getByText("Current workspace (Recommended)")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Send answers" }))
		expect(onSubmit).toHaveBeenCalledTimes(2)
	})

	it("updates the answered count when an edited custom answer becomes incomplete", () => {
		render(<RequestUserInputForm request={request} onSubmit={vi.fn()} />)
		completeQuestions()
		fireEvent.click(screen.getByRole("button", { name: "Edit answer for Testing" }))
		fireEvent.click(screen.getByRole("radio", { name: "Write your own" }))
		expect(screen.getByText("1 of 2 answered")).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Review answers" })).toBeDisabled()
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "  " } })
		expect(screen.getByText("1 of 2 answered")).toBeInTheDocument()
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "Run integration tests" } })
		expect(screen.getByText("2 of 2 answered")).toBeInTheDocument()
	})
})
