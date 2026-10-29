import fs from "node:fs/promises"
import path from "node:path"

import { managedSubagentWorktreeService } from "@alpha-code/core"
import { AlphaCodeEventName, type ApprovalMode } from "@alpha-code/types"
import { afterEach, describe, expect, it, vi } from "vitest"

import { readApiMessages, type ApiMessage } from "../../task-persistence/apiMessages"
import { createManagedPublicLifecycleHarness, deferred } from "./managedPublicLifecycleHarness"

vi.mock("vscode", async (importOriginal) => {
	const actual = await importOriginal<typeof import("vscode")>()
	return { ...actual, workspace: { ...actual.workspace, textDocuments: [] } }
})

type Harness = Awaited<ReturnType<typeof createManagedPublicLifecycleHarness>>
const fixtures: Harness[] = []
const FILE = "docs/obsolete.txt"
const BASELINE = "Original parent content must remain recoverable.\n"
const CALL_ID = "accepted-child-deletion"

afterEach(async () => {
	vi.useRealTimers()
	try {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup()
	} finally {
		vi.restoreAllMocks()
	}
})

function expectOneAcceptedDeletion(history: readonly ApiMessage[]) {
	const blocks = history.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
	expect(blocks.filter((block) => block.type === "tool_use" && block.id === CALL_ID)).toHaveLength(1)
	expect(blocks.filter((block) => block.type === "tool_result" && block.tool_use_id === CALL_ID)).toEqual([
		expect.objectContaining({ is_error: false }),
	])
}

