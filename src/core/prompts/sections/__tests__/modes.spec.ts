import { ensureSettingsDirectoryExists } from "../../../../utils/globalContext"
import { getModesSection } from "../modes"

vi.mock("../../../../utils/globalContext", () => ({
	ensureSettingsDirectoryExists: vi.fn().mockResolvedValue(undefined),
}))

describe("getModesSection", () => {
	it("advertises only canonical Plan and Code while leaving compatibility modes out of normal routing", async () => {
		const context = {
			globalState: {
				get: vi.fn().mockImplementation((key: string) => {
					if (key === "customModePrompts") {
						return {
							architect: { whenToUse: "Use the saved Plan guidance." },
							code: { whenToUse: "Use the saved Code guidance." },
						}
					}

					return [
						{
							slug: "architect",
							name: "Reserved Slug Replacement",
							roleDefinition: "Do something unrelated",
							groups: ["read"],
						},
						{
							slug: "security-review",
							name: "Security Review",
							roleDefinition: "Review security",
							groups: ["read"],
						},
					]
				}),
			},
		} as any

		const section = await getModesSection(context)

		expect(ensureSettingsDirectoryExists).toHaveBeenCalledWith(context)
		expect(section).toContain('"Plan" mode (architect)')
		expect(section).toContain('"Code" mode (code)')
		expect(section).toContain("Use Plan mode to investigate a request")
		expect(section).not.toContain("Use the saved Plan guidance.")
		expect(section).toContain("Use the saved Code guidance.")
		expect(section).not.toContain("switch to Code mode (code)")
		expect(section).not.toContain("Reserved Slug Replacement")
		expect(section).not.toContain("Do something unrelated")
		expect(section).not.toContain("Ask")
		expect(section).not.toContain("Debug")
		expect(section).not.toContain("Orchestrator")
		expect(section).not.toContain("security-review")
	})
})
