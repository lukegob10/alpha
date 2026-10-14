import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { Task } from "../Task"

describe("Task diagnostic evidence authority", () => {
	let storageRoot: string

	beforeEach(async () => {
		storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-diagnostic-evidence-"))
	})

	afterEach(async () => {
		await fs.rm(storageRoot, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	function makeTask(overrides: Record<string, unknown> = {}): Task {
		return Object.assign(Object.create(Task.prototype), {
			diagnosticSession: true,
			diagnosticSourceTaskId: "source-task-1",
			globalStoragePath: storageRoot,
			...overrides,
		}) as Task
	}

	it("denies evidence reads without persisted diagnostic authority", async () => {
		await expect(makeTask({ diagnosticSession: false }).readDiagnosticEvidence()).rejects.toThrow(
			"does not have diagnostic evidence authority",
		)
	})

	it("reads absent evidence without creating the source task directory", async () => {
		const evidence = await makeTask().readDiagnosticEvidence()

		expect(evidence.evidence.status).toBe("absent")
		await expect(fs.access(path.join(storageRoot, "tasks", "source-task-1"))).rejects.toMatchObject({
			code: "ENOENT",
		})
	})

	it("rejects a symlinked source task directory before reading evidence", async ({ skip }) => {
		const tasksRoot = path.join(storageRoot, "tasks")
		const sourceDirectory = path.join(tasksRoot, "source-task-1")
		const outsideDirectory = path.join(storageRoot, "outside-source")
		await fs.mkdir(outsideDirectory, { recursive: true })
		await fs.mkdir(tasksRoot, { recursive: true })
		try {
			await fs.symlink(outsideDirectory, sourceDirectory, process.platform === "win32" ? "junction" : "dir")
		} catch {
			skip("This host does not allow creating directory symlinks")
		}

		await expect(makeTask().readDiagnosticEvidence()).rejects.toThrow("not a regular directory")
	})

	it("rejects a task storage root whose resolved path escapes the configured base", async ({ skip }) => {
		const tasksRoot = path.join(storageRoot, "tasks")
		const outsideDirectory = path.join(storageRoot, "outside-tasks")
		await fs.mkdir(path.join(outsideDirectory, "source-task-1"), { recursive: true })
		try {
			await fs.symlink(outsideDirectory, tasksRoot, process.platform === "win32" ? "junction" : "dir")
		} catch {
			skip("This host does not allow creating directory symlinks")
		}

		await expect(makeTask().readDiagnosticEvidence()).rejects.toThrow("escapes its configured storage root")
	})
})
