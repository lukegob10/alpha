import * as childProcess from "child_process"
import * as os from "os"
import * as path from "path"
import { PassThrough } from "stream"

import { clearRipgrepPathCache, regexSearchFiles, resolveRipgrepBinary } from "../index"

vi.mock("child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("child_process")>()),
	spawn: vi.fn(),
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockResolvedValue(true),
}))

const newlineError = 'rg: the literal "\\n" is not allowed in a regex\n\nConsider enabling multiline mode.'
const cwd = os.tmpdir()
const file = path.join(cwd, "source.txt")
const spawn = vi.mocked(childProcess.spawn)

function createProcess() {
	const stdout = new PassThrough()
	const stderr = new PassThrough()
	const child = Object.assign(new childProcess.ChildProcess(), { stdout, stderr })
	const kill = vi.spyOn(child, "kill").mockImplementation(() => {
		queueMicrotask(() => child.emit("close", null, "SIGTERM"))
		return true
	})
	return { child, stdout, stderr, kill }
}

function enqueueProcess(run: (process: ReturnType<typeof createProcess>) => void) {
	const process = createProcess()
	spawn.mockImplementationOnce(() => {
		queueMicrotask(() => run(process))
		return process.child
	})
	return process
}

function matchOutput(text = "alpha\nbeta\n") {
	return [
		JSON.stringify({ type: "begin", data: { path: { text: file } } }),
		JSON.stringify({ type: "match", data: { line_number: 1, lines: { text } } }),
		JSON.stringify({ type: "end" }),
	].join("\n")
}

