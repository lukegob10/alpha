import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import {
	scheduledTaskRunSchema,
	scheduledTaskSchema,
	type CreateScheduledTaskPayload,
	type ScheduledTask,
	type ScheduledTaskState,
	type UpdateScheduledTaskPayload,
} from "@alpha-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"

type ScheduledTaskHost = {
	getState(): ScheduledTaskState
	createTask(payload: CreateScheduledTaskPayload): Promise<ScheduledTask>
	updateTask(id: string, payload: UpdateScheduledTaskPayload): Promise<void>
	duplicateTask(id: string): Promise<void>
	pauseTask(id: string): Promise<void>
	resumeTask(id: string): Promise<void>
	deleteTask(id: string): Promise<void>
	runNow(id: string): Promise<void>
}

function host() {
	assert.equal(vscode.version, "1.125.0")
	assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
	const workspace = process.env.ALPHA_E2E_WORKSPACE
	assert.ok(workspace)
	const provider = (
		globalThis.api as unknown as {
			sidebarProvider?: {
				getScheduledTaskService(): ScheduledTaskHost | undefined
				contextProxy: { globalStorageUri: vscode.Uri }
			}
		}
	).sidebarProvider
	assert.ok(provider)
	const service = provider.getScheduledTaskService()
	assert.ok(service, "Activation must register the production scheduled-task service")
	return { service, workspace, storage: provider.contextProxy.globalStorageUri.fsPath }
}

function payload(workspace: string, name: string, command = "node --version"): CreateScheduledTaskPayload {
	return {
		name,
		prompt: "Owned scheduled-task host fixture",
		workspace,
		execution: { type: "command", command, timeoutMs: 30_000 },
		autoApproval: { approvalMode: "bypass" },
		reasoningPreference: { kind: "effort", effort: "high" },
		schedule: { type: "once", startAt: Date.now() + 3_600_000, timezone: "UTC" },
		notificationPreference: "never",
	}
}

