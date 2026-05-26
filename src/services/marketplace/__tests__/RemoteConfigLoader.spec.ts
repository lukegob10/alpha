import { RemoteConfigLoader } from "../RemoteConfigLoader"

describe("RemoteConfigLoader", () => {
	let loader: RemoteConfigLoader

	beforeEach(() => {
		loader = new RemoteConfigLoader()
		loader.clearCache()
	})

	it("does not fetch remote marketplace items", async () => {
		await expect(loader.loadAllItems()).resolves.toEqual([])
	})

	it("does not fetch individual remote marketplace items", async () => {
		await expect(loader.getItem("test-mode", "mode")).resolves.toBeNull()
	})
})
