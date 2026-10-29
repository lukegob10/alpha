const createHighlighter = vi.hoisted(() => vi.fn())

vi.mock("shiki/langs", () => ({
	bundledLanguages: { shell: {}, log: {}, typescript: {} },
}))

describe("getHighlighter", () => {
	const loadRuntime = vi.fn(() => ({ createHighlighter }))

	beforeEach(() => {
		vi.resetModules()
		createHighlighter.mockReset()
		loadRuntime.mockClear()
		vi.doMock("shiki", loadRuntime)
	})

	afterEach(() => {
		vi.doUnmock("shiki")
		vi.restoreAllMocks()
	})

	it("does not load the rendering runtime for language normalization or availability checks", async () => {
		const { normalizeLanguage, isLanguageLoaded } = await import("../highlighter")

		expect(normalizeLanguage("TYPESCRIPT")).toBe("typescript")
		expect(normalizeLanguage("shell")).toBe("shell")
		expect(isLanguageLoaded("txt")).toBe(true)
		expect(isLanguageLoaded("typescript")).toBe(false)
		expect(loadRuntime).not.toHaveBeenCalled()
		expect(createHighlighter).not.toHaveBeenCalled()
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
		expect(loadRuntime).toHaveBeenCalledTimes(1)
		expect(instance.loadLanguage).not.toHaveBeenCalled()
	})

	it("shares initialization across concurrent requests and keeps the completed singleton", async () => {
		const instance = { loadLanguage: vi.fn() }
		let finishInitialization!: (value: typeof instance) => void
		const initialization = new Promise<typeof instance>((resolve) => {
			finishInitialization = resolve
		})
		let markInitializationStarted!: () => void
		const initializationStarted = new Promise<void>((resolve) => {
			markInitializationStarted = resolve
		})
		createHighlighter.mockImplementation(() => {
			markInitializationStarted()
			return initialization
		})
		const { getHighlighter } = await import("../highlighter")

		const shellRequest = getHighlighter("shell")
		const logRequest = getHighlighter("log")
		await initializationStarted
		expect(createHighlighter).toHaveBeenCalledTimes(1)
		expect(loadRuntime).toHaveBeenCalledTimes(1)

		finishInitialization(instance)
		await expect(shellRequest).resolves.toBe(instance)
		await expect(logRequest).resolves.toBe(instance)
		await expect(getHighlighter("shell")).resolves.toBe(instance)
		expect(createHighlighter).toHaveBeenCalledTimes(1)
		expect(instance.loadLanguage).not.toHaveBeenCalled()
	})

	it("retries after a transient initialization failure", async () => {
		const instance = { loadLanguage: vi.fn() }
		createHighlighter.mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValueOnce(instance)
		const { getHighlighter } = await import("../highlighter")
		vi.spyOn(console, "error").mockImplementation(() => {})

		await expect(getHighlighter("shell")).rejects.toThrow("temporary failure")
		await expect(getHighlighter("shell")).resolves.toBe(instance)
		expect(createHighlighter).toHaveBeenCalledTimes(2)
		expect(loadRuntime).toHaveBeenCalledTimes(1)
	})

	it("deduplicates a requested language while its grammar is loading", async () => {
		let finishLoading!: () => void
		const loading = new Promise<void>((resolve) => {
			finishLoading = resolve
		})
		let markLoadingStarted!: () => void
		const loadingStarted = new Promise<void>((resolve) => {
			markLoadingStarted = resolve
		})
		const instance = {
			loadLanguage: vi.fn(() => {
				markLoadingStarted()
				return loading
			}),
		}
		createHighlighter.mockResolvedValue(instance)
		const { getHighlighter, isLanguageLoaded } = await import("../highlighter")
		await getHighlighter("shell")

		const firstRequest = getHighlighter("typescript")
		const normalizedRequest = getHighlighter("TYPESCRIPT")
		await loadingStarted
		expect(instance.loadLanguage).toHaveBeenCalledTimes(1)
		expect(instance.loadLanguage).toHaveBeenCalledWith("typescript")
		expect(isLanguageLoaded("typescript")).toBe(false)

		finishLoading()
		await expect(firstRequest).resolves.toBe(instance)
		await expect(normalizedRequest).resolves.toBe(instance)
		expect(isLanguageLoaded("typescript")).toBe(true)
		await expect(getHighlighter("typescript")).resolves.toBe(instance)
		expect(instance.loadLanguage).toHaveBeenCalledTimes(1)
		expect(createHighlighter).toHaveBeenCalledTimes(1)
	})

	it("retries a failed language load without recreating the runtime", async () => {
		const instance = {
			loadLanguage: vi.fn().mockRejectedValueOnce(new Error("grammar failure")).mockResolvedValueOnce(undefined),
		}
		createHighlighter.mockResolvedValue(instance)
		const { getHighlighter, isLanguageLoaded } = await import("../highlighter")
		vi.spyOn(console, "error").mockImplementation(() => {})

		await expect(getHighlighter("typescript")).rejects.toThrow("grammar failure")
		expect(isLanguageLoaded("typescript")).toBe(false)
		await expect(getHighlighter("typescript")).resolves.toBe(instance)
		expect(isLanguageLoaded("typescript")).toBe(true)
		expect(instance.loadLanguage).toHaveBeenCalledTimes(2)
		expect(instance.loadLanguage).toHaveBeenNthCalledWith(1, "typescript")
		expect(instance.loadLanguage).toHaveBeenNthCalledWith(2, "typescript")
		expect(createHighlighter).toHaveBeenCalledTimes(1)
		expect(loadRuntime).toHaveBeenCalledTimes(1)
	})
})
