const createHighlighter = vi.hoisted(() => vi.fn())

vi.mock("shiki", () => ({
	createHighlighter,
	bundledLanguages: { shell: {}, log: {}, typescript: {} },
	bundledThemes: {},
}))

describe("getHighlighter", () => {
	beforeEach(() => {
		vi.resetModules()
		createHighlighter.mockReset()
	})

	it("loads only the two themes used by webview code rendering", async () => {
		const instance = { loadLanguage: vi.fn() }
		createHighlighter.mockResolvedValue(instance)
		const { getHighlighter } = await import("../highlighter")

		await getHighlighter("shell")

		expect(createHighlighter).toHaveBeenCalledWith({
			themes: ["github-light", "github-dark"],
			langs: ["shell", "log"],
		})
	})

	it("retries after a transient initialization failure", async () => {
		const instance = { loadLanguage: vi.fn() }
		createHighlighter.mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValueOnce(instance)
		const { getHighlighter } = await import("../highlighter")

		await expect(getHighlighter("shell")).rejects.toThrow("temporary failure")
		await expect(getHighlighter("shell")).resolves.toBe(instance)
		expect(createHighlighter).toHaveBeenCalledTimes(2)
	})
})
