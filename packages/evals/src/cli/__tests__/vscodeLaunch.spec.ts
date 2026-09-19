import { expect, it } from "vitest"
import { evaluatorIpcEndpoint, vscodeLaunch } from "../vscodeLaunch"

it.each(["win32", "linux", "darwin"] as const)("preserves workspace as one argument on %s", (platform) => {
	const workspace = "C:/work space/$(untrusted);fixture"
	const launch = vscodeLaunch(workspace, false, platform)
	expect(launch.command).toBe(platform === "win32" ? "code.cmd" : "code")
	expect(launch.args).toEqual(["--disable-workspace-trust", "-n", workspace])
})
it("uses named pipes on Windows and native temp sockets elsewhere", () => {
	expect(evaluatorIpcEndpoint(1, 2, "win32")).toBe("\\\\.\\pipe\\evals-1-2.sock")
	expect(evaluatorIpcEndpoint(1, 2, "linux")).toMatch(/evals-1-2.sock$/)
})
it("keeps container launch argument-safe", () => {
	const launch = vscodeLaunch("/space name", true, "linux")
	expect(launch.command).toBe("xvfb-run")
	expect(launch.args.at(-1)).toBe("/space name")
})
