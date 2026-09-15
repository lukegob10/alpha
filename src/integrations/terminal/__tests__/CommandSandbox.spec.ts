import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { prepareSandboxedCommand, sandboxState, shellInvocation } from "../CommandSandbox"
import { ensureSandboxRuntime } from "../SandboxRuntime"

vi.mock("../SandboxRuntime", () => ({ ensureSandboxRuntime: vi.fn(async () => "trusted-sandbox") }))

describe("command sandbox launch contract", () => {
	let fixture: string
	let root: string
	let storage: string
	beforeEach(async () => {
		vi.clearAllMocks()
		fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-sandbox-launch-")))
		root = path.join(fixture, "workspace")
		storage = path.join(fixture, "storage")
		await Promise.all([root, storage].map((directory) => fs.mkdir(directory)))
	})
	afterEach(async () => {
		await fs.rm(fixture, { recursive: true, force: true })
	})

	it("passes scripts as one argument and grants only the captured roots and scoped scratch", async () => {
		const command = `echo \"quoted\"; node child.js > ../outside.txt`
		const invocation = shellInvocation(
			command,
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
			"win32",
		)
		const launch = await prepareSandboxedCommand(
			{ workspaceRoots: [root], cwd: root, storagePath: storage },
			invocation,
		)
		expect(launch.executable).toBe("trusted-sandbox")
		expect(launch.args.slice(launch.args.indexOf("--") + 1)).toEqual(invocation)
		expect(Buffer.from(launch.args.at(-1)!, "base64").toString("utf16le")).toBe(command)
		const state = JSON.parse(launch.args[launch.args.indexOf("--sandbox-state-json") + 1])
		expect(state.permissionProfile.type).toBe("managed")
		expect(state.permissionProfile.network).toBe("enabled")
		expect(
			state.permissionProfile.file_system.entries
				.filter((entry: { access: string }) => entry.access === "write")
				.map((entry: { path: { path: string } }) => entry.path.path),
		).toEqual([root, path.join(root, ".git"), launch.env.TEMP])
		expect(() => launch.assertScope()).not.toThrow()
	})

	it("does not widen write scope when cwd is outside the workspace", async () => {
		const launch = await prepareSandboxedCommand({ workspaceRoots: [root], cwd: fixture, storagePath: storage }, [
			"echo",
			"test",
		])
		const state = JSON.parse(launch.args[2])
		expect(state.permissionProfile.file_system.entries).not.toContainEqual({
			path: { type: "path", path: fixture },
			access: "write",
		})
	})

	it("fails closed before running when the runtime is missing or setup fails", async () => {
		vi.mocked(ensureSandboxRuntime).mockRejectedValueOnce(new Error("setup failed"))
		await expect(
			prepareSandboxedCommand({ workspaceRoots: [root], cwd: root, storagePath: storage }, ["echo"]),
		).rejects.toThrow("setup failed")
	})

	it("initializes global storage on the first command and reuses it for another project", async () => {
		const newStorage = path.join(storage, "new-profile", "global")
		const first = await prepareSandboxedCommand({ workspaceRoots: [root], cwd: root, storagePath: newStorage }, [
			"echo",
		])
		const secondRoot = path.join(fixture, "second-project")
		await fs.mkdir(secondRoot)
		const second = await prepareSandboxedCommand(
			{ workspaceRoots: [secondRoot], cwd: secondRoot, storagePath: newStorage },
			["echo"],
		)
		expect(first.env.CODEX_HOME).toBe(second.env.CODEX_HOME)
		expect(first.env.TEMP).not.toBe(second.env.TEMP)
		expect(ensureSandboxRuntime).toHaveBeenNthCalledWith(1, newStorage, undefined)
		expect(ensureSandboxRuntime).toHaveBeenNthCalledWith(2, newStorage, undefined)
	})

	it("rejects a workspace junction retargeted after launch preparation", async () => {
		const alias = path.join(fixture, "alias")
		await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir")
		const launch = await prepareSandboxedCommand({ workspaceRoots: [alias], cwd: alias, storagePath: storage }, [
			"echo",
		])
		await fs.unlink(alias)
		await fs.symlink(storage, alias, process.platform === "win32" ? "junction" : "dir")
		expect(() => launch.assertScope()).toThrow("identity changed")
	})

	it("rejects a workspace containing the runtime and rejects cancelled launches", async () => {
		await expect(
			prepareSandboxedCommand({ workspaceRoots: [fixture], cwd: root, storagePath: storage }, ["echo"]),
		).rejects.toThrow("outside the task workspace")
		const controller = new AbortController()
		const launch = await prepareSandboxedCommand(
			{ workspaceRoots: [root], cwd: root, storagePath: storage, signal: controller.signal },
			["echo"],
		)
		controller.abort()
		expect(() => launch.assertScope()).toThrow()
	})

	it("gives Plan commands only scratch write access", () => {
		const state = sandboxState([root], root, path.join(storage, "scratch"), true)
		expect(state.permissionProfile.file_system.entries.filter((entry) => entry.access === "write")).toHaveLength(1)
	})
})
