import i18next from "../setup"

describe("i18n setup", () => {
	it("registers bundled translations before the first render", () => {
		expect(i18next.isInitialized).toBe(true)
		expect(i18next.t("common:answers.yes")).toBe("Yes")
	})
})
