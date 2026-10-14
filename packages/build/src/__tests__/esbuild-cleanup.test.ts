import * as fs from "fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "child_process"
import { copyPaths } from "../esbuild.js"

vi.mock("fs", async (original) => {
	const actual = await original<typeof import("fs")>()
	return { ...actual, rmSync: vi.fn(actual.rmSync) }
})
vi.mock("child_process", () => ({ execFileSync: vi.fn() }))

it("passes a Windows readonly cleanup path as one argument without a shell", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	const root = actual.mkdtempSync(path.join(os.tmpdir(), "alpha-attrib-"))
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!
	const destination = path.join(root, "output", "build & %name% 雪")
	actual.mkdirSync(path.join(root, "source"))
	actual.writeFileSync(path.join(root, "source", "file.txt"), "fixture")
	actual.mkdirSync(destination, { recursive: true })
	let attempts = 0
	vi.mocked(fs.rmSync).mockImplementation((target, options) => {
		if (target === destination && ++attempts <= 5) throw Object.assign(new Error("readonly"), { code: "EPERM" })
		actual.rmSync(target, options)
	})
	let time = 0
	vi.spyOn(Date, "now").mockImplementation(() => (time += 2_000))
	vi.spyOn(console, "warn").mockImplementation(() => {})
	try {
		Object.defineProperty(process, "platform", { value: "win32" })
		copyPaths([["source", "build & %name% 雪"]], root, path.join(root, "output"))
		expect(execFileSync).toHaveBeenCalledExactlyOnceWith(
			"attrib.exe",
			["-R", path.join(destination, "*.*"), "/S", "/D"],
			{ stdio: "ignore", shell: false, windowsHide: true },
		)
		expect(actual.readFileSync(path.join(destination, "file.txt"), "utf8")).toBe("fixture")
	} finally {
		Object.defineProperty(process, "platform", platform)
		vi.restoreAllMocks()
		actual.rmSync(root, { recursive: true, force: true })
	}
})
