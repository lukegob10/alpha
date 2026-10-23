import { initializeSourceMaps } from "./sourceMapInitializer"
import { enhanceErrorWithSourceMaps } from "./sourceMapUtils"

vi.mock("./sourceMapUtils", () => ({
	enhanceErrorWithSourceMaps: vi.fn(async (error: Error) => error),
}))

describe("initializeSourceMaps", () => {
	const disposers: (() => void)[] = []
	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(console, "error").mockImplementation(() => {})
	})
	afterEach(() => {
		for (const dispose of disposers.splice(0)) dispose()
		vi.unstubAllEnvs()
		vi.restoreAllMocks()
		document.head.querySelectorAll('link[rel="preload"]').forEach((link) => link.remove())
	})

	it("does not refetch scripts or preload source maps during startup", () => {
		vi.stubEnv("NODE_ENV", "production")
		const fetchSpy = vi.spyOn(globalThis, "fetch")

		disposers.push(initializeSourceMaps())

		expect(fetchSpy).not.toHaveBeenCalled()
		expect(document.head.querySelector('link[rel="preload"]')).toBeNull()
	})

	it("removes both error listeners when the owning App unmounts", async () => {
		vi.stubEnv("NODE_ENV", "production")
		const dispose = initializeSourceMaps()
		dispose()
		dispose()
		// Vitest reports error events with no remaining user listener as uncaught
		// exceptions. Handle this synthetic fixture without stopping its propagation.
		const onFixtureError = (event: ErrorEvent) => event.preventDefault()
		window.addEventListener("error", onFixtureError)
		try {
			window.dispatchEvent(new ErrorEvent("error", { error: new Error("After disposal"), cancelable: true }))
			const rejection = new Event("unhandledrejection")
			Object.defineProperty(rejection, "reason", { value: new Error("After disposal") })
			window.dispatchEvent(rejection)
			await vi.dynamicImportSettled()
		} finally {
			window.removeEventListener("error", onFixtureError)
		}

		expect(enhanceErrorWithSourceMaps).not.toHaveBeenCalled()
	})

	it("maps each error once after an App cleanup and remount", async () => {
		vi.stubEnv("NODE_ENV", "production")
		initializeSourceMaps()()
		disposers.push(initializeSourceMaps())
		const error = new Error("Current App error")
		const rejectionError = new Error("Current App rejection")
		window.dispatchEvent(new ErrorEvent("error", { error }))
		await vi.dynamicImportSettled()
		expect(enhanceErrorWithSourceMaps).toHaveBeenCalledTimes(1)
		expect(enhanceErrorWithSourceMaps).toHaveBeenCalledWith(error)

		const rejection = new Event("unhandledrejection")
		Object.defineProperty(rejection, "reason", { value: rejectionError })
		window.dispatchEvent(rejection)

		await vi.dynamicImportSettled()
		expect(enhanceErrorWithSourceMaps).toHaveBeenCalledTimes(2)
		expect(enhanceErrorWithSourceMaps).toHaveBeenCalledWith(rejectionError)
	})

	it("returns a safe disposer without installing production listeners during development", () => {
		vi.stubEnv("NODE_ENV", "development")
		const addListener = vi.spyOn(window, "addEventListener")

		const dispose = initializeSourceMaps()
		dispose()

		expect(addListener).not.toHaveBeenCalled()
	})
})