async function startEditingChild(approvalMode: ApprovalMode = "bypass", objective?: string) {
	const fixture = await createManagedPublicLifecycleHarness()
	fixtures.push(fixture)
	fixture.settings.approvalMode = approvalMode
	fixture.settings.alwaysAllowWrite = true
	fixture.root.setTaskApprovalMode(approvalMode)
	await fs.mkdir(path.join(fixture.root.cwd, "docs"))
	await fs.writeFile(path.join(fixture.root.cwd, FILE), BASELINE)
	const prepared = await fixture.provider.prepareSubagentGroup(fixture.root, [
		{
			task_name: "context_recovery",
			objective: objective ?? `Delete ${FILE}, then explain the completed change.`,
			agent_kind: "worker",
			write_scope: [FILE],
			fork_turns: "none",
		},
	])
	const taskId = prepared.envelopes[0].id
	// DeleteFile exercises the real native approval, scheduler and filesystem
	// effect without depending on the isolated VS Code diff-editor adapter.
	const mutation = fixture.queueTurn(taskId, "Delete the obsolete file.", [
		{
			type: "tool_call",
			id: CALL_ID,
			name: "apply_patch",
			arguments: JSON.stringify({ patch: `*** Begin Patch\n*** Delete File: ${FILE}\n*** End Patch` }),
		},
	])
	const continuation = fixture.queueTurn(taskId, "The accepted deletion is complete.", undefined, {
		beforeHold: [{ type: "text", text: "Verified retained context and completed tool evidence. ".repeat(256) }],
	})
	const handle = await fixture.provider.launchPreparedSubagentGroup(
		fixture.root,
		prepared,
		fixture.root.getTaskLifetimeCancellationSignal(),
	)
	const completion = fixture.runs.waitForResult(taskId)
	if (!completion) throw new Error("Public launch did not expose the Worker's result channel")
	const endedBeforeProgress = completion.then((result) => {
		throw new Error(`Worker ended before its continuing provider stream: ${result.status}: ${result.summary}`)
	})
	await Promise.race([mutation.entered, endedBeforeProgress])
	const child = fixture.provider.getLiveTask(taskId)
	if (!child) throw new Error("Public launch did not register its actual Worker Task")
	mutation.release()
	await Promise.race([continuation.progressed, endedBeforeProgress])
	await child.flushApiConversationHistoryPersistence()
	expectOneAcceptedDeletion(await readApiMessages({ taskId, globalStoragePath: fixture.storagePath }))
	await expect(fs.readFile(path.join(child.cwd, FILE), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
	const finish = async () => {
		continuation.release()
		const result = await completion
		await fixture.settleFinalizations()
		await child.waitForTermination()
		return result
	}
	return { ...fixture, prepared, taskId, child, handle, mutation, continuation, finish }
}

function resultMail(fixture: Harness, taskId: string) {
	return fixture.store
		.getSnapshot()
		.mailbox.filter((entry) => entry.kind === "result" && entry.senderTaskId === taskId)
}

describe("public managed-child context and timeout recovery", () => {
	it("expires the parent wait while an editing child keeps running and integrates its accepted effect once", async () => {
		const fixture = await startEditingChild()
		const apply = vi.spyOn(managedSubagentWorktreeService, "apply")
		const subscribed = deferred()
		const unsubscribed = vi.fn()
		const subscribe = fixture.store.subscribe.bind(fixture.store)
		vi.spyOn(fixture.store, "subscribe").mockImplementation((listener) => {
			const dispose = subscribe(listener)
			subscribed.resolve()
			return () => {
				unsubscribed()
				dispose()
			}
		})
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const timeout = vi.spyOn(globalThis, "setTimeout")
		const clear = vi.spyOn(globalThis, "clearTimeout")
		try {
			const waiting = fixture.provider.waitForAgent(fixture.root, 10_000, {
				target: fixture.taskId,
				untilTerminal: true,
			})
			await subscribed.promise
			const timer = timeout.mock.results[timeout.mock.calls.findIndex(([, delay]) => delay === 10_000)]
			if (!timer || timer.type !== "return") throw new Error("The parent wait did not install its own deadline")
			await vi.advanceTimersByTimeAsync(10_000)
			await expect(waiting).resolves.toMatchObject({ timedOut: true, events: [] })
			expect(clear).toHaveBeenCalledWith(timer.value)
			expect(unsubscribed).toHaveBeenCalledOnce()
		} finally {
			timeout.mockRestore()
			clear.mockRestore()
			vi.useRealTimers()
		}
		expect(fixture.continuation.request?.signal?.aborted).toBe(false)
		expect(fixture.store.getAgent(fixture.taskId)?.status).toBe("running")
		expect(fixture.child.getTaskApprovalMode()).toBe("bypass")
		expect(fixture.root.getTaskApprovalMode()).toBe("bypass")
		expect(resultMail(fixture, fixture.taskId)).toEqual([])
		expect(await fs.readFile(path.join(fixture.root.cwd, FILE), "utf8")).toBe(BASELINE)

		const result = await fixture.finish()

		expect(result).toMatchObject({ status: "completed", changeSet: { status: "applied" } })
		await expect(fs.readFile(path.join(fixture.root.cwd, FILE), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
		expect(apply).toHaveBeenCalledOnce()
		expect(resultMail(fixture, fixture.taskId)).toHaveLength(1)
		expectOneAcceptedDeletion(
			await readApiMessages({ taskId: fixture.taskId, globalStoragePath: fixture.storagePath }),
		)
	}, 30_000)

	it("retains long context and a completed tool pair across interruption while its parent samples without review", async () => {
		const markers = ["CONTEXT_EARLY_REQUIREMENT", "CONTEXT_MIDDLE_REQUIREMENT", "CONTEXT_TAIL_REQUIREMENT"]
		const objective = [
			`Delete ${FILE} and preserve the accepted tool receipt.`,
			markers[0],
			"Retain this authorized task context and its evidence. ".repeat(1_500),
			markers[1],
			"Preserve parent and child ownership through provider progress. ".repeat(1_500),
			markers[2],
		].join("\n")
		expect(objective.length).toBeGreaterThan(150_000)
		const fixture = await startEditingChild("auto", objective)
		const frozenPolicy = structuredClone(fixture.child.subagentContextManifest?.runtimePolicy)
		const unexpectedRestart = fixture.queueTurn(fixture.taskId, "An interruption must not restart the child.")
		for (const marker of markers) {
			expect(JSON.stringify(fixture.mutation.messages)).toContain(marker)
			expect(JSON.stringify(fixture.continuation.messages)).toContain(marker)
		}
		expect(fixture.mutation.request?.taskId).toBe(fixture.taskId)
		expect(fixture.continuation.request?.taskId).toBe(fixture.taskId)
		expect(fixture.continuation.request?.requestId).not.toBe(fixture.mutation.request?.requestId)
		expect(fixture.child.subagentContextManifest?.parentTaskId).toBe(fixture.root.taskId)
		expect(fixture.child.getTaskApprovalMode()).toBe("auto")
		expect(fixture.continuation.request?.signal?.aborted).toBe(false)

		await fixture.provider.interruptAgent(fixture.root, fixture.taskId)
		const result = await fixture.finish()

		expect(result).toMatchObject({ status: "interrupted", changeSet: { status: "pending_review", partial: true } })
		expect(unexpectedRestart.request).toBeUndefined()
		expect(fixture.child.subagentContextManifest?.runtimePolicy).toEqual(frozenPolicy)
		expect(fixture.root.getTaskApprovalMode()).toBe("auto")
		expect(resultMail(fixture, fixture.taskId)).toHaveLength(1)
		const changeSetId = result.changeSet?.id
		if (!changeSetId) throw new Error("The interrupted mutation lost its recoverable change set")
		const artifact = await managedSubagentWorktreeService.load(fixture.storagePath, changeSetId)
		expect(artifact).toMatchObject({ status: "pending_review", partial: true, taskId: fixture.taskId })
		const [change] = await managedSubagentWorktreeService.getDiffFiles(fixture.storagePath, changeSetId)
		expect(change?.path).toBe(FILE)
		if (!change?.beforePath) throw new Error("The partial deletion lost its recoverable original content")
		expect(await fs.readFile(change.beforePath, "utf8")).toBe(BASELINE)
		expect(await fs.readFile(path.join(fixture.root.cwd, FILE), "utf8")).toBe(BASELINE)

		const review = deferred<"review">()
		vi.mocked(fixture.provider.postStateToWebviewWithoutTaskHistory).mockImplementation(async () => {
			if (fixture.root["isAwaitingSubagentReview"]) review.resolve("review")
		})
		const completed = deferred<"completed">()
		fixture.root.on(AlphaCodeEventName.TaskCompleted, () => completed.resolve("completed"))
		const collect = fixture.queueTurn(fixture.root.taskId, "Collect the interrupted child result.", [
			{
				type: "tool_call",
				id: "collect-interrupted-child",
				name: "wait_agent",
				arguments: JSON.stringify({ target: fixture.taskId, until_terminal: true, timeout_ms: 10_000 }),
			},
		])
		const reply = fixture.queueTurn(fixture.root.taskId, "The partial deletion is preserved for later recovery.")
		fixture.root.start()
		expect(await Promise.race([collect.entered.then(() => "sampled"), review.promise])).toBe("sampled")
		collect.release()
		expect(await Promise.race([reply.entered.then(() => "sampled"), review.promise])).toBe("sampled")
		expect(reply.request?.taskId).toBe(fixture.root.taskId)
		expect(fixture.root["isAwaitingSubagentReview"]).toBe(false)
		reply.release()
		expect(await Promise.race([completed.promise, review.promise])).toBe("completed")
		await fixture.root.waitForTermination()
		expect((await managedSubagentWorktreeService.load(fixture.storagePath, changeSetId)).status).toBe(
			"pending_review",
		)
		expectOneAcceptedDeletion(
			await readApiMessages({ taskId: fixture.taskId, globalStoragePath: fixture.storagePath }),
		)
	}, 30_000)

	it("integrates an interrupted Full Access child's accepted mutation without replaying or relabeling its outcome", async () => {
		const fixture = await startEditingChild()
		const apply = vi.spyOn(managedSubagentWorktreeService, "apply")
		const unexpectedRestart = fixture.queueTurn(fixture.taskId, "An interruption must not replay the mutation.")

		await fixture.provider.interruptAgent(fixture.root, fixture.taskId)
		const result = await fixture.finish()

		expect(result).toMatchObject({ status: "interrupted", changeSet: { status: "applied", partial: true } })
		await expect(fs.readFile(path.join(fixture.root.cwd, FILE), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
		expect(fixture.child.getTaskApprovalMode()).toBe("bypass")
		expect(fixture.root.getTaskApprovalMode()).toBe("bypass")
		expect(apply).toHaveBeenCalledOnce()
		expect(unexpectedRestart.request).toBeUndefined()
		expect(resultMail(fixture, fixture.taskId)).toEqual([
			expect.objectContaining({ payload: expect.objectContaining({ status: "interrupted" }) }),
		])
		expectOneAcceptedDeletion(
			await readApiMessages({ taskId: fixture.taskId, globalStoragePath: fixture.storagePath }),
		)
	}, 30_000)

	it.each(["explicit Stop", "concurrent external edit"] as const)(
		"preserves parent data after %s without restarting the child",
		async (scenario) => {
			const fixture = await startEditingChild()
			const unexpectedRestart = fixture.queueTurn(fixture.taskId, "Do not replay the accepted deletion.")
			if (scenario === "explicit Stop") {
				await fixture.provider.cancelAgent(fixture.root, fixture.taskId, "Explicitly stop the editing child")
			} else {
				await fs.writeFile(path.join(fixture.root.cwd, FILE), "Concurrent external parent edit.\n")
			}

			const result = await fixture.finish()

			expect(result.changeSet).toMatchObject({
				status: scenario === "explicit Stop" ? "pending_review" : "conflicted",
			})
			if (scenario === "explicit Stop") {
				expect(result).toMatchObject({ status: "cancelled", changeSet: { partial: true } })
				expect(fixture.continuation.request?.signal?.aborted).toBe(true)
			}
			expect(await fs.readFile(path.join(fixture.root.cwd, FILE), "utf8")).toBe(
				scenario === "explicit Stop" ? BASELINE : "Concurrent external parent edit.\n",
			)
			expect(unexpectedRestart.request).toBeUndefined()
			expect(resultMail(fixture, fixture.taskId)).toHaveLength(1)
			expectOneAcceptedDeletion(
				await readApiMessages({ taskId: fixture.taskId, globalStoragePath: fixture.storagePath }),
			)
		},
		30_000,
	)
})
