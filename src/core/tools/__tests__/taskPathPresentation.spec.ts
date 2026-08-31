import fs from "fs"
import os from "os"
import * as path from "path"

import {
	getTaskDisplayPath,
	getTaskReadablePath,
	isTaskPathOutsideWorkspace,
	redactTaskPrivatePaths,
} from "../taskPathPresentation"

describe("managed worker path presentation", () => {
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
