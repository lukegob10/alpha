import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import * as vscode from "vscode"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	AlphaCodeEventName,
	type AlphaMessage,
	type ProviderSettings,
	type SubagentGroupState,
} from "@alpha-code/types"
import { TelemetryService } from "@alpha-code/telemetry"
import i18n from "../../../i18n"
import common from "../../../i18n/locales/en/common.json"
import { readTaskMessages } from "../../task-persistence/taskMessages"
import type { AlphaProvider } from "../../webview/AlphaProvider"
import { Task } from "../Task"

// The real Task constructor, mutation queue, save queue, metadata and files stay active.
vi.mock("../../ignore/AlphaIgnoreController", () => ({
	AlphaIgnoreController: class {
		async initialize() {}
		dispose() {}
	},
}))
vi.mock("../../protect/AlphaProtectedController", () => ({ AlphaProtectedController: class {} }))
vi.mock("../../context-tracking/FileContextTracker", () => ({
	FileContextTracker: class {
		dispose() {}
	},
}))
vi.mock("../../../integrations/editor/DiffViewProvider", () => ({
	DiffViewProvider: class {
		isEditing = false
		async reset() {}
		async revertChanges() {}
	},
}))
vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: { getInstance: () => undefined },
}))

type Operation = "create" | "update"
type Settled = { status: "fulfilled" } | { status: "rejected"; error: unknown }

function barrier() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

const fixtures: Array<{
	task: Task
	storage: string
	providers: object[]
	releases: Array<() => void>
	pending: Promise<Settled>[]
}> = []

beforeEach(() => {
	i18n.addResourceBundle("en", "common", common, true, true)
	vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
		get: (_key: string, fallback: unknown) => fallback,
		inspect: () => undefined,
	} as unknown as vscode.WorkspaceConfiguration)
})

afterEach(async () => {
	const owned = fixtures.splice(0)
	for (const fixture of owned) for (const release of fixture.releases) release()
	const failures: unknown[] = []
	for (const fixture of owned) {
		await Promise.all(fixture.pending)
		try {
			await fixture.task["alphaMessagesSaveQueue"]
			fixture.task.dispose({ preserveSharedTaskResources: true, preserveCommandOutputArtifacts: true })
			await fixture.task["goalShutdownPromise"]
		} catch (error) {
			failures.push(error)
		}
		const target = path.resolve(fixture.storage)
		const temporaryRoot = path.resolve(await fs.realpath(os.tmpdir()))
		if (path.dirname(target) !== temporaryRoot || !path.basename(target).startsWith("alpha-group-owner-")) {
			throw new Error("Group owner fixture cleanup escaped its temporary directory")
		}
		await fs.rm(target, { recursive: true, force: true })
	}
	vi.restoreAllMocks()
	if (failures.length) throw new AggregateError(failures, "Group owner fixture cleanup failed")
})

