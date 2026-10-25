import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ execa: vi.fn() }))
vi.mock("execa", () => ({ execa: mocks.execa }))

import { ExecaHarnessProcessRunner } from "../processRunner"
import { systemClock } from "../systemPorts"
import { CommandGrader } from "../../grading/plugins/command"

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

	it.each([
		{ exitCode: 0, isMaxBuffer: true },
		{ exitCode: 7, isMaxBuffer: true },
		{ exitCode: 0, isCanceled: true },
		{ exitCode: 7, isCanceled: true },
		{ exitCode: 0, isTerminated: true },
		{ exitCode: 0, failed: true },
	])("does not credit incomplete execution as a command verdict: %j", async (failure) => {
		mocks.execa.mockResolvedValue({
			stdout: "partial",
			stderr: "diagnostic",
			timedOut: false,
			failed: true,
			...failure,
		})
		const result = await new ExecaHarnessProcessRunner().run({
			command: "node",
			args: [],
			timeoutMs: 100,
			maxOutputBytes: 16,
		})
		expect(result.exitCode).toBeNull()
		expect(result.fullStdout).toBe("partial")
		if ("isMaxBuffer" in failure) expect(result.outputTruncated).toBe(true)
	})

	it("preserves a completed nonzero command exit as a quality verdict", async () => {
		mocks.execa.mockResolvedValue({
			exitCode: 7,
			failed: true,
			stdout: "",
			stderr: "assertion failed",
			timedOut: false,
		})
		const result = await new ExecaHarnessProcessRunner().run({
			command: "node",
			args: [],
			timeoutMs: 100,
			maxOutputBytes: 32,
		})
		expect(result).toMatchObject({ exitCode: 7, timedOut: false, outputTruncated: false })
	})

	it("classifies a real Execa output collector limit independently from its process exit", async () => {
		const actual = await vi.importActual<typeof import("execa")>("execa")
		let maxBufferReached = false
		mocks.execa.mockImplementation(async (command: string, args: string[], options: Record<string, unknown>) => {
			const result = await actual.execa(command, args, { ...options, reject: false, maxBuffer: 64 })
			maxBufferReached = result.isMaxBuffer
			return result
		})
		const result = await new ExecaHarnessProcessRunner().run({
			command: process.execPath,
			args: ["-e", "process.stdout.write('x'.repeat(4096))"],
			env: {},
			timeoutMs: 5000,
			maxOutputBytes: 16,
		})
		expect(maxBufferReached).toBe(true)
		expect(result).toMatchObject({ exitCode: null, outputTruncated: true })
	})

	it.each([{ isMaxBuffer: true }, { isCanceled: true }])(
		"reports operational failure %j as a grader error instead of crediting quality",
		async (failure) => {
			mocks.execa.mockResolvedValue({
				exitCode: 0,
				stdout: "partial",
				stderr: "",
				failed: true,
				timedOut: false,
				...failure,
			})
			const result = await new CommandGrader().execute(
				{
					id: "bounded-verifier",
					version: 1,
					type: "command",
					hardGate: true,
					failureClass: "outcome",
					commands: [{ command: "node", args: [] }],
					cwd: "workspace",
					timeoutMs: 100,
					maxOutputBytes: 16,
				},
				{
					workspaceRoot: process.cwd(),
					changedPaths: [],
					trace: [],
					processRunner: new ExecaHarnessProcessRunner(),
					clock: systemClock,
				},
			)
			expect(result.status).toBe("error")
			expect(result.diagnostics).toEqual(
				expect.arrayContaining([expect.objectContaining({ code: "command_incomplete" })]),
			)
		},
	)
})
