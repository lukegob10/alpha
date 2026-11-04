import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { LanguageSettings } from "../LanguageSettings"

vi.mock("@/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }))

it("shows English for a retired saved locale and offers no other choices", async () => {
	const setCachedStateField = vi.fn()
	render(<LanguageSettings language="fr" setCachedStateField={setCachedStateField} />)
	const selector = screen.getByRole("combobox")
	expect(selector).toHaveTextContent("English")
	fireEvent.keyDown(selector, { key: "ArrowDown" })
	const options = await screen.findAllByRole("option")
	expect(options).toHaveLength(1)
	expect(options[0]).toHaveTextContent("English")
	expect(setCachedStateField).not.toHaveBeenCalled()
})
