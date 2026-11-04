import fs from "fs/promises"
import type { Stats } from "fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
	captureCommandShellLaunch,
	assertCommandShellLaunchUnchanged,
	commandShellArgs,
	terminalShellArgs,
} from "../shell"
import type { CommandShellLaunch } from "../../integrations/terminal/types"

const selectedPath =
	process.platform === "win32" ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" : "/bin/bash"
const stat = { dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5, isFile: () => true } as Stats

beforeEach(() => {
	vi.spyOn(fs, "access").mockResolvedValue(undefined)
	vi.spyOn(fs, "realpath").mockImplementation(async (value) => String(value))
	vi.spyOn(fs, "stat").mockResolvedValue(stat)
})
afterEach(() => vi.restoreAllMocks())

function launch(family: CommandShellLaunch["family"], login: boolean): CommandShellLaunch {
	return { shellPath: "approved-shell", family, login, binaryIdentity: "fixture", identity: "fixture" }
}

describe("captured command shell launch", () => {
	it("preserves the omitted and nullable control path without inspecting an executable", async () => {
		expect(await captureCommandShellLaunch(undefined, undefined, selectedPath)).toBeUndefined()
		expect(await captureCommandShellLaunch(null, null, selectedPath)).toBeUndefined()
		expect(fs.access).not.toHaveBeenCalled()
	})

	it("captures an immutable interpreter and startup identity", async () => {
		const result = await captureCommandShellLaunch(selectedPath, false, "unused")
		expect(result).toMatchObject({ shellPath: selectedPath, login: false })
		expect(Object.isFrozen(result)).toBe(true)
		expect(result?.identity).toContain("false")
		expect((await captureCommandShellLaunch(selectedPath, true, "unused"))?.identity).not.toBe(result?.identity)
	})

	it("resolves login-only requests against the captured configured interpreter", async () => {
		expect(await captureCommandShellLaunch(undefined, false, selectedPath)).toMatchObject({
			shellPath: selectedPath,
			login: false,
		})
	})

	it.each(["", " bash", "bash --rcfile anything", "fish", "/workspace/bash", "bash\0bad", 4])(
		"rejects unsupported shell %s without falling back",
		async (shell) => {
			await expect(captureCommandShellLaunch(shell, false, selectedPath)).rejects.toThrow()
		},
	)

	it("rejects malformed startup choices", async () => {
		await expect(captureCommandShellLaunch(selectedPath, "false", selectedPath)).rejects.toThrow("login")
	})

	it("resolves bare pwsh to pwsh rather than substituting legacy PowerShell", async () => {
		const result = await captureCommandShellLaunch("pwsh", false, "unused")
		expect(result?.shellPath.replace(/\\/g, "/")).toMatch(/\/pwsh(?:\.exe)?$/i)
	})

	it("rejects an approved path whose symlink resolves outside approved shell locations", async () => {
		vi.mocked(fs.realpath).mockResolvedValue(
			process.platform === "win32" ? "C:\\workspace\\powershell.exe" : "/workspace/bash",
		)
		await expect(captureCommandShellLaunch(selectedPath, false, "unused")).rejects.toThrow("approved")
		expect(fs.access).not.toHaveBeenCalled()
	})

	it("rejects a changed approved executable before launch", async () => {
		const captured = await captureCommandShellLaunch(selectedPath, false, "unused")
		vi.mocked(fs.stat).mockResolvedValue({ ...stat, ino: 99 } as Stats)
		await expect(assertCommandShellLaunchUnchanged(captured!)).rejects.toThrow("changed")
	})

	it.each(["sh", "bash", "zsh"] as const)("preserves the command as one %s argument", (family) => {
		const command = "printf '%s' 'quoted;$(literal argument)'"
		expect(commandShellArgs(launch(family, true), command)).toEqual(["-lc", command])
		expect(commandShellArgs(launch(family, false), command)).toEqual(["-c", command])
		expect(terminalShellArgs(launch(family, true))).toEqual(["-l"])
		expect(terminalShellArgs(launch(family, false))).toEqual([])
	})

	it("selects PowerShell profiles and cmd arguments explicitly", () => {
		expect(commandShellArgs(launch("powershell", false), "Write-Output hi")).toEqual([
			"-NoProfile",
			"-Command",
			"Write-Output hi",
		])
		expect(commandShellArgs(launch("powershell", true), "Write-Output hi")).toEqual(["-Command", "Write-Output hi"])
		expect(terminalShellArgs(launch("powershell", false))).toEqual(["-NoProfile"])
		expect(commandShellArgs(launch("cmd", true), "echo hi")).toEqual(["/c", "echo hi"])
	})
})
