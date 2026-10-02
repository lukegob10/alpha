import fs from "fs/promises"
import { Dirent } from "fs"
import path from "path"

import { getCommand, getCommands } from "../commands"

vi.mock("fs/promises", () => ({ default: { stat: vi.fn(), readdir: vi.fn(), readFile: vi.fn() } }))
vi.mock("../../config-paths", () => ({
	getLegacyGlobalConfigDirectory: () => path.resolve("/test", ".roo"),
	getProjectConfigDirectory: (cwd: string) => path.join(cwd, ".alpha"),
	getLegacyProjectConfigDirectory: (cwd: string) => path.join(cwd, ".roo"),
}))
vi.mock("../built-in-commands", () => ({
	getBuiltInCommands: async () => [
		{ name: "init", content: "Built-in", source: "built-in", filePath: "<built-in:init>" },
	],
	getBuiltInCommand: async () => undefined,
}))

describe("command source precedence", () => {
	it("lists the same global override used by direct invocation", async () => {
		const globalDirectory = path.resolve("/test", ".roo", "commands")
		vi.mocked(fs.stat).mockImplementation(
			async (candidate) =>
				({
					isDirectory: () => String(candidate) === globalDirectory,
				}) as Awaited<ReturnType<typeof fs.stat>>,
		)
		const entry = new Dirent()
		entry.name = "init.md"
		entry.isFile = () => true
		entry.isSymbolicLink = () => false
		// The mock uses readdir's final Buffer overload; this caller requests string entries.
		vi.mocked(fs.readdir).mockResolvedValue([entry] as unknown as Awaited<ReturnType<typeof fs.readdir>>)
		vi.mocked(fs.readFile).mockResolvedValue("Global override")

		const invoked = await getCommand("/workspace", "init")
		const listed = (await getCommands("/workspace")).find(({ name }) => name === "init")

		expect(invoked?.source).toBe("global")
		expect(listed).toEqual(invoked)
	})
})
