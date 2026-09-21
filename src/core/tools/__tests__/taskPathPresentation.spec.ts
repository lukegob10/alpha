import fs from "fs"
import os from "os"
import * as path from "path"

import {
	getTaskDisplayPath,
	getTaskReadablePath,
	isTaskPathOutsideWorkspace,
	isWorkerWritePathAllowed,
	normalizeTaskToolArguments,
	redactTaskPrivatePaths,
	resolveTaskWorkspacePath,
} from "../taskPathPresentation"

describe("managed worker path presentation", () => {
	it("uses a primary task's root rather than the foreground workspace", () => {
		const cwd = path.resolve("background-project")
		expect(isTaskPathOutsideWorkspace({ taskKind: "primary", cwd }, path.join(cwd, "file.ts"))).toBe(false)
		expect(
			isTaskPathOutsideWorkspace({ taskKind: "primary", cwd }, path.resolve("foreground-project/file.ts")),
		).toBe(true)
	})

	const testRoot = path.join(process.cwd(), ".test-path-presentation")
	const privateRoot = path.join(testRoot, "global-storage", "change-set")
	const privateWorkspace = path.join(privateRoot, "repo")
	const logicalWorkspace = path.join(testRoot, "workspace")
	const task = {
		taskKind: "subagent" as const,
		subagentRole: "worker",
		cwd: privateWorkspace,
		historyWorkspacePath: logicalWorkspace,
		subagentPrivateWorkspaceRoot: privateRoot,
	}

	it("uses logical relative labels and workspace containment", () => {
		expect(getTaskReadablePath(task, ".")).toBe(".")
		expect(getTaskReadablePath(task, path.join("docs", "report.md"))).toBe("docs/report.md")
		expect(isTaskPathOutsideWorkspace(task, path.join(privateWorkspace, "docs", "report.md"))).toBe(false)
		expect(isTaskPathOutsideWorkspace(task, path.join(privateRoot, "support.txt"))).toBe(true)
	})

	it("maps navigation metadata back to the user workspace", () => {
		expect(getTaskDisplayPath(task, path.join(privateWorkspace, "docs", "report.md"))).toBe(
			path.join(logicalWorkspace, "docs", "report.md"),
		)
	})

	it("treats existing and not-yet-created targets through an outward symlink as outside", () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-task-path-"))
		try {
			const workerRoot = path.join(tempRoot, "worker")
			const outsideRoot = path.join(tempRoot, "outside")
			fs.mkdirSync(workerRoot)
			fs.mkdirSync(outsideRoot)
			fs.writeFileSync(path.join(outsideRoot, "existing.txt"), "outside")
			fs.symlinkSync(
				outsideRoot,
				path.join(workerRoot, "linked"),
				process.platform === "win32" ? "junction" : "dir",
			)

			const linkedTask = { taskKind: "subagent" as const, subagentRole: "worker", cwd: workerRoot }
			expect(isTaskPathOutsideWorkspace(linkedTask, path.join(workerRoot, "linked", "existing.txt"))).toBe(true)
			expect(isTaskPathOutsideWorkspace(linkedTask, path.join(workerRoot, "linked", "new.txt"))).toBe(true)
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true })
		}
	})

	it("redacts native and posix private paths from arbitrary output", () => {
		const output = `${path.join(privateWorkspace, "docs", "report.md")}\n${privateWorkspace.toPosix()}/src/index.ts`
		const redacted = redactTaskPrivatePaths(task, output)

		expect(redacted).not.toContain(privateRoot)
		expect(redacted).not.toContain(privateRoot.toPosix())
		expect(redacted).toContain(`.${path.sep}docs${path.sep}report.md`)
	})

	it("treats a logical workspace absolute path as in-scope after rewrite", () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-worker-rewrite-"))
		try {
			const logicalWorkspace = path.join(tempRoot, "workspace")
			const worktree = path.join(tempRoot, "worktree")
			fs.mkdirSync(path.join(logicalWorkspace, "src"), { recursive: true })
			fs.mkdirSync(path.join(worktree, "src"), { recursive: true })
			fs.writeFileSync(path.join(worktree, "src", "foo.ts"), "export const foo = 1\n")
			const worker = {
				taskKind: "subagent" as const,
				subagentRole: "worker" as const,
				cwd: worktree,
				historyWorkspacePath: logicalWorkspace,
				subagentWriteScope: ["src"],
				subagentAuthority: { role: "worker" as const, fileWriteScope: [] as string[] },
			}
			const logicalAbsolute = path.join(logicalWorkspace, "src", "foo.ts")
			expect(isTaskPathOutsideWorkspace(worker, logicalAbsolute)).toBe(false)
			expect(resolveTaskWorkspacePath(worker, logicalAbsolute)).toBe(path.join(worktree, "src", "foo.ts"))
			expect(getTaskReadablePath(worker, logicalAbsolute)).toBe("src/foo.ts")
			expect(isWorkerWritePathAllowed(worker, logicalAbsolute)).toBe(true)
			expect(isWorkerWritePathAllowed(worker, "src/foo.ts")).toBe(true)
			expect(isTaskPathOutsideWorkspace(worker, path.join(tempRoot, "other", "file.ts"))).toBe(true)
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true })
		}
	})

	it("does not allow a worker write onto the live parent tree", () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-worker-parent-"))
		try {
			const logicalWorkspace = path.join(tempRoot, "workspace")
			const worktree = path.join(tempRoot, "worktree")
			fs.mkdirSync(path.join(logicalWorkspace, "src"), { recursive: true })
			fs.mkdirSync(path.join(worktree, "src"), { recursive: true })
			fs.writeFileSync(path.join(logicalWorkspace, "src", "foo.ts"), "parent\n")
			fs.writeFileSync(path.join(worktree, "src", "foo.ts"), "worktree\n")
			const worker = {
				taskKind: "subagent" as const,
				subagentRole: "worker" as const,
				cwd: worktree,
				historyWorkspacePath: logicalWorkspace,
				subagentWriteScope: ["src"],
				subagentAuthority: { role: "worker" as const, fileWriteScope: [] as string[] },
			}
			const rewritten = resolveTaskWorkspacePath(worker, path.join(logicalWorkspace, "src", "foo.ts"))
			expect(rewritten).toBe(path.join(worktree, "src", "foo.ts"))
			expect(rewritten).not.toBe(path.join(logicalWorkspace, "src", "foo.ts"))
			expect(isWorkerWritePathAllowed(worker, path.join(logicalWorkspace, "src", "foo.ts"))).toBe(true)
			expect(fs.readFileSync(path.join(logicalWorkspace, "src", "foo.ts"), "utf8")).toBe("parent\n")
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true })
		}
	})

	it("rejects a junction escape from worker write-scope", () => {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-worker-junction-"))
		try {
			const worktree = path.join(tempRoot, "worktree")
			const outside = path.join(tempRoot, "outside")
			fs.mkdirSync(path.join(worktree, "src"), { recursive: true })
			fs.mkdirSync(outside)
			fs.writeFileSync(path.join(outside, "secret.ts"), "secret\n")
			fs.symlinkSync(
				outside,
				path.join(worktree, "src", "linked"),
				process.platform === "win32" ? "junction" : "dir",
			)
			const worker = {
				taskKind: "subagent" as const,
				subagentRole: "worker" as const,
				cwd: worktree,
				historyWorkspacePath: path.join(tempRoot, "workspace"),
				subagentWriteScope: ["src"],
				subagentAuthority: { role: "worker" as const, fileWriteScope: [] as string[] },
			}
			expect(isTaskPathOutsideWorkspace(worker, path.join(worktree, "src", "linked", "secret.ts"))).toBe(true)
			expect(isWorkerWritePathAllowed(worker, path.join(worktree, "src", "linked", "secret.ts"))).toBe(false)
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true })
		}
	})

	it("normalizes nested file and patch destinations onto the worktree without rewriting shell text", () => {
		const logicalFile = path.join(logicalWorkspace, "src", "nested", "foo.ts")
		const remappedWrite = normalizeTaskToolArguments(task, "write_to_file", {
			path: logicalFile,
			content: "ok",
		})
		expect(remappedWrite.path).toBe("src/nested/foo.ts")

		const remappedRead = normalizeTaskToolArguments(task, "read_file", {
			files: [{ path: logicalFile, line_ranges: [{ start: 1, end: 2 }] }],
		})
		expect(remappedRead.files).toEqual([{ path: "src/nested/foo.ts", line_ranges: [{ start: 1, end: 2 }] }])

		const remappedPatch = normalizeTaskToolArguments(task, "apply_patch", {
			patch: `*** Begin Patch\n*** Add File: ${logicalFile}\n+ok\n*** End Patch`,
		})
		expect(String(remappedPatch.patch)).toContain("*** Add File: src/nested/foo.ts")
		expect(String(remappedPatch.patch)).not.toContain(logicalWorkspace)

		const shell = normalizeTaskToolArguments(task, "shell", {
			command: `echo leaked > "${logicalFile}"`,
			cwd: logicalWorkspace,
		})
		expect(shell.command).toBe(`echo leaked > "${logicalFile}"`)
		expect(shell.cwd).toBe(".")
	})

	it("redacts the managed worktree from a generated system prompt", () => {
		const generatedPrompt = [
			"SYSTEM INFORMATION",
			`Current Workspace Directory: ${privateWorkspace.toPosix()}`,
			`Inspect ${path.join(privateWorkspace, "src", "index.ts")}`,
		].join("\n")

		const presentedPrompt = redactTaskPrivatePaths(task, generatedPrompt)

		expect(presentedPrompt).not.toContain(privateRoot)
		expect(presentedPrompt).not.toContain(privateRoot.toPosix())
		expect(presentedPrompt).toContain("Current Workspace Directory: .")
		expect(presentedPrompt).toContain(`Inspect .${path.sep}src${path.sep}index.ts`)
	})
})