suite("Scheduled tasks in the exact extension host", function () {
	setDefaultSuiteTimeout(this)

	test("persists edits, duplicates, pause/resume, and deletion without changing foreground settings", async () => {
		const { service, workspace, storage } = host()
		const configuration = structuredClone(globalThis.api.getConfiguration())
		const owned = new Set<string>()
		const task = await service.createTask(payload(workspace, "Scheduled host lifecycle"))
		owned.add(task.id)
		try {
			await service.updateTask(task.id, {
				name: "Updated scheduled host lifecycle",
				reasoningPreference: { kind: "effort", effort: "low" },
				autoApproval: { approvalMode: "ask" },
			})
			await service.duplicateTask(task.id)
			const duplicate = service
				.getState()
				.tasks.find((item) => item.name === "Updated scheduled host lifecycle copy")
			assert.ok(duplicate)
			owned.add(duplicate.id)
			assert.notEqual(duplicate.id, task.id)
			assert.deepEqual(duplicate.reasoningPreference, { kind: "effort", effort: "low" })
			assert.deepEqual(duplicate.autoApproval, { approvalMode: "ask" })
			assert.equal(duplicate.permissions.runCommands, false)
			await service.pauseTask(task.id)
			assert.equal(service.getState().tasks.find((item) => item.id === task.id)?.enabled, false)
			assert.equal(service.getState().tasks.find((item) => item.id === duplicate.id)?.enabled, true)
			await service.resumeTask(task.id)
			const persisted = scheduledTaskSchema
				.array()
				.parse(
					JSON.parse(
						await fs.readFile(path.join(storage, "scheduled-tasks", "scheduled_tasks.json"), "utf8"),
					),
				)
			const saved = persisted.find((item) => item.id === task.id)
			assert.ok(saved)
			assert.equal(saved.enabled, true)
			assert.deepEqual(saved.reasoningPreference, { kind: "effort", effort: "low" })
			assert.deepEqual(saved.autoApproval, { approvalMode: "ask" })
			assert.deepEqual(globalThis.api.getConfiguration(), configuration)
		} finally {
			for (const id of owned) await service.deleteTask(id)
		}
		const persisted = scheduledTaskSchema
			.array()
			.parse(JSON.parse(await fs.readFile(path.join(storage, "scheduled-tasks", "scheduled_tasks.json"), "utf8")))
		assert.ok(persisted.every((item) => !owned.has(item.id)))
	})

	test("rejects a schedule outside the open workspace before persisting it", async () => {
		const { service, workspace } = host()
		const before = service.getState()
		await assert.rejects(
			service.createTask(payload(path.join(workspace, "not-an-open-root"), "Rejected schedule")),
			/workspace must be an open workspace root/,
		)
		assert.deepEqual(service.getState(), before)
	})

	test("skips a concurrent manual run and records exactly one successful command effect", async () => {
		const { service, workspace } = host()
		const folder = await fs.mkdtemp(path.join(workspace, "scheduled-command-"))
		const entered = path.join(folder, "entered")
		const release = path.join(folder, "release")
		const commandFile = path.join(folder, "command.cjs")
		let ownedTask: ScheduledTask | undefined
		try {
			await fs.writeFile(
				commandFile,
				[
					"const fs = require('node:fs')",
					`fs.appendFileSync(${JSON.stringify(entered)}, 'one effect\\n')`,
					"const timer = setInterval(() => {",
					`  if (!fs.existsSync(${JSON.stringify(release)})) return`,
					"  clearInterval(timer)",
					"  clearTimeout(deadline)",
					"  process.stdout.write('Owned scheduled command completed')",
					"}, 10)",
					// Bound the child fixture even if its host exits before releasing the barrier.
					"const deadline = setTimeout(() => { clearInterval(timer); process.exitCode = 1 }, 30_000)",
				].join("\n"),
			)
			const relative = path.relative(workspace, commandFile).replaceAll("\\", "/")
			const task = await service.createTask(payload(workspace, "Scheduled concurrency", `node "${relative}"`))
			ownedTask = task
			await service.runNow(task.id)
			await waitFor(
				() =>
					fs.access(entered).then(
						() => true,
						() => false,
					),
				{
					description: "the owned command entering its barrier",
				},
			)
			await service.runNow(task.id)
			const runs = service.getState().runs.filter((run) => run.taskId === task.id)
			assert.equal(runs.length, 2)
			assert.equal(runs.filter((run) => run.status === "running").length, 1)
			const skipped = runs.find((run) => run.status === "skipped")
			assert.ok(skipped)
			assert.equal(skipped.skipReason, "already_running")
			await fs.writeFile(release, "release")
			await waitFor(
				() => service.getState().runs.some((run) => run.taskId === task.id && run.status === "succeeded"),
				{ description: "the owned scheduled command completing" },
			)
			assert.equal(await fs.readFile(entered, "utf8"), "one effect\n")
			const completed = service
				.getState()
				.runs.find((run) => run.taskId === task.id && run.status === "succeeded")
			assert.equal(completed?.exitCode, 0)
			assert.equal(completed?.output, "Owned scheduled command completed")
		} finally {
			try {
				const task = ownedTask
				if (task) {
					await fs.writeFile(release, "release")
					await waitFor(
						() =>
							service
								.getState()
								.runs.every(
									(run) =>
										run.taskId !== task.id ||
										["succeeded", "failed", "skipped", "canceled"].includes(run.status),
								),
						{ description: "all owned scheduled command runs settling before cleanup" },
					)
				}
			} finally {
				try {
					if (ownedTask) await service.deleteTask(ownedTask.id)
				} finally {
					await fs.rm(folder, { recursive: true, force: true })
				}
			}
		}
	})

	test("honors an explicit command deny rule before any effect even with bypass approval", async () => {
		const { service, workspace } = host()
		const folder = await fs.mkdtemp(path.join(workspace, "scheduled-denied-"))
		let ownedTask: ScheduledTask | undefined
		try {
			const relative = path.relative(workspace, path.join(folder, "effect")).replaceAll("\\", "/")
			const setup = payload(
				workspace,
				"Scheduled explicit deny",
				`node -e "require('node:fs').writeFileSync('${relative}', 'must not run')"`,
			)
			setup.autoApproval = { approvalMode: "bypass", deniedCommands: ["node"] }
			const task = await service.createTask(setup)
			ownedTask = task
			await service.runNow(task.id)
			await waitFor(
				() => service.getState().runs.some((run) => run.taskId === task.id && run.status === "failed"),
				{
					description: "the denied scheduled command settling",
				},
			)
			const runs = service.getState().runs.filter((run) => run.taskId === task.id)
			assert.equal(runs.length, 1)
			const [run] = runs
			assert.ok(run)
			assert.match(run.error ?? "", /explicit deny rule/)
			assert.equal(run.exitCode, undefined)
			await assert.rejects(fs.access(path.join(folder, "effect")), { code: "ENOENT" })
		} finally {
			try {
				if (ownedTask) await service.deleteTask(ownedTask.id)
			} finally {
				await fs.rm(folder, { recursive: true, force: true })
			}
		}
	})

	test("persists a failed command's nonzero exit and output without reporting success", async () => {
		const { service, workspace, storage } = host()
		const task = await service.createTask(
			payload(
				workspace,
				"Scheduled failure",
				`node -e "process.stdout.write('Owned failure output');process.exit(7)"`,
			),
		)
		try {
			await service.runNow(task.id)
			await waitFor(
				() => service.getState().runs.some((run) => run.taskId === task.id && run.status === "failed"),
				{
					description: "the owned failed command settling",
				},
			)
			const runs = service.getState().runs.filter((run) => run.taskId === task.id)
			assert.equal(runs.length, 1)
			const [run] = runs
			assert.ok(run)
			assert.equal(run.exitCode, 7)
			assert.equal(run.output, "Owned failure output")
			assert.ok(run.finishedAt)
			assert.ok(run.error)
			const persisted = scheduledTaskRunSchema
				.array()
				.parse(
					JSON.parse(
						await fs.readFile(path.join(storage, "scheduled-tasks", "scheduled_task_runs.json"), "utf8"),
					),
				)
			// JSON persistence omits optional fields whose live value is undefined.
			const serializedRun = scheduledTaskRunSchema.parse(JSON.parse(JSON.stringify(run)))
			assert.deepEqual(
				persisted.find((item) => item.id === run.id),
				serializedRun,
			)
		} finally {
			await service.deleteTask(task.id)
		}
	})
})
