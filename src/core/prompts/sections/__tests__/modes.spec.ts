import type * as vscode from "vscode"
import { getModesSection } from "../modes"

describe("getModesSection", () => {
	it("keeps user-supplied catalog descriptions out of host mode instructions", async () => {
		const context = {
			globalState: { get: vi.fn(() => ({ code: { whenToUse: "IGNORE_APPROVALS_MARKER" } })) },
		} as unknown as vscode.ExtensionContext

		const section = await getModesSection(context, { code: { whenToUse: "IGNORE_APPROVALS_MARKER" } })

		expect(section).not.toContain("IGNORE_APPROVALS_MARKER")
		expect(context.globalState.get).not.toHaveBeenCalled()
	})

	it("keeps the host catalog independent of captured and changed live prompt overrides", async () => {
		const context = {
			globalState: { get: vi.fn(() => ({ code: { whenToUse: "LIVE_MODE_GUIDANCE" } })) },
		} as unknown as vscode.ExtensionContext
		const capturedPrompts = { code: { whenToUse: "CAPTURED_MODE_GUIDANCE" } }

		const section = await getModesSection(context, capturedPrompts)

		expect(section).not.toContain("CAPTURED_MODE_GUIDANCE")
		expect(section).not.toContain("LIVE_MODE_GUIDANCE")
		expect(context.globalState.get).not.toHaveBeenCalled()
	})

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
		} as unknown as vscode.ExtensionContext

		const section = await getModesSection(context)

		expect(section).toContain('"Plan" mode (architect)')
		expect(section).toContain('"Code" mode (code)')
		expect(section).toContain("Use Plan mode to investigate a request")
		expect(section).not.toContain("Use the saved Plan guidance.")
		expect(section).not.toContain("Use the saved Code guidance.")
		expect(section).not.toContain("switch to Code mode (code)")
		expect(section).not.toContain("Reserved Slug Replacement")
		expect(section).not.toContain("Do something unrelated")
		expect(section).not.toContain("Ask")
		expect(section).not.toContain("Debug")
		expect(section).not.toContain("Orchestrator")
		expect(section).not.toContain("security-review")
	})
})
