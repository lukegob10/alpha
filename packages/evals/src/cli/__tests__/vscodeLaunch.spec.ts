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
it("namespaces owned benchmark sockets without changing legacy endpoints", () => {
	expect(evaluatorIpcEndpoint(1, 2, "win32", "0123456789abcdef")).toBe("\\\\.\\pipe\\evals-1-2-0123456789abcdef.sock")
	expect(evaluatorIpcEndpoint(1, 2, "linux", "0123456789abcdef")).toMatch(/evals-1-2-0123456789abcdef.sock$/)
	expect(() => evaluatorIpcEndpoint(1, 2, "linux", "../foreign")).toThrow(/bounded filename/)
})
it("keeps container launch argument-safe", () => {
	const launch = vscodeLaunch("/space name", true, "linux")
	expect(launch.command).toBe("xvfb-run")
	expect(launch.args.at(-1)).toBe("/space name")
})

it.each(["win32", "linux", "darwin"] as const)("isolates the governed benchmark host on %s", (platform) => {
	const root = platform === "win32" ? "C:/owned fixture" : "/owned fixture"
	const options = {
		executablePath: `${root}/${platform === "win32" ? "Code.exe" : "code"}`,
		userDataDir: `${root}/user data`,
		extensionsDir: `${root}/extensions`,
		sharedDataDir: `${root}/shared data`,
		extensionDevelopmentPath: `${root}/Alpha source`,
	}
	const workspace = `${root}/workspace;$(untrusted)`
	const launch = vscodeLaunch(workspace, false, platform, options)
	expect(launch.command).toBe(options.executablePath)
	expect(launch.args).toEqual(
		expect.arrayContaining([
			`--user-data-dir=${options.userDataDir}`,
			`--extensions-dir=${options.extensionsDir}`,
			`--shared-data-dir=${options.sharedDataDir}`,
			`--extensionDevelopmentPath=${options.extensionDevelopmentPath}`,
		]),
	)
	expect(launch.args.at(-1)).toBe(workspace)
})

it.each(["", "code", "./Code.exe", "C:/owned/Code.cmd", "C:/owned/Code.exe\0"])(
	"rejects an unsafe governed Windows executable %j",
	(executablePath) => {
		expect(() =>
			vscodeLaunch("C:/workspace", false, "win32", {
				executablePath,
				userDataDir: "C:/owned/user-data",
				extensionsDir: "C:/owned/extensions",
				sharedDataDir: "C:/owned/shared-data",
				extensionDevelopmentPath: "C:/alpha/src",
			}),
		).toThrow(/absolute.*executable/i)
	},
)
