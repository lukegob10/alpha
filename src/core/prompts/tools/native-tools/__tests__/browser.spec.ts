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

	it.each(["open_browser_page", "navigate_page"])("limits %s guidance to websites", (name) => {
		const tool = getNativeTools().find((tool) => tool.type === "function" && tool.function.name === name)
		expect(tool?.type).toBe("function")
		if (tool?.type !== "function") throw new Error(`Missing browser tool: ${name}`)

		expect(tool.function.description).toContain("HTTP or HTTPS")
		expect(tool.function.description).toContain("read_file")
		expect(tool.function.parameters).toMatchObject({
			properties: {
				url: { description: expect.stringContaining("HTTP or HTTPS") },
			},
		})
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

	it.each(["open_browser_page", "navigate_page", "run_playwright_code"])(
		"directs rich documents to the HTML previewer in %s guidance",
		(name) => {
			const tool = getNativeTools().find((tool) => tool.type === "function" && tool.function.name === name)
			if (tool?.type !== "function") throw new Error(`Missing browser tool: ${name}`)
			expect(tool.function.description).toContain("HTML previewer")
			expect(tool.function.description).toContain("alpha-document://open")
			expect(tool.function.description).toContain("never use browser tools or a localhost server")
		},
	)

	it("omits screenshots for text-only models while keeping text browser tools", () => {
		const names = toolNames({
			supportsImages: false,
			availableBrowserToolNames: ["read_page", "screenshot_page"],
		})

		expect(names).toContain("read_page")
		expect(names).not.toContain("screenshot_page")
	})
})
