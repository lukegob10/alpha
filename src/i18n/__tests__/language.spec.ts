import { initializeI18n, changeLanguage } from "../index"
import i18next from "../setup"

vi.mock("../setup", () => ({ default: { changeLanguage: vi.fn(), t: vi.fn(), language: "en" } }))

it("uses English for native initialization and subsequent stale language changes", () => {
	initializeI18n("fr")
	changeLanguage("ja")
	expect(vi.mocked(i18next.changeLanguage).mock.calls).toEqual([["en"], ["en"]])
})
