const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	config: vi.fn(),
	loadDotenvx: vi.fn(),
}))

vi.mock("fs/promises", () => ({ access: mocks.access }))
vi.mock("@dotenvx/dotenvx", () => {
	mocks.loadDotenvx()
	return { config: mocks.config }
})

describe("loadExtensionEnvironment", () => {
	beforeEach(() => {
		vi.resetModules()
		vi.clearAllMocks()
		mocks.access.mockResolvedValue(undefined)
	})

	it("does not initialize dotenvx when the optional file is missing", async () => {
		mocks.access.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }))
		const { loadExtensionEnvironment } = await import("../loadEnvironment")

		await loadExtensionEnvironment("/extension/.env")

		expect(mocks.access).toHaveBeenCalledWith("/extension/.env")
		expect(mocks.loadDotenvx).not.toHaveBeenCalled()
		expect(mocks.config).not.toHaveBeenCalled()
	})

	it("waits for the file check before initializing dotenvx", async () => {
		let finishAccess!: () => void
		mocks.access.mockImplementationOnce(() => new Promise<void>((resolve) => (finishAccess = resolve)))
		const { loadExtensionEnvironment } = await import("../loadEnvironment")

		const loading = loadExtensionEnvironment("/extension/.env")
		expect(mocks.loadDotenvx).not.toHaveBeenCalled()
		finishAccess()
		await loading

		expect(mocks.loadDotenvx).toHaveBeenCalledOnce()
		expect(mocks.config).toHaveBeenCalledExactlyOnceWith({ path: "/extension/.env" })
	})

	it("checks and loads the environment for each activation", async () => {
		const { loadExtensionEnvironment } = await import("../loadEnvironment")

		await loadExtensionEnvironment("/extension/.env")
		await loadExtensionEnvironment("/extension/.env")

		expect(mocks.access).toHaveBeenCalledTimes(2)
		expect(mocks.config).toHaveBeenCalledTimes(2)
	})

	it("continues activation when the optional file cannot be checked", async () => {
		mocks.access.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }))
		const { loadExtensionEnvironment } = await import("../loadEnvironment")

		await expect(loadExtensionEnvironment("/extension/.env")).resolves.toBeUndefined()

		expect(mocks.loadDotenvx).not.toHaveBeenCalled()
	})

	it("warns and continues activation when dotenvx fails", async () => {
		const error = new Error("invalid optional environment")
		mocks.config.mockImplementationOnce(() => {
			throw error
		})
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const { loadExtensionEnvironment } = await import("../loadEnvironment")

		try {
			await expect(loadExtensionEnvironment("/extension/.env")).resolves.toBeUndefined()
			expect(warn).toHaveBeenCalledExactlyOnceWith("Failed to load environment variables:", error)
		} finally {
			warn.mockRestore()
		}
	})
})
