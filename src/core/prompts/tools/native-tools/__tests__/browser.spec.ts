import { browserToolNames } from "@alpha-code/types"
import { describe, expect, it } from "vitest"

import { getNativeTools } from ".."

function toolNames(options?: Parameters<typeof getNativeTools>[0]) {
	return getNativeTools(options)
		.filter((tool) => tool.type === "function")
		.map((tool) => tool.function.name)
}

describe("VS Code integrated-browser native tools", () => {
	it("includes the full static browser catalog for runtime registry construction", () => {
		expect(toolNames()).toEqual(expect.arrayContaining([...browserToolNames]))
	})

	it("exposes only browser tools currently registered by VS Code", () => {
		const names = toolNames({
			supportsImages: true,
			availableBrowserToolNames: ["read_page", "click_element"],
		})
		const browserNameSet = new Set<string>(browserToolNames)
		const exposedBrowserNames = names.filter((name) => browserNameSet.has(name))

		expect(exposedBrowserNames).toEqual(["read_page", "click_element"])
	})

	it("omits screenshots for text-only models while keeping text browser tools", () => {
		const names = toolNames({
			supportsImages: false,
			availableBrowserToolNames: ["read_page", "screenshot_page"],
		})

		expect(names).toContain("read_page")
		expect(names).not.toContain("screenshot_page")
	})
})
