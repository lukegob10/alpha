import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { constants } from "fs"

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

	async function writeConfig(root: ".alpha" | ".roo", content: string): Promise<string> {
		const configPath = path.join(cwd, root, "mcp.json")
		await fs.mkdir(path.dirname(configPath), { recursive: true })
		await fs.writeFile(configPath, content)
		return configPath
	}

	it("keeps canonical project configuration last in precedence order", () => {
		expect(getProjectConfigDirectory(cwd)).toBe(path.join(cwd, ".alpha"))
		expect(getConfigDirectoriesForCwd(cwd)).toEqual([
			path.join(os.homedir(), ".roo"),
			path.join(cwd, ".roo"),
			path.join(cwd, ".alpha"),
		])
	})

	it("returns the Alpha MCP path without creating an empty file during discovery", async () => {
		const canonicalPath = await getProjectMcpConfigPath(cwd)
		expect(canonicalPath).toBe(path.join(cwd, ".alpha", "mcp.json"))
		await expect(fs.access(path.dirname(canonicalPath))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("preserves legacy MCP content verbatim and makes repeated discovery idempotent", async () => {
		const content = '{\n "mcpServers": {"project-tool": {"command": "node"}}, "future": true\n}\n'
		const legacyPath = await writeConfig(".roo", content)
		const canonicalPath = await getProjectMcpConfigPath(cwd)
		expect(await fs.readFile(canonicalPath, "utf-8")).toBe(content)
		expect(await fs.readFile(legacyPath, "utf-8")).toBe(content)

		await fs.writeFile(canonicalPath, '{"mcpServers": {}}')
		await getProjectMcpConfigPath(cwd)
		expect(await fs.readFile(canonicalPath, "utf-8")).toBe('{"mcpServers": {}}')
	})

	it("never merges legacy configuration over an existing Alpha configuration", async () => {
		await writeConfig(".roo", '{"mcpServers": {"old": {"command": "node"}}}')
		const canonicalPath = await writeConfig(".alpha", '{"mcpServers": {}}')
		expect(await getProjectMcpConfigPath(cwd)).toBe(canonicalPath)
		expect(await fs.readFile(canonicalPath, "utf-8")).toBe('{"mcpServers": {}}')
	})

	it("uses an exclusive copy when another writer creates the Alpha configuration", async () => {
		await writeConfig(".roo", '{"mcpServers": {"old": {"command": "node"}}}')
		const copyFile = await vi
			.importActual<typeof import("fs/promises")>("fs/promises")
			.then((module) => module.copyFile)
		const copy = vi.mocked(fs.copyFile).mockImplementationOnce(async (source, destination, flags) => {
			await fs.writeFile(destination, "concurrent edit")
			await copyFile(source, destination, flags)
		})
		const canonicalPath = await getProjectMcpConfigPath(cwd)
		expect(copy).toHaveBeenCalledWith(path.join(cwd, ".roo", "mcp.json"), canonicalPath, constants.COPYFILE_EXCL)
		expect(await fs.readFile(canonicalPath, "utf-8")).toBe("concurrent edit")
	})

	it("propagates I/O failures instead of replacing a protected configuration", async () => {
		const failure = Object.assign(new Error("permission denied"), { code: "EACCES" })
		vi.mocked(fs.access).mockRejectedValueOnce(failure)
		await expect(getProjectMcpConfigPath(cwd)).rejects.toBe(failure)
	})

	it("reads Alpha mode rules first and falls back to legacy rules without writes", async () => {
		const legacyRules = path.join(cwd, ".roo", "rules-code")
		await fs.mkdir(legacyRules, { recursive: true })
		expect(await getProjectConfigPathForRead(cwd, "rules-code")).toBe(legacyRules)
		const canonicalRules = path.join(cwd, ".alpha", "rules-code")
		await fs.mkdir(canonicalRules, { recursive: true })
		expect(await getProjectConfigPathForRead(cwd, "rules-code")).toBe(canonicalRules)
	})
})
