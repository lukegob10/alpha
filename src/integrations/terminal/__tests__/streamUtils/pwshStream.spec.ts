import { execFileSync, execSync } from "child_process"
import { createPowerShellStream } from "./pwshStream"

vi.mock("child_process", () => ({ execFileSync: vi.fn(), execSync: vi.fn() }))

async function chunks(command: string) {
	const { stream, exitCode } = createPowerShellStream(command)
	const output: string[] = []
	for await (const chunk of stream) output.push(chunk)
	return { output, exitCode }
}

describe("PowerShell command stream fixtures", () => {
	beforeEach(() => vi.resetAllMocks())

	it("passes variables, quotes, and backslashes as one literal PowerShell argument", async () => {
		const command = String.raw`foreach ($i in 1..2) { Write-Output "Line $i" }; Write-Output 'C:\owned\fixture'`
		vi.mocked(execFileSync).mockReturnValue("Line 1\r\nLine 2\r\n")
		// Keep the old shell-based path observable without executing a command.
		vi.mocked(execSync).mockReturnValue("Line 1\r\nLine 2\r\n")
		const result = await chunks(command)
		expect(execFileSync).toHaveBeenCalledExactlyOnceWith(
			"pwsh",
			["-NoProfile", "-NonInteractive", "-Command", command],
			{
				encoding: "utf8",
				maxBuffer: 100 * 1024 * 1024,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			},
		)
		expect(execSync).not.toHaveBeenCalled()
		expect(result).toEqual({
			output: ["\x1b]633;C\x07", "Line 1\nLine 2\n", "\x1b]633;D\x07"],
			exitCode: 0,
		})
	})

	it("preserves a failed command's stdout and nonzero exit status", async () => {
		const fail = () => {
			throw Object.assign(new Error("owned command failed"), {
				status: 7,
				stdout: Buffer.from("partial output\r\n"),
				stderr: Buffer.from("owned failure detail"),
			})
		}
		vi.mocked(execFileSync).mockImplementation(fail)
		vi.mocked(execSync).mockImplementation(fail)
		expect(await chunks("exit 7")).toEqual({
			output: ["\x1b]633;C\x07", "partial output\n", "\x1b]633;D\x07"],
			exitCode: 7,
		})
	})

	it("reports spawn failures with a failed status and complete stream markers", async () => {
		const fail = () => {
			throw Object.assign(new Error("owned spawn failure"), { code: "ENOENT" })
		}
		vi.mocked(execFileSync).mockImplementation(fail)
		vi.mocked(execSync).mockImplementation(fail)
		expect(await chunks("Write-Output 'owned'")).toEqual({
			output: ["\x1b]633;C\x07", "\x1b]633;D\x07"],
			exitCode: 1,
		})
	})
})
