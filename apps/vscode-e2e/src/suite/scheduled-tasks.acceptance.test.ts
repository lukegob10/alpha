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
	type AlphaCodeSettings,
	type ScheduledTaskRun,
	type SkillMetadata,
} from "@alpha-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"
import {
	FeatureScriptedAI,
	featureSkillName,
	assertFeatureToolResult,
	assertFeatureCommandResult,
} from "../scenarios/featureWorkflowFixture"
import { addFilePatch } from "../scenarios/scriptedPatch"
import {
	SCHEDULED_FOREGROUND_PROMPT,
	SCHEDULED_FOREGROUND_RESPONSE,
	SCHEDULED_RECEIPT_CONTENT,
	SCHEDULED_VERIFIER_SOURCE,
	scheduledForegroundInput,
} from "../scenarios/scheduledAgentFixture"

type ScheduledTaskHost = {
	getState(): ScheduledTaskState
	createTask(payload: CreateScheduledTaskPayload): Promise<ScheduledTask>
	updateTask(id: string, payload: UpdateScheduledTaskPayload): Promise<void>
	duplicateTask(id: string): Promise<void>
	pauseTask(id: string): Promise<void>
	resumeTask(id: string): Promise<void>
	deleteTask(id: string): Promise<void>
	runNow(id: string): Promise<void>
	tick(): Promise<void>
	store: { completeRun(run: ScheduledTaskRun): Promise<unknown> }
}

