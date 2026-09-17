import { initializeSourceMaps } from "./sourceMapInitializer"

describe("initializeSourceMaps", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
		vi.restoreAllMocks()
		document.head.querySelectorAll('link[rel="preload"]').forEach((link) => link.remove())
	})

	it("does not refetch scripts or preload source maps during startup", () => {
		vi.stubEnv("NODE_ENV", "production")
		const fetchSpy = vi.spyOn(globalThis, "fetch")

		initializeSourceMaps()

		expect(fetchSpy).not.toHaveBeenCalled()
		expect(document.head.querySelector('link[rel="preload"]')).toBeNull()
	})
})
