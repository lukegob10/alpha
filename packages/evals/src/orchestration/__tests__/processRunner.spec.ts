import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ execa: vi.fn() }))
vi.mock("execa", () => ({ execa: mocks.execa }))

import { ExecaHarnessProcessRunner } from "../processRunner"

describe("ExecaHarnessProcessRunner", () => {
	beforeEach(() => vi.clearAllMocks())

	it("uses structured arguments and bounds captured output", async () => {
		mocks.execa.mockResolvedValue({
			exitCode: 7,
			stdout: "123456",
			stderr: "abcdef",
			timedOut: false,
		})
		const runner = new ExecaHarnessProcessRunner()
		const result = await runner.run({
			command: "docker",
			args: ["run", "image"],
			cwd: "workspace",
			env: { SAFE: "value" },
			timeoutMs: 100,
			maxOutputBytes: 4,
		})
		expect(mocks.execa).toHaveBeenCalledWith("docker", ["run", "image"], {
			cwd: "workspace",
			env: { SAFE: "value" },
			extendEnv: false,
			reject: false,
			timeout: 100,
			killSignal: "SIGKILL",
			maxBuffer: 64 * 1024 * 1024,
		})
		expect(result).toMatchObject({
			exitCode: 7,
			stdout: "1234",
			stderr: "abcd",
			outputTruncated: true,
			fullStdout: "123456",
			fullStderr: "abcdef",
		})
	})

	it("inherits the host environment only when no explicit environment is supplied", async () => {
		mocks.execa.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false })
		await new ExecaHarnessProcessRunner().run({
			command: "true",
			args: [],
			timeoutMs: 100,
			maxOutputBytes: 10,
		})
		expect(mocks.execa).toHaveBeenCalledWith("true", [], expect.objectContaining({ extendEnv: true }))
	})

	it("retains complete output when it is inside the cap", async () => {
		mocks.execa.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false })
		const result = await new ExecaHarnessProcessRunner().run({
			command: "true",
			args: [],
			timeoutMs: 100,
			maxOutputBytes: 10,
		})
		expect(result).toMatchObject({ exitCode: 0, stdout: "ok", outputTruncated: false })
	})

	it("normalizes absent output and an absent exit code", async () => {
		mocks.execa.mockResolvedValue({ exitCode: undefined, stdout: undefined, stderr: undefined, timedOut: true })
		const result = await new ExecaHarnessProcessRunner().run({
			command: "fake",
			args: [],
			timeoutMs: 1,
			maxOutputBytes: 10,
		})
		expect(result).toMatchObject({ exitCode: null, stdout: "", stderr: "", timedOut: true })
	})
})
