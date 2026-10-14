import { markdownFormattingSection } from "../markdown-formatting"

describe("markdownFormattingSection", () => {
	it("forbids fabricated links for missing or unverified workspace targets", () => {
		const section = markdownFormattingSection()

		expect(section).toContain("Only create a link when its workspace path is supported by available evidence")
		expect(section).toContain("Never invent a path or line number")
		expect(section).toContain("reported missing or remains unverified")
	})
})