describe("Ripgrep execution and multiline recovery", () => {
	beforeEach(async () => {
		vi.clearAllMocks()
		spawn.mockReset()
		clearRipgrepPathCache()
		await resolveRipgrepBinary({
			skipRuntimePackageLookup: true,
			env: { PATH: cwd },
			logger: { info: vi.fn(), warn: vi.fn() },
		})
	})

	afterEach(() => {
		clearRipgrepPathCache()
	})

	it.each([newlineError, newlineError.slice(4), "the literal '\"\\n\"' is not allowed in a regex\n"])(
		"retries a newline compilation diagnostic once with the same search arguments: %j",
		async (diagnostic) => {
			enqueueProcess(({ stderr, child }) => {
				stderr.write(diagnostic)
				child.emit("close", 2)
			})
			enqueueProcess(({ stdout, child }) => {
				stdout.write(matchOutput())
				child.emit("close", 0)
			})

			await expect(regexSearchFiles(cwd, cwd, "alpha\\nbeta", "*.txt")).resolves.toContain(
				"  1 | alpha\n  2 | beta",
			)
			expect(spawn).toHaveBeenCalledTimes(2)
			const args = ["--json", "-e", "alpha\\nbeta", "--glob", "*.txt", "--context", "1", "--", cwd]
			expect(spawn.mock.calls[0][1]).toEqual(args)
			expect(spawn.mock.calls[1][1]).toEqual(["--multiline", ...args])
		},
	)

	it.each(["regex parse error: unclosed group", "permission denied", ""])(
		"propagates unrelated failures without retry: %j",
		async (diagnostic) => {
			enqueueProcess(({ stderr, child }) => {
				stderr.write(diagnostic)
				child.emit("close", 2)
			})

			await expect(regexSearchFiles(cwd, cwd, "alpha\\nbeta")).rejects.toThrow(diagnostic || "code 2")
			expect(spawn).toHaveBeenCalledTimes(1)
		},
	)

	it("propagates a failed multiline retry without a third attempt", async () => {
		for (let attempt = 0; attempt < 2; attempt++) {
			enqueueProcess(({ stderr, child }) => {
				stderr.write(newlineError)
				child.emit("close", 2)
			})
		}

		await expect(regexSearchFiles(cwd, cwd, "alpha\\nbeta")).rejects.toThrow(newlineError)
		expect(spawn).toHaveBeenCalledTimes(2)
	})

	it("keeps a valid no-match result without retry", async () => {
		enqueueProcess(({ child }) => child.emit("close", 1))

		await expect(regexSearchFiles(cwd, cwd, "alpha\\s+beta")).resolves.toBe("Found 0 results.")
		expect(spawn).toHaveBeenCalledTimes(1)
	})

	it("prevents a retry when cancellation arrives after the compilation failure", async () => {
		const controller = new AbortController()
		const reason = new Error("cancelled between attempts")
		enqueueProcess(({ stderr, child }) => {
			stderr.write(newlineError)
			child.emit("close", 2)
			controller.abort(reason)
		})

		await expect(regexSearchFiles(cwd, cwd, "alpha\\nbeta", undefined, undefined, controller.signal)).rejects.toBe(
			reason,
		)
		expect(spawn).toHaveBeenCalledTimes(1)
	})

	it.each([
		{ outputMode: "content", retry: false },
		{ outputMode: "content", retry: true },
		{ outputMode: "files", retry: false },
		{ outputMode: "files", retry: true },
		{ outputMode: "count", retry: false },
		{ outputMode: "count", retry: true },
	] as const)(
		"kills the active $outputMode process on cancellation (multiline retry: $retry)",
		async ({ outputMode, retry }) => {
			const controller = new AbortController()
			const reason = new Error("cancelled during search")
			const removeListener = vi.spyOn(controller.signal, "removeEventListener")
			if (retry) {
				enqueueProcess(({ stderr, child }) => {
					stderr.write(newlineError)
					child.emit("close", 2)
				})
			}
			const process = enqueueProcess(({ stdout }) => {
				stdout.write(matchOutput())
				controller.abort(reason)
			})

			await expect(
				regexSearchFiles(cwd, cwd, "alpha\\nbeta", undefined, undefined, controller.signal, { outputMode }),
			).rejects.toBe(reason)
			expect(process.kill).toHaveBeenCalledTimes(1)
			expect(process.stdout.listenerCount("data")).toBe(0)
			expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function))
			expect(spawn).toHaveBeenCalledTimes(retry ? 2 : 1)
		},
	)

	it("preserves UTF-8 across chunk boundaries and accepts a final record without a newline", async () => {
		enqueueProcess(({ stdout, child }) => {
			const output = Buffer.from(matchOutput("αβ\n"))
			const split = output.indexOf(Buffer.from("α")) + 1
			stdout.write(output.subarray(0, split))
			stdout.write(output.subarray(split))
			child.emit("close", 0)
		})

		await expect(regexSearchFiles(cwd, cwd, "αβ")).resolves.toContain("  1 | αβ")
	})

	it.each([
		{ outputMode: "content", budget: "bytes" },
		{ outputMode: "content", budget: "records" },
		{ outputMode: "files", budget: "bytes" },
		{ outputMode: "files", budget: "records" },
		{ outputMode: "count", budget: "bytes" },
		{ outputMode: "count", budget: "records" },
	] as const)(
		"kills the child and preserves partial $outputMode at the $budget budget",
		async ({ outputMode, budget }) => {
			const process = enqueueProcess(({ stdout }) => {
				stdout.write(`${matchOutput()}\n`)
				stdout.write(budget === "bytes" ? "x".repeat(2_000_000) : '{"type":"summary"}\n'.repeat(2_000))
				stdout.write("ignored output after the limit")
			})

			const output = await regexSearchFiles(cwd, cwd, "alpha\\nbeta", undefined, undefined, undefined, {
				outputMode,
			})

			expect(output).toContain("Search output truncated")
			expect(output).toContain(
				outputMode === "content"
					? "  1 | alpha\n  2 | beta"
					: outputMode === "files"
						? "source.txt"
						: "source.txt: 1",
			)
			if (outputMode !== "content") expect(output).not.toMatch(/alpha|beta|\|/)
			if (outputMode === "count") expect(output).toContain("Counts are lower bounds")
			expect(output).not.toContain("ignored output")
			expect(process.kill).toHaveBeenCalledTimes(1)
			expect(process.stdout.listenerCount("data")).toBe(0)
		},
	)

	it.each(["files", "count"] as const)(
		"reports incomplete %s capture without a false empty result",
		async (outputMode) => {
			enqueueProcess(({ stdout }) => stdout.write("x".repeat(2_000_000)))
			const output = await regexSearchFiles(cwd, cwd, "needle", undefined, undefined, undefined, { outputMode })
			expect(output).toContain("Search output truncated")
			expect(output).not.toContain("Found 0")
		},
	)

	it.each(["files", "count"] as const)("caps %s output at 300 unique paths without snippets", async (outputMode) => {
		enqueueProcess(({ stdout, child }) => {
			for (let index = 0; index < 301; index++) {
				stdout.write(
					matchOutput().replaceAll(
						JSON.stringify(file),
						JSON.stringify(path.join(cwd, `file-${index}.txt`)),
					) + "\n",
				)
			}
			child.emit("close", 0)
		})
		const output = await regexSearchFiles(cwd, cwd, "alpha", undefined, undefined, undefined, { outputMode })
		expect(output).toContain("Search output truncated")
		expect(output.match(/^file-\d+\.txt/gm)).toHaveLength(300)
		expect(output).not.toMatch(/file-300\.txt|alpha|beta|\|/)
	})

	it("uses fixed strings and stops after a file's first matching line in files mode", async () => {
		enqueueProcess(({ stdout, child }) => {
			stdout.write(matchOutput("foo(.bar\n"))
			child.emit("close", 0)
		})
		await expect(
			regexSearchFiles(cwd, cwd, "foo(.bar", undefined, undefined, undefined, {
				outputMode: "files",
				literal: true,
			}),
		).resolves.toBe("source.txt")
		expect(spawn.mock.calls[0][1]).toEqual([
			"--json",
			"-e",
			"foo(.bar",
			"--fixed-strings",
			"--max-count",
			"1",
			"--",
			cwd,
		])
	})
})
