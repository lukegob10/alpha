import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return { ...actual, access: vi.fn(actual.access), copyFile: vi.fn(actual.copyFile) }
})

import {
	getConfigDirectoriesForCwd,
	getProjectConfigDirectory,
	getProjectConfigPathForRead,
	getProjectMcpConfigPath,
} from "../index"

describe("Alpha project configuration", () => {
	let cwd: string

	beforeEach(async () => {
		vi.clearAllMocks()
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-project-config-"))
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(cwd, { recursive: true, force: true })
	})

	it("orders global and project configuration without duplicate project probes", () => {
		expect(getProjectConfigDirectory(cwd)).toBe(path.join(cwd, ".alpha"))
		expect(getConfigDirectoriesForCwd(cwd)).toEqual([path.join(os.homedir(), ".alpha"), path.join(cwd, ".alpha")])
	})

	it("returns the Alpha MCP path without creating configuration during discovery", async () => {
		const canonicalPath = await getProjectMcpConfigPath(cwd)
		expect(canonicalPath).toBe(path.join(cwd, ".alpha", "mcp.json"))
		await expect(fs.access(path.dirname(canonicalPath))).rejects.toMatchObject({ code: "ENOENT" })
		expect(fs.copyFile).not.toHaveBeenCalled()
	})

	it("preserves existing MCP content verbatim across repeated discovery", async () => {
		const canonicalPath = path.join(cwd, ".alpha", "mcp.json")
		const content = '{\n "mcpServers": {"project-tool": {"command": "node"}}, "future": true\n}\n'
		await fs.mkdir(path.dirname(canonicalPath), { recursive: true })
		await fs.writeFile(canonicalPath, content)
		expect(await getProjectMcpConfigPath(cwd)).toBe(canonicalPath)
		expect(await getProjectMcpConfigPath(cwd)).toBe(canonicalPath)
		expect(await fs.readFile(canonicalPath, "utf-8")).toBe(content)
		expect(fs.copyFile).not.toHaveBeenCalled()
	})

	it("propagates I/O failures instead of replacing a protected configuration", async () => {
		const failure = Object.assign(new Error("permission denied"), { code: "EACCES" })
		vi.mocked(fs.access).mockRejectedValueOnce(failure)
		await expect(getProjectMcpConfigPath(cwd)).rejects.toBe(failure)
	})

	it("resolves absent and existing mode-rule paths without writes", async () => {
		const canonicalRules = path.join(cwd, ".alpha", "rules-code")
		expect(await getProjectConfigPathForRead(cwd, "rules-code")).toBe(canonicalRules)
		await fs.mkdir(canonicalRules, { recursive: true })
		expect(await getProjectConfigPathForRead(cwd, "rules-code")).toBe(canonicalRules)
		expect(fs.copyFile).not.toHaveBeenCalled()
	})
})
