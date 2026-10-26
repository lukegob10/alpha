import fs from "fs/promises"
import path from "path"

import { createDirectoriesForFile } from "../fs"

vi.mock("fs/promises", () => ({
	default: {
		access: vi.fn(),
		mkdir: vi.fn(),
	},
}))

describe("createDirectoriesForFile", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(fs.mkdir).mockResolvedValue(undefined)
	})

	it("rejects an inaccessible filesystem root without repeatedly probing the same path", async () => {
		const root = path.parse(process.cwd()).root
		vi.mocked(fs.access).mockRejectedValue(new Error("root unavailable"))

		await expect(createDirectoriesForFile(path.join(root, "missing", "file.txt"))).rejects.toThrow(
			"filesystem root is unavailable",
		)
		expect(fs.access).toHaveBeenCalledTimes(2)
		expect(fs.mkdir).not.toHaveBeenCalled()
	})

	it("creates and reports only missing parent directories in ancestor order", async () => {
		const base = path.join(path.parse(process.cwd()).root, "workspace")
		const first = path.join(base, "first")
		const second = path.join(first, "second")
		vi.mocked(fs.access).mockImplementation(async (candidate) => {
			if (candidate !== base) throw new Error("missing directory")
		})

		await expect(createDirectoriesForFile(path.join(second, "file.txt"))).resolves.toEqual([first, second])
		expect(vi.mocked(fs.mkdir).mock.calls).toEqual([[first], [second]])
	})
})
