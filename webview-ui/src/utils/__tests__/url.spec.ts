import { isValidUrl } from "../url"

describe("isValidUrl", () => {
	it.each(["https://example.com/path", "http://localhost:3000"])("accepts web URL %s", (url) => {
		expect(isValidUrl(url)).toBe(true)
	})

	it.each([
		"javascript:alert(1)",
		"data:text/html,<script>alert(1)</script>",
		"file:///tmp/example",
		"command:workbench.action.openSettings",
		"vscode://settings",
		"not a url",
	])("rejects non-web or malformed URL %s", (url) => {
		expect(isValidUrl(url)).toBe(false)
	})
})