async function fixture(operation: Operation) {
	if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
	const storage = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "alpha-group-owner-"))
	const workspace = path.join(storage, "workspace")
	await fs.mkdir(workspace)
	const state = { mode: "code", autoApprovalEnabled: false, customModes: [], mcpEnabled: false }
	const makeProvider = () => ({
		context: { globalStorageUri: { fsPath: storage } },
		getState: async () => state,
		getValues: () => state,
		getSkillsManager: async () => undefined,
		getMcpHub: () => undefined,
		postStateToWebview: vi.fn(async () => undefined),
		postStateToWebviewWithoutTaskHistory: vi.fn(async () => undefined),
		postTaskStateToWebview: vi.fn(async () => undefined),
		postTaskQueueToWebview: vi.fn(async () => undefined),
		postTaskMessageToWebview: vi.fn(async (_action: string, _taskId: string, _message: AlphaMessage) => undefined),
		postMessageToWebview: vi.fn(async () => undefined),
		updateTaskHistory: vi.fn(async (..._args: unknown[]) => []),
		log: vi.fn(),
	})
	const originalProvider = makeProvider()
	const replacementProvider = makeProvider()
	const configuration: ProviderSettings = {
		apiProvider: "openai",
		openAiModelId: "gpt-6.1-sol",
		openAiApiKey: "synthetic-group-owner-key",
	}
	const task = new Task({
		provider: originalProvider as unknown as AlphaProvider,
		apiConfiguration: configuration,
		taskId: "group-owner-parent",
		task: "Publish a cancelled admission card",
		taskMode: "code",
		taskApiConfigName: "group-owner-fixture",
		workspacePath: workspace,
		startTask: false,
		enableCheckpoints: false,
	})
	const owned = {
		task,
		storage,
		providers: [originalProvider, replacementProvider],
		releases: [] as Array<() => void>,
		pending: [] as Promise<Settled>[],
	}
	fixtures.push(owned)
	await task["messageQueueService"].ready
	await task["taskApiConfigReady"]
	await task["alphaMessagesSaveQueue"]
	const group: SubagentGroupState = {
		groupId: "cancelled-admission",
		parentTaskId: task.taskId,
		createdAt: 10,
		status: "pending",
		agents: [
			{
				taskId: "unstarted-child",
				nickname: "Original A",
				role: "review",
				objective: "Review without starting a child",
				status: "pending",
				usage: { inputTokens: 0, outputTokens: 0, cost: 0, durationMs: 0 },
			},
		],
	}
	const baseline: AlphaMessage[] = [{ ts: 1, type: "say", say: "text", text: "Original A transcript" }]
	if (operation === "update")
		baseline.push({ ts: 10, type: "say", say: "subagent_group", subagentGroup: structuredClone(group) })
	expect(await task.overwriteAlphaMessages(baseline)).toBe(true)
	const cancelled: SubagentGroupState = {
		...structuredClone(group),
		status: "cancelled",
		completedAt: 20,
		agents: group.agents.map((agent) => ({ ...agent, status: "cancelled" })),
	}
	const originalSignal = task.getTaskLifetimeCancellationSignal()
	const ownsNative = task["captureAgentStepOwnership"]()
	const guard = () => ownsNative() && task.getTaskLifetimeCancellationSignal() === originalSignal
	const messageEvents = vi.fn()
	task.on(AlphaCodeEventName.Message, messageEvents)
	originalProvider.updateTaskHistory.mockClear()
	originalProvider.postTaskMessageToWebview.mockClear()
	const track = (promise: Promise<unknown>) => {
		const settled: Promise<Settled> = promise.then(
			() => ({ status: "fulfilled" as const }),
			(error: unknown) => ({ status: "rejected" as const, error }),
		)
		owned.pending.push(settled)
		return settled
	}
	// The old public method exists on BEFORE and ignores the extra argument there.
	// Reflect.apply avoids requiring the future optional parameter at BEFORE typecheck.
	const publish = () => track(Reflect.apply(task.upsertSubagentGroup, task, [cancelled, guard]) as Promise<void>)
	const replacementMessages: AlphaMessage[] = [
		{
			ts: 10,
			type: "say",
			say: "subagent_group",
			text: "Replacement B transcript",
			subagentGroup: {
				...structuredClone(group),
				status: "running",
				agents: group.agents.map((agent) => ({ ...agent, nickname: "Replacement B", status: "running" })),
			},
		},
	]
	const expectedReplacement = structuredClone(replacementMessages)
	const replacementRow = replacementMessages[0]
	const installReplacement = () => {
		const controller = new AbortController()
		// Controlled same-object A-to-B callback handoff, matching native Stop fixtures.
		Reflect.set(task, "taskCancellationController", controller)
		task["providerRef"] = new WeakRef(replacementProvider as unknown as AlphaProvider)
		const saving = track(task.overwriteAlphaMessages(replacementMessages))
		expect(guard()).toBe(false)
		expect(task.getTaskLifetimeCancellationSignal()).toBe(controller.signal)
		return { controller, saving }
	}
	const assertReplacement = async () => {
		expect(task.alphaMessages).toBe(replacementMessages)
		expect(task.alphaMessages[0]).toBe(replacementRow)
		expect(task.alphaMessages).toEqual(expectedReplacement)
		expect(
			await readTaskMessages({ taskId: task.taskId, globalStoragePath: storage, requireExisting: true }),
		).toEqual(expectedReplacement)
		expect(replacementProvider.postTaskMessageToWebview).not.toHaveBeenCalled()
		expect(messageEvents).not.toHaveBeenCalled()
	}
	return {
		...owned,
		originalProvider,
		replacementProvider,
		cancelled,
		baseline: structuredClone(baseline),
		originalSignal,
		guard,
		messageEvents,
		track,
		publish,
		installReplacement,
		assertReplacement,
	}
}

async function reached(entered: Promise<void>, operation: Promise<Settled>) {
	const outcome = await Promise.race([entered.then(() => "entered" as const), operation])
	if (outcome !== "entered")
		throw new Error(`Task publication settled before its controlled acknowledgement (${outcome.status})`)
}