function host() {
	assert.equal(vscode.version, "1.138.0")
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

	test("runs a captured skill/profile beside foreground and retries terminal storage without rerunning the agent", async () => {
		const { service, workspace, storage } = host()
		type ScheduledAgentTask = {
			taskId: string
			taskAsk?: { ask?: string }
			start(): void
			abortTask(): Promise<void>
			getTaskApprovalMode(): string
			handleWebviewAskResponse(response: "messageResponse", text: string): boolean
			getTaskApiConfigName(): Promise<string | undefined>
		}
		const provider = (
			globalThis.api as unknown as {
				sidebarProvider: {
					createTask(
						text: string,
						images: undefined,
						parent: undefined,
						options: { startTask: false },
						configuration: AlphaCodeSettings,
					): Promise<ScheduledAgentTask>
					getCurrentTask(): ScheduledAgentTask | undefined
					getLiveTask(id: string): ScheduledAgentTask | undefined
					upsertProviderProfile(
						name: string,
						settings: AlphaCodeSettings,
						activate: false,
					): Promise<string | undefined>
					deleteProviderProfile(profile: { id: string; name: string }): Promise<void>
					getSkillsManager(): {
						refreshSkills(): Promise<SkillMetadata[]>
						getSkillsForMode(mode: string): SkillMetadata[]
					}
				}
			}
		).sidebarProvider
		const original = globalThis.api.getConfiguration()
		const directory = await fs.mkdtemp(path.join(workspace, "scheduled-agent-"))
		const relative = path.relative(workspace, directory).replaceAll("\\", "/")
		const skillName = featureSkillName(directory)
		const skillDirectory = path.join(workspace, ".alpha", "skills", skillName)
		const marker = `CAPTURED_SCHEDULE_SKILL_${skillName}`
		const model: FeatureScriptedAI = new FeatureScriptedAI((request) => {
			const history = JSON.stringify(request.messages)
			if (history.includes(SCHEDULED_FOREGROUND_PROMPT)) {
				// A command approval owns the shared mutation gate. Keep input pending until the scheduled edit settles,
				// then probe command authority without making the fixture wait behind its own foreground mutation.
				if (request.ordinal === 1) return scheduledForegroundInput()
				assert.equal(
					request.ordinal,
					2,
					"The foreground must retain its independent approval barrier after input",
				)
				return { name: "exec_command", arguments: { cmd: `node "${relative}/foreground.cjs"` } }
			}
			if (request.ordinal === 1) {
				assert.ok(history.includes(marker), "The scheduled skill must be resolved before agent admission")
				return { name: "skill", arguments: { skill: skillName } }
			}
			if (request.ordinal === 2) {
				assertFeatureToolResult(request.messages, `${model.id}-1`, { error: false, marker })
				return {
					name: "apply_patch",
					arguments: { patch: addFilePatch(`${relative}/receipt.txt`, SCHEDULED_RECEIPT_CONTENT) },
				}
			}
			if (request.ordinal === 3)
				return { name: "exec_command", arguments: { cmd: `node "${relative}/verify.cjs"` } }
			assert.equal(request.ordinal, 4)
			assertFeatureCommandResult(request.messages, `${model.id}-3`, { exitCode: 0, marker: "SCHEDULE_VERIFIED" })
			return undefined
		})
		const profileName = `Owned scheduled profile ${skillName}`
		let profileId: string | undefined
		let foreground: ScheduledAgentTask | undefined
		let schedule: ScheduledTask | undefined
		const completeRun = service.store.completeRun
		let failedWrites = 0
		let terminalAttempts = 0
		const diagnostics = () => {
			const run = service.getState().runs.find((item) => item.taskId === schedule?.id)
			return {
				foregroundAsk: foreground?.taskAsk?.ask,
				foregroundApproval: foreground?.getTaskApprovalMode(),
				runStatus: run?.status,
				backgroundAsk: run?.alphaTaskId ? provider.getLiveTask(run.alphaTaskId)?.taskAsk?.ask : undefined,
				failedWrites,
				terminalAttempts,
				requests: model.requests.slice(-8).map(({ taskId, ordinal }) => ({ taskId, ordinal })),
			}
		}
		try {
			await fs.mkdir(skillDirectory, { recursive: true })
			await fs.writeFile(
				path.join(skillDirectory, "SKILL.md"),
				`---\nname: ${skillName}\ndescription: Owned scheduled agent fixture\n---\n${marker}\nCreate ${relative}/receipt.txt with SCHEDULE_EFFECT and run node "${relative}/verify.cjs".\n`,
			)
			await fs.writeFile(path.join(directory, "verify.cjs"), SCHEDULED_VERIFIER_SOURCE)
			await fs.writeFile(
				path.join(directory, "foreground.cjs"),
				"require('node:fs').writeFileSync(require('node:path').join(__dirname,'foreground-effect.txt'),'unapproved foreground effect')\n",
			)
			const configuration: AlphaCodeSettings = {
				...original,
				apiProvider: "fake-ai",
				fakeAi: model,
				mode: "code",
				approvalMode: "ask",
				enableCheckpoints: false,
				requestDelaySeconds: 0,
				writeDelayMs: 0,
			}
			foreground = await provider.createTask(
				SCHEDULED_FOREGROUND_PROMPT,
				undefined,
				undefined,
				{ startTask: false },
				configuration,
			)
			foreground.start()
			await waitFor(
				() => {
					model.assertHealthy()
					return foreground?.taskAsk?.ask === "followup"
				},
				{
					description: "the foreground task waiting for input without owning the workspace mutation gate",
					onTimeout: diagnostics,
				},
			)
			profileId = await provider.upsertProviderProfile(
				profileName,
				{ apiProvider: "fake-ai", fakeAi: model },
				false,
			)
			assert.ok(profileId)
			await provider.getSkillsManager().refreshSkills()
			const skill = provider
				.getSkillsManager()
				.getSkillsForMode("code")
				.find((entry) => entry.name === skillName)
			assert.ok(skill)
			const foregroundConfiguration = structuredClone(globalThis.api.getConfiguration())
			schedule = await service.createTask({
				...payload(workspace, "Captured agent schedule"),
				mode: "code",
				apiConfig: { id: profileId, name: profileName },
				execution: { type: "skill", skillName, skillPath: skill.path },
				reasoningPreference: { kind: "default" },
			})
			service.store.completeRun = async (run) => {
				if (run.taskId === schedule!.id && run.status === "succeeded") {
					terminalAttempts++
					if (failedWrites === 0) {
						failedWrites++
						throw new Error("Owned scheduled terminal storage failure")
					}
				}
				return completeRun.call(service.store, run)
			}
			await service.runNow(schedule.id)
			await waitFor(
				() => {
					model.assertHealthy()
					return failedWrites === 1
				},
				{
					timeout: 60_000,
					description: "the real scheduled agent reaching terminal persistence",
					onTimeout: diagnostics,
				},
			)
			assert.equal(provider.getCurrentTask()?.taskId, foreground.taskId)
			assert.deepEqual(globalThis.api.getConfiguration(), foregroundConfiguration)
			assert.equal(model.requests.filter((request) => request.taskId !== foreground!.taskId).length, 4)
			const running = service.getState().runs.find((run) => run.taskId === schedule!.id)
			assert.ok(running?.alphaTaskId)
			assert.notEqual(running.alphaTaskId, foreground.taskId)
			assert.equal(await provider.getLiveTask(running.alphaTaskId)?.getTaskApiConfigName(), profileName)
			await service.tick()
			await waitFor(
				() => service.getState().runs.some((run) => run.taskId === schedule!.id && run.status === "succeeded"),
				{ description: "terminal storage retry through the production scheduler tick", onTimeout: diagnostics },
			)
			assert.equal(
				model.requests.filter((request) => request.taskId === running.alphaTaskId).length,
				4,
				"Retrying storage must not dispatch another agent request",
			)
			assert.equal(model.requests.filter((request) => request.taskId === foreground!.taskId).length, 1)
			assert.equal(
				foreground.taskAsk?.ask,
				"followup",
				"The schedule cannot answer the foreground task's pending input",
			)
			assert.equal(terminalAttempts, 2, "One failed terminal write and its successful retry are required")
			assert.equal(foreground.getTaskApprovalMode(), "ask")
			assert.equal(foreground.handleWebviewAskResponse("messageResponse", SCHEDULED_FOREGROUND_RESPONSE), true)
			await waitFor(
				() => {
					model.assertHealthy()
					return foreground?.taskAsk?.ask === "command"
				},
				{
					description: "the foreground command retaining its own approval after the scheduled bypass run",
					onTimeout: diagnostics,
				},
			)
			assert.equal(model.requests.filter((request) => request.taskId === foreground!.taskId).length, 2)
			assert.equal(
				foreground.getTaskApprovalMode(),
				"ask",
				"Background bypass authority cannot approve foreground work",
			)
			await assert.rejects(fs.access(path.join(directory, "foreground-effect.txt")), { code: "ENOENT" })
			assert.equal(
				(await fs.readFile(path.join(directory, "receipt.txt"), "utf8")).replace(/\r\n/g, "\n"),
				SCHEDULED_RECEIPT_CONTENT,
			)
			const saved = scheduledTaskRunSchema
				.array()
				.parse(
					JSON.parse(
						await fs.readFile(path.join(storage, "scheduled-tasks", "scheduled_task_runs.json"), "utf8"),
					),
				)
				.filter((run) => run.taskId === schedule!.id)
			assert.equal(saved.length, 1)
			assert.equal(saved[0]!.status, "succeeded")
			assert.equal(saved[0]!.resolvedApiConfig?.id, profileId)
			assert.equal(provider.getCurrentTask()?.taskId, foreground.taskId)
		} finally {
			service.store.completeRun = completeRun
			if (schedule) await service.deleteTask(schedule.id)
			await foreground?.abortTask()
			await globalThis.api.clearCurrentTask()
			if (profileId) await provider.deleteProviderProfile({ id: profileId, name: profileName })
			await globalThis.api.setConfiguration(original)
			model.dispose()
			await fs.rm(skillDirectory, { recursive: true, force: true })
			await fs.rm(directory, { recursive: true, force: true })
			await provider.getSkillsManager().refreshSkills()
		}
	})

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
