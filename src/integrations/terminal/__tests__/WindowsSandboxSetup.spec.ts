import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execa } from "execa"
import { ensureWindowsSandboxSetup } from "../WindowsSandboxSetup"
import type { SandboxedCommand } from "../CommandSandbox"

vi.mock("execa", () => ({ execa: vi.fn(async () => ({ exitCode: 0 })) }))

describe.skipIf(process.platform !== "win32")("global Windows sandbox setup", () => {
	let home: string
	let launch: SandboxedCommand
	beforeEach(async () => {
		vi.clearAllMocks()
		home = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-windows-setup-"))
		launch = {
			executable: "trusted-runtime",
			args: ["fixed-read-only-bootstrap"],
			env: { CODEX_HOME: home },
			assertScope: vi.fn(),
		}
	})
	afterEach(async () => {
		await fs.rm(home, { recursive: true, force: true })
	})

	it("bootstraps once and shares setup across concurrent projects", async () => {
		await Promise.all([ensureWindowsSandboxSetup(launch, home), ensureWindowsSandboxSetup(launch, home)])
		await ensureWindowsSandboxSetup(launch, home)
		expect(execa).toHaveBeenCalledTimes(2)
		expect(execa).toHaveBeenNthCalledWith(
			1,
			"trusted-runtime",
			["fixed-read-only-bootstrap"],
			expect.objectContaining({ shell: false, env: launch.env }),
		)
		expect(launch.assertScope).toHaveBeenCalledOnce()
	})

	it("reuses persisted native setup after an extension reload", async () => {
		await fs.mkdir(path.join(home, ".sandbox"))
		await fs.writeFile(path.join(home, ".sandbox", "setup_marker.json"), "{}")
		await ensureWindowsSandboxSetup(launch, home)
		expect(execa).toHaveBeenCalledOnce()
		expect(vi.mocked(execa).mock.calls[0][0]).toMatch(/powershell\.exe$/)
	})

	it("fails closed when provisioning fails and permits a later setup retry", async () => {
		vi.mocked(execa).mockRejectedValueOnce(new Error("native setup unavailable"))
		await expect(ensureWindowsSandboxSetup(launch, home)).rejects.toMatchObject({
			cause: expect.objectContaining({ message: "native setup unavailable" }),
		})
		expect(execa).toHaveBeenCalledOnce()
		await ensureWindowsSandboxSetup(launch, home)
		expect(execa).toHaveBeenCalledTimes(3)
	})

	it("does no setup after cancellation", async () => {
		const controller = new AbortController()
		controller.abort()
		await expect(ensureWindowsSandboxSetup(launch, home, controller.signal)).rejects.toThrow()
		expect(execa).not.toHaveBeenCalled()
	})
})
