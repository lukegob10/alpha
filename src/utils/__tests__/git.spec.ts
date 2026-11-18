import { ExecException } from "child_process"

import { checkGitInstalled, searchCommits, getCommitInfo, getWorkingState, getGitStatus } from "../git"
import { truncateOutput } from "../../integrations/misc/extract-text"

type CallbackProcessFunction = (...args: any[]) => void

// Mock child_process process helpers.
vitest.mock("child_process", () => ({
	exec: vitest.fn(),
	execFile: vitest.fn(),
}))

// Mock util.promisify to return our own mock function
vitest.mock("util", () => ({
	promisify: vitest.fn((fn: CallbackProcessFunction) => {
		return async (...args: any[]) => {
			// Call the original mock to maintain the mock implementation
			return new Promise((resolve, reject) => {
				const callbackArgs = args.length === 1 ? [args[0], {}] : args
				fn(...callbackArgs, (error: ExecException | null, result?: { stdout: string; stderr: string }) => {
					if (error) {
						reject(error)
					} else {
						resolve(result!)
					}
				})
			})
		}
	}),
}))

// Mock extract-text
vitest.mock("../../integrations/misc/extract-text", () => ({
	truncateOutput: vitest.fn((text) => text),
}))

import { exec, execFile } from "child_process"

function renderLegacyGitCommand(file: string, args: readonly string[]): string {
	const renderedArgs = args.map((arg) => {
		if (arg.startsWith("--format=")) return `--format="${arg.slice("--format=".length)}"`
		if (arg.startsWith("--grep=")) return `--grep="${arg.slice("--grep=".length)}"`
		return arg
	})
	return [file, ...renderedArgs].join(" ")
}

