import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { ensureSandboxRuntime, SANDBOX_RELEASES, SANDBOX_RUNTIME_VERSION } from "../SandboxRuntime"

vi.mock("vscode", () => ({
	ProgressLocation: { Notification: 15 },
	window: {
		withProgress: vi.fn(async (_options, work) =>
			work({ report: vi.fn() }, { onCancellationRequested: () => ({ dispose: vi.fn() }) }),
		),
	},
}))

describe("pinned sandbox installer", () => {
	let storage: string
	beforeEach(async () => {
		storage = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-runtime-install-"))
	})
	afterEach(async () => {
		vi.unstubAllGlobals()
		await fs.rm(storage, { recursive: true, force: true })
	})

	it("reuses one global installation without a network request", async () => {
		const release = SANDBOX_RELEASES[`${process.platform}-${process.arch}`]
		const binary = path.join(
			storage,
			"command-sandbox",
			"runtime",
			`${SANDBOX_RUNTIME_VERSION}-${release.target}`,
			"bin",
			process.platform === "win32" ? "codex.exe" : "codex",
		)
		await fs.mkdir(path.dirname(binary), { recursive: true })
		await fs.writeFile(binary, "fixture")
		const fetchMock = vi.fn()
		vi.stubGlobal("fetch", fetchMock)
		expect(await ensureSandboxRuntime(storage)).toBe(binary)
		expect(await ensureSandboxRuntime(storage)).toBe(binary)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("rejects a corrupt download, cleans staging, and allows a later retry", async () => {
		const fetchMock = vi.fn(async () => new Response("not the pinned runtime"))
		vi.stubGlobal("fetch", fetchMock)
		await expect(ensureSandboxRuntime(storage)).rejects.toMatchObject({
			cause: expect.objectContaining({ message: "Sandbox archive checksum mismatch" }),
		})
		expect(await fs.readdir(path.join(storage, "command-sandbox", "runtime"))).toEqual([])
		await expect(ensureSandboxRuntime(storage)).rejects.toThrow()
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it("does not download after task cancellation", async () => {
		const controller = new AbortController()
		controller.abort()
		const fetchMock = vi.fn()
		vi.stubGlobal("fetch", fetchMock)
		await expect(ensureSandboxRuntime(storage, controller.signal)).rejects.toThrow()
		expect(fetchMock).not.toHaveBeenCalled()
	})
})