describe("Task guarded terminal sub-agent group publication", () => {
	it.each(["create", "update"] as const)(
		"skips stale %s while waiting behind the real save queue",
		async (operation) => {
			const f = await fixture(operation)
			const entered = barrier()
			const release = barrier()
			f.releases.push(release.resolve)
			f.originalProvider.updateTaskHistory.mockImplementationOnce(async () => {
				entered.resolve()
				await release.promise
				return []
			})
			const blocker = f.track(f.task.overwriteAlphaMessages(structuredClone(f.task.alphaMessages)))
			await reached(entered.promise, blocker)
			const publishing = f.publish()
			const replacement = f.installReplacement()
			release.resolve()
			expect(await blocker).toEqual({ status: "fulfilled" })
			expect(await publishing).toEqual({ status: "fulfilled" })
			expect(await replacement.saving).toEqual({ status: "fulfilled" })
			await f.assertReplacement()
			expect(f.originalProvider.updateTaskHistory).toHaveBeenCalledOnce()
			expect(f.replacementProvider.updateTaskHistory).toHaveBeenCalledOnce()
			expect(replacement.controller.signal.aborted).toBe(false)
		},
	)

	it.each(["create", "update"] as const)(
		"skips stale %s after real persistence waits on history acknowledgement",
		async (operation) => {
			const f = await fixture(operation)
			const entered = barrier()
			const release = barrier()
			f.releases.push(release.resolve)
			f.originalProvider.updateTaskHistory.mockImplementationOnce(async () => {
				entered.resolve()
				await release.promise
				return []
			})
			const publishing = f.publish()
			await reached(entered.promise, publishing)
			const replacement = f.installReplacement()
			release.resolve()
			expect(await publishing).toEqual({ status: "fulfilled" })
			expect(await replacement.saving).toEqual({ status: "fulfilled" })
			await f.assertReplacement()
			expect(f.originalProvider.updateTaskHistory).toHaveBeenCalledOnce()
			expect(f.replacementProvider.updateTaskHistory).toHaveBeenCalledOnce()
		},
	)

	it.each(["create", "update"] as const)(
		"does not emit stale %s after the captured projection acknowledgement",
		async (operation) => {
			const f = await fixture(operation)
			const entered = barrier()
			const release = barrier()
			f.releases.push(release.resolve)
			f.originalProvider.postTaskMessageToWebview.mockImplementationOnce(async () => {
				entered.resolve()
				await release.promise
			})
			const publishing = f.publish()
			await reached(entered.promise, publishing)
			const replacement = f.installReplacement()
			expect(await replacement.saving).toEqual({ status: "fulfilled" })
			release.resolve()
			expect(await publishing).toEqual({ status: "fulfilled" })
			await f.assertReplacement()
			expect(f.originalProvider.postTaskMessageToWebview).toHaveBeenCalledOnce()
			expect(replacement.controller.signal.aborted).toBe(false)
		},
	)

	it.each(["create", "update"] as const)(
		"publishes terminal %s for an aborted A that still owns its lifetime",
		async (operation) => {
			const f = await fixture(operation)
			f.task["taskCancellationController"].abort(new Error("Original admission cancelled"))
			expect(f.originalSignal.aborted).toBe(true)
			expect(f.guard()).toBe(true)
			expect(await f.publish()).toEqual({ status: "fulfilled" })
			const messages = await readTaskMessages({
				taskId: f.task.taskId,
				globalStoragePath: f.storage,
				requireExisting: true,
			})
			expect(messages).toEqual(f.task.alphaMessages)
			expect(
				messages.find((message) => message.subagentGroup?.groupId === f.cancelled.groupId)?.subagentGroup,
			).toEqual(f.cancelled)
			expect(f.originalProvider.postTaskMessageToWebview).toHaveBeenCalledOnce()
			expect(f.messageEvents).toHaveBeenCalledOnce()
			expect(f.replacementProvider.postTaskMessageToWebview).not.toHaveBeenCalled()
		},
	)

	it("preserves an explicitly absent captured provider when the save queue later sees another provider", async () => {
		const f = await fixture("create")
		const entered = barrier()
		const release = barrier()
		f.releases.push(release.resolve)
		f.originalProvider.updateTaskHistory.mockImplementationOnce(async () => {
			entered.resolve()
			await release.promise
			return []
		})
		const blocker = f.track(f.task.overwriteAlphaMessages(structuredClone(f.task.alphaMessages)))
		await reached(entered.promise, blocker)
		Reflect.set(f.task, "providerRef", { deref: () => undefined })
		const publishing = f.publish()
		f.task["providerRef"] = new WeakRef(f.replacementProvider as unknown as AlphaProvider)
		expect(f.guard()).toBe(true)
		release.resolve()
		expect(await blocker).toEqual({ status: "fulfilled" })
		expect(await publishing).toEqual({ status: "fulfilled" })
		expect(f.replacementProvider.updateTaskHistory).not.toHaveBeenCalled()
		expect(f.replacementProvider.postTaskMessageToWebview).not.toHaveBeenCalled()
		expect(f.messageEvents).toHaveBeenCalledOnce()
		expect(
			(await readTaskMessages({ taskId: f.task.taskId, globalStoragePath: f.storage, requireExisting: true })).at(
				-1,
			)?.subagentGroup,
		).toEqual(f.cancelled)
	})

	it("retains the existing current-owner three-attempt persistence rejection and leaves memory and projection uncommitted", async () => {
		const f = await fixture("create")
		const failure = new Error("History acknowledgement unavailable")
		f.originalProvider.updateTaskHistory.mockRejectedValue(failure)
		const outcome = await f.publish()
		expect(outcome.status).toBe("rejected")
		if (outcome.status === "rejected") {
			expect(outcome.error).toBeInstanceOf(Error)
			expect((outcome.error as Error).message).toBe("Unable to persist the sub-agent group.")
		}
		expect(f.originalProvider.updateTaskHistory).toHaveBeenCalledTimes(3)
		expect(f.guard()).toBe(true)
		expect(f.task.alphaMessages).toEqual(f.baseline)
		expect(f.originalProvider.postTaskMessageToWebview).not.toHaveBeenCalled()
		expect(f.messageEvents).not.toHaveBeenCalled()
	})
})