describe("git utils", () => {
	const cwd = "/test/path"

	beforeEach(() => {
		vitest.clearAllMocks()
		// Keep the legacy command-response fixtures below focused on returned data.
		// Security regressions assert the real argv boundary directly.
		vitest
			.mocked(execFile)
			.mockImplementation(((file: string, args: string[], options: any, callback: any) =>
				vitest.mocked(exec)(renderLegacyGitCommand(file, args), options, callback)) as any)
	})

	describe("checkGitInstalled", () => {
		it("should return true when git --version succeeds", async () => {
			vitest.mocked(exec).mockImplementation((command: string, options: any, callback: any) => {
				if (command === "git --version") {
					callback(null, { stdout: "git version 2.39.2", stderr: "" })
					return {} as any
				}
				callback(new Error("Unexpected command"))
				return {} as any
			})

			const result = await checkGitInstalled()
			expect(result).toBe(true)
			expect(vitest.mocked(exec)).toHaveBeenCalledWith("git --version", {}, expect.any(Function))
		})

		it("should return false when git --version fails", async () => {
			vitest.mocked(exec).mockImplementation((command: string, options: any, callback: any) => {
				if (command === "git --version") {
					callback(new Error("git not found"))
					return {} as any
				}
				callback(new Error("Unexpected command"))
				return {} as any
			})

			const result = await checkGitInstalled()
			expect(result).toBe(false)
			expect(vitest.mocked(exec)).toHaveBeenCalledWith("git --version", {}, expect.any(Function))
		})

		it("should handle unexpected errors gracefully", async () => {
			vitest.mocked(exec).mockImplementation((command: string, options: any, callback: any) => {
				if (command === "git --version") {
					// Simulate an unexpected error
					callback(new Error("Unexpected system error"))
					return {} as any
				}
				callback(new Error("Unexpected command"))
				return {} as any
			})

			const result = await checkGitInstalled()
			expect(result).toBe(false)
			expect(vitest.mocked(exec)).toHaveBeenCalledWith("git --version", {}, expect.any(Function))
		})
	})

	describe("searchCommits", () => {
		const mockCommitData = [
			"abc123def456",
			"abc123",
			"fix: test commit",
			"John Doe",
			"2024-01-06",
			"def456abc789",
			"def456",
			"feat: new feature",
			"Jane Smith",
			"2024-01-05",
		].join("\n")

		it("should return commits when git is installed and repo exists", async () => {
			// Set up mock responses
			const responses = new Map([
				["git --version", { stdout: "git version 2.39.2", stderr: "" }],
				["git rev-parse --git-dir", { stdout: ".git", stderr: "" }],
				[
					'git log -n 10 --format="%H%n%h%n%s%n%an%n%ad" --date=short --grep="test" --regexp-ignore-case',
					{ stdout: mockCommitData, stderr: "" },
				],
			])

			vitest.mocked(exec).mockImplementation((command: string, options: any, callback: any) => {
				// Find matching response
				for (const [cmd, response] of responses) {
					if (command === cmd) {
						callback(null, response)
						return {} as any
					}
				}
				callback(new Error(`Unexpected command: ${command}`))
			})

			const result = await searchCommits("test", cwd)

			// First verify the result is correct
			expect(result).toHaveLength(2)
			expect(result[0]).toEqual({
				hash: "abc123def456",
				shortHash: "abc123",
				subject: "fix: test commit",
				author: "John Doe",
				date: "2024-01-06",
			})

			// Then verify all commands were called correctly
			expect(vitest.mocked(exec)).toHaveBeenCalledWith("git --version", {}, expect.any(Function))
			expect(vitest.mocked(exec)).toHaveBeenCalledWith("git rev-parse --git-dir", { cwd }, expect.any(Function))
			expect(vitest.mocked(exec)).toHaveBeenCalledWith(
				'git log -n 10 --format="%H%n%h%n%s%n%an%n%ad" --date=short --grep="test" --regexp-ignore-case',
				{ cwd },
				expect.any(Function),
			)
		})

		it("should return empty array when git is not installed", async () => {
			vitest.mocked(exec).mockImplementation((command: string, options: any, callback: any) => {
				if (command === "git --version") {
					callback(new Error("git not found"))
					return {} as any
				}
				callback(new Error("Unexpected command"))
				return {} as any
			})

			const result = await searchCommits("test", cwd)
			expect(result).toEqual([])
			expect(vitest.mocked(exec)).toHaveBeenCalledWith("git --version", {}, expect.any(Function))
		})

		it("should return empty array when not in a git repository", async () => {
			const responses = new Map([
				["git --version", { stdout: "git version 2.39.2", stderr: "" }],
				["git rev-parse --git-dir", null], // null indicates error should be called
			])

			vitest.mocked(exec).mockImplementation((command: string, options: any, callback: any) => {
				const response = responses.get(command)
				if (response === null) {
					callback(new Error("not a git repository"))
					return {} as any
				} else if (response) {
					callback(null, response)
					return {} as any
				} else {
					callback(new Error("Unexpected command"))
					return {} as any
				}
			})

			const result = await searchCommits("test", cwd)
			expect(result).toEqual([])
			expect(vitest.mocked(exec)).toHaveBeenCalledWith("git --version", {}, expect.any(Function))
			expect(vitest.mocked(exec)).toHaveBeenCalledWith("git rev-parse --git-dir", { cwd }, expect.any(Function))
		})

		it("should handle hash search when grep search returns no results", async () => {
			const responses = new Map([
				["git --version", { stdout: "git version 2.39.2", stderr: "" }],
				["git rev-parse --git-dir", { stdout: ".git", stderr: "" }],
				[
					'git log -n 10 --format="%H%n%h%n%s%n%an%n%ad" --date=short --grep="abc123" --regexp-ignore-case',
					{ stdout: "", stderr: "" },
				],
				[
					'git log -n 10 --format="%H%n%h%n%s%n%an%n%ad" --date=short --author-date-order abc123',
					{ stdout: mockCommitData, stderr: "" },
				],
			])

			vitest.mocked(exec).mockImplementation((command: string, options: any, callback: any) => {
				for (const [cmd, response] of responses) {
					if (command === cmd) {
						callback(null, response)
						return {} as any
					}
				}
				callback(new Error("Unexpected command"))
				return {} as any
			})

			const result = await searchCommits("abc123", cwd)
			expect(result).toHaveLength(2)
			expect(result[0]).toEqual({
				hash: "abc123def456",
				shortHash: "abc123",
				subject: "fix: test commit",
				author: "John Doe",
				date: "2024-01-06",
			})
		})

		it("passes shell metacharacters as one literal git argument", async () => {
			const query = 'fix" & echo injected & rem "'
			vitest.mocked(exec).mockImplementation((command: string, options: any, callback: any) => {
				if (command === "git --version") {
					callback(null, { stdout: "git version 2.39.2", stderr: "" })
				} else if (command === "git rev-parse --git-dir") {
					callback(null, { stdout: ".git", stderr: "" })
				} else {
					callback(new Error(`Unexpected shell command: ${command}`))
				}
				return {} as any
			})
			vitest.mocked(execFile).mockImplementation(((
				_file: string,
				_args: string[],
				_options: any,
				callback: any,
			) => {
				callback(null, { stdout: "", stderr: "" })
				return {} as any
			}) as any)

			await searchCommits(query, cwd)

			const [, args, options] = vitest.mocked(execFile).mock.calls[0]
			expect(args).toContain(`--grep=${query}`)
			expect(options).toEqual({ cwd })
			expect(vitest.mocked(exec).mock.calls.flatMap(([command]) => String(command))).not.toContain(query)
		})
	})

	describe("getCommitInfo", () => {
		const mockCommitInfo = [
			"abc123def456",
			"abc123",
			"fix: test commit",
			"John Doe",
			"2024-01-06",
			"Detailed description",
		].join("\n")
		const mockStats = "1 file changed, 2 insertions(+), 1 deletion(-)"
		const mockDiff = "@@ -1,1 +1,2 @@\n-old line\n+new line"

		it("should return formatted commit info", async () => {
			const responses = new Map([
				["git --version", { stdout: "git version 2.39.2", stderr: "" }],
				["git rev-parse --git-dir", { stdout: ".git", stderr: "" }],
				[
					'git show --format="%H%n%h%n%s%n%an%n%ad%n%b" --no-patch abc123',
					{ stdout: mockCommitInfo, stderr: "" },
				],
				['git show --stat --format="" abc123', { stdout: mockStats, stderr: "" }],
				['git show --format="" abc123', { stdout: mockDiff, stderr: "" }],
			])

			vitest.mocked(exec).mockImplementation((command: string, options: any, callback: any) => {
				for (const [cmd, response] of responses) {
					if (command.startsWith(cmd)) {
						callback(null, response)
						return {} as any
					}
				}
				callback(new Error("Unexpected command"))
				return {} as any
			})

			const result = await getCommitInfo("abc123", cwd)
			expect(result).toContain("Commit: abc123")
			expect(result).toContain("Author: John Doe")
			expect(result).toContain("Files Changed:")
			expect(result).toContain("Full Changes:")
			expect(vitest.mocked(truncateOutput)).toHaveBeenCalled()
		})

		it("should return error message when git is not installed", async () => {
			vitest.mocked(exec).mockImplementation((command: string, options: any, callback: any) => {
				if (command === "git --version") {
					callback(new Error("git not found"))
					return {} as any
				}
				callback(new Error("Unexpected command"))
				return {} as any
			})

			const result = await getCommitInfo("abc123", cwd)
			expect(result).toBe("Git is not installed")
		})

		it("should return error message when not in a git repository", async () => {
			const responses = new Map([
				["git --version", { stdout: "git version 2.39.2", stderr: "" }],
				["git rev-parse --git-dir", null], // null indicates error should be called
			])

			vitest.mocked(exec).mockImplementation((command: string, options: any, callback: any) => {
				const response = responses.get(command)
				if (response === null) {
					callback(new Error("not a git repository"))
					return {} as any
				} else if (response) {
					callback(null, response)
					return {} as any
				} else {
					callback(new Error("Unexpected command"))
					return {} as any
				}
			})

			const result = await getCommitInfo("abc123", cwd)
			expect(result).toBe("Not a git repository")
		})

		it("rejects non-hash input before invoking git show", async () => {
			const result = await getCommitInfo('abc123" & echo injected', cwd)

			expect(result).toBe("Invalid commit hash")
			expect(execFile).not.toHaveBeenCalled()
			expect(exec).not.toHaveBeenCalled()
		})
	})

	describe("getWorkingState", () => {
		const mockStatus = " M src/file1.ts\n?? src/file2.ts"
		const mockDiff = "@@ -1,1 +1,2 @@\n-old line\n+new line"

		it("should return working directory changes", async () => {
			const responses = new Map([
				["git --version", { stdout: "git version 2.39.2", stderr: "" }],
				["git rev-parse --git-dir", { stdout: ".git", stderr: "" }],
				["git status --short", { stdout: mockStatus, stderr: "" }],
				["git diff HEAD", { stdout: mockDiff, stderr: "" }],
			])

			vitest.mocked(exec).mockImplementation((command: string, options: any, callback: any) => {
				for (const [cmd, response] of responses) {
					if (command === cmd) {
						callback(null, response)
						return {} as any
					}
				}
				callback(new Error("Unexpected command"))
				return {} as any
			})

			const result = await getWorkingState(cwd)
			expect(result).toContain("Working directory changes:")
			expect(result).toContain("src/file1.ts")
			expect(result).toContain("src/file2.ts")
			expect(vitest.mocked(truncateOutput)).toHaveBeenCalled()
		})

		it("should return message when working directory is clean", async () => {
			const responses = new Map([
				["git --version", { stdout: "git version 2.39.2", stderr: "" }],
				["git rev-parse --git-dir", { stdout: ".git", stderr: "" }],
				["git status --short", { stdout: "", stderr: "" }],
			])

			vitest.mocked(exec).mockImplementation((command: string, options: any, callback: any) => {
				for (const [cmd, response] of responses) {
					if (command === cmd) {
						callback(null, response)
						return {} as any
					}
				}
				callback(new Error("Unexpected command"))
				return {} as any
			})

			const result = await getWorkingState(cwd)
			expect(result).toBe("No changes in working directory")
		})

		it("should return error message when git is not installed", async () => {
			vitest.mocked(exec).mockImplementation((command: string, options: any, callback: any) => {
				if (command === "git --version") {
					callback(new Error("git not found"))
					return {} as any
				}
				callback(new Error("Unexpected command"))
				return {} as any
			})

			const result = await getWorkingState(cwd)
			expect(result).toBe("Git is not installed")
		})

		it("should return error message when not in a git repository", async () => {
			const responses = new Map([
				["git --version", { stdout: "git version 2.39.2", stderr: "" }],
				["git rev-parse --git-dir", null], // null indicates error should be called
			])

			vitest.mocked(exec).mockImplementation((command: string, options: any, callback: any) => {
				const response = responses.get(command)
				if (response === null) {
					callback(new Error("not a git repository"))
					return {} as any
				} else if (response) {
					callback(null, response)
					return {} as any
				} else {
					callback(new Error("Unexpected command"))
					return {} as any
				}
			})

			const result = await getWorkingState(cwd)
			expect(result).toBe("Not a git repository")
		})
	})
})

