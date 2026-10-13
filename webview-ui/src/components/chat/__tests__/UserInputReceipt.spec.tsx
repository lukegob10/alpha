import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { UserInputReceipt } from "../UserInputReceipt"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

describe("UserInputReceipt", () => {
	it("pairs every full prompt with its complete answer lines", () => {
		render(
			<UserInputReceipt
				response={{
					questions: [
						{
							header: "Scope",
							question: "Which workspace should I inspect?",
							answers: ["Current workspace (Recommended)"],
						},
						{
							question: "Which validation should I run?",
							answers: ["Focused tests", "Include the provider cancellation cases."],
						},
					],
				}}
			/>,
		)

		expect(screen.getAllByRole("term").map((term) => term.textContent)).toEqual([
			"ScopeWhich workspace should I inspect?",
			"Which validation should I run?",
		])
		expect(screen.getAllByRole("definition").map((definition) => definition.textContent)).toEqual([
			"Current workspace (Recommended)",
			"Focused tests\nInclude the provider cancellation cases.",
		])
		expect(screen.queryByRole("radio")).not.toBeInTheDocument()
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
	})
})