describe("getGitStatus", () => {
	const cwd = "/test/path"

	beforeEach(() => {
		vitest.clearAllMocks()
	})

	function mockStatus(outcome: string | Error) {
		vitest.mocked(execFile).mockImplementationOnce(((_file, _args, _options, callback: CallbackProcessFunction) => {
			if (outcome instanceof Error) callback(outcome)
			else callback(null, { stdout: outcome, stderr: "" })
			return {} as ReturnType<typeof execFile>
		}) as typeof execFile)
	}

	it("returns branch and file status with a single direct Git invocation", async () => {
		const output = [
			"## main...origin/main [ahead 2, behind 1]",
			"M  src/staged-file.ts",
			" M src/unstaged-file.ts",
			"MM src/both-modified.ts",
			"?? src/untracked-file.ts",
		].join("\n")
		mockStatus(output)

		expect(await getGitStatus(cwd)).toBe(output)
		expect(execFile).toHaveBeenCalledExactlyOnceWith(
			"git",
			["status", "--porcelain=v1", "--branch"],
			{ cwd, signal: undefined },
			expect.any(Function),
		)
		expect(exec).not.toHaveBeenCalled()
	})

	it("returns only branch status when maxFiles is zero", async () => {
		mockStatus("## main...origin/main\nM  src/file1.ts\n?? src/file2.ts")
		expect(await getGitStatus(cwd, 0)).toBe("## main...origin/main")
	})

	it("returns null when Git is unavailable without probing the repository", async () => {
		mockStatus(Object.assign(new Error("git not found"), { code: "ENOENT" }))
		expect(await getGitStatus(cwd)).toBeNull()
		expect(execFile).toHaveBeenCalledOnce()
		expect(exec).not.toHaveBeenCalled()
	})

	it("returns null without logging when the working directory is outside a repository", async () => {
		const error = Object.assign(new Error("not a git repository"), { code: 128 })
		mockStatus(error)
		vitest.mocked(exec).mockImplementationOnce((_command, _options, callback?: CallbackProcessFunction) => {
			callback?.(error)
			return {} as ReturnType<typeof exec>
		})
		const log = vitest.spyOn(console, "error").mockImplementation(() => {})
		try {
			expect(await getGitStatus(cwd)).toBeNull()
			expect(log).not.toHaveBeenCalled()
			expect(exec).toHaveBeenCalledExactlyOnceWith("git rev-parse --git-dir", { cwd }, expect.any(Function))
		} finally {
			log.mockRestore()
		}
	})

	it("diagnoses a failed status command inside a repository", async () => {
		const error = Object.assign(new Error("status output couldn't be collected"), { code: 128 })
		mockStatus(error)
		vitest.mocked(exec).mockImplementationOnce((_command, _options, callback?: CallbackProcessFunction) => {
			callback?.(null, { stdout: ".git", stderr: "" })
			return {} as ReturnType<typeof exec>
		})
		const log = vitest.spyOn(console, "error").mockImplementation(() => {})
		try {
			expect(await getGitStatus(cwd)).toBeNull()
			expect(log).toHaveBeenCalledExactlyOnceWith("Error getting git status:", error)
		} finally {
			log.mockRestore()
		}
	})

	it("truncates file entries while preserving the branch", async () => {
		mockStatus(["## main", ...Array.from({ length: 29 }, (_, index) => `M  file${index + 1}.ts`)].join("\n"))

		const result = await getGitStatus(cwd, 10)
		expect(result).toContain("## main")
		expect(result).toContain("M  file1.ts")
		expect(result).toContain("... 19 more files")
		expect(result).not.toContain("file15.ts")
	})

	it("returns null when status is empty", async () => {
		mockStatus("")
		expect(await getGitStatus(cwd)).toBeNull()
	})

	it("passes the abort signal to its single status process", async () => {
		const controller = new AbortController()
		mockStatus("## main\nM  src/file.ts")

		expect(await getGitStatus(cwd, 20, controller.signal)).toBe("## main\nM  src/file.ts")
		expect(execFile).toHaveBeenCalledExactlyOnceWith(
			"git",
			["status", "--porcelain=v1", "--branch"],
			{ cwd, signal: controller.signal },
			expect.any(Function),
		)
		expect(exec).not.toHaveBeenCalled()
	})

	it("propagates an already-aborted signal without starting Git", async () => {
		const controller = new AbortController()
		const reason = new Error("git status cancelled before start")
		controller.abort(reason)

		await expect(getGitStatus(cwd, 20, controller.signal)).rejects.toBe(reason)
		expect(execFile).not.toHaveBeenCalled()
		expect(exec).not.toHaveBeenCalled()
	})

	it("propagates a status abort without starting a repository probe", async () => {
		const controller = new AbortController()
		const reason = new Error("git status cancelled")
		vitest.mocked(execFile).mockImplementationOnce(((_file, _args, _options, callback: CallbackProcessFunction) => {
			controller.abort(reason)
			callback(reason)
			return {} as ReturnType<typeof execFile>
		}) as typeof execFile)

		await expect(getGitStatus(cwd, 20, controller.signal)).rejects.toBe(reason)
		expect(execFile).toHaveBeenCalledOnce()
		expect(exec).not.toHaveBeenCalled()
	})
})
