import { createManagedPublicLifecycleHarness } from "./managedPublicLifecycleHarness"

import { afterEach, describe, expect, it, vi } from "vitest"

import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"
import { normalizeSpawnAgentRequest } from "../../agent/SubagentDelegation"
import { Task } from "../../task/Task"
import { readApiMessages } from "../../task-persistence"
import { ToolRegistry } from "../../tools/ToolRegistry"

type Harness = Awaited<ReturnType<typeof createManagedPublicLifecycleHarness>>
const fixtures: Harness[] = []

afterEach(async () => {
	try {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup()
	} finally {
		vi.restoreAllMocks()
	}
})

function ownedFinalization(fixture: Harness, taskId: string): Promise<void> {
	const entries = Reflect.get(fixture.provider, "subagentRunFinalizations") as Map<
		string,
		Promise<void> | { readonly promise: Promise<void> }
	>
	const entry = entries.get(taskId)
	if (!entry) throw new Error("A native child must have an owned finalization before completion")
	return "promise" in entry ? entry.promise : entry
}

// Codex ac558e2: native V2 numeric forks mean full history, passive mail does
// not start a turn, and wait_agent takes only a timeout. Run that surface through
// the existing real provider/Task harness rather than the legacy array helper.
describe("native V2 extension lifecycle conformance", () => {
	it("keeps one shared-workspace child across passive mail, triggered follow-up and a durable native wait", async () => {
		const fixture = await createManagedPublicLifecycleHarness({
			maxLiveTasks: 3,
			rootObjective: "NATIVE_PARENT_REQUIREMENT: inspect the code and integrate the delegated findings.",
		})
		fixtures.push(fixture)
		const rootTurn = fixture.queueTurn(fixture.root.taskId, "Collect the delegated reports.")
		fixture.root.start()
		await rootTurn.entered

		const parsed = NativeToolCallParser.parseToolCall({
			id: "native-spawn",
			name: "spawn_agent",
			arguments: JSON.stringify({
				task_name: "native_review",
				message: "NATIVE_CHILD_OBJECTIVE: inspect the code without changing files.",
				agent_type: "review",
				fork_turns: "1",
			}),
		})
		if (!parsed || !("nativeArgs" in parsed)) throw new Error("Expected validated native spawn arguments")
		const request = normalizeSpawnAgentRequest(parsed.nativeArgs)
		expect(request).toMatchObject({ source: "codex-v2", fork_turns: "all" })
		const prepared = await fixture.provider.prepareSubagentGroup(fixture.root, parsed.nativeArgs)
		expect(prepared.inheritsParentPermissions).toBe(true)
		expect(prepared.requiresExplicitApproval).toBe(false)
		expect(prepared.envelopes[0].scope.sharedWorkspace).toBe(true)
		const taskId = prepared.envelopes[0].id
		const first = fixture.queueTurn(taskId, "NATIVE_FIRST_REPORT: source inspected.")
		const handle = await fixture.provider.launchPreparedSubagentGroup(
			fixture.root,
			prepared,
			fixture.root.getTaskLifetimeCancellationSignal(),
		)
		const firstFinalization = ownedFinalization(fixture, taskId)
		await first.entered
		const child = fixture.provider.getLiveTask(taskId)
		expect(child).toBeInstanceOf(Task)
		if (!child) throw new Error("Native spawn must register the actual child Task")
		expect(child.cwd).toBe(fixture.root.cwd)
		expect(child.subagentContextManifest?.runtimePolicy.authorityModel).toBe("parent")
		expect(JSON.stringify(first.messages)).toContain("NATIVE_PARENT_REQUIREMENT")
		expect(JSON.stringify(first.messages)).toContain("NATIVE_CHILD_OBJECTIVE")
		first.release()
		await expect(fixture.runs.waitForResult(taskId)).resolves.toMatchObject({ status: "completed" })
		await firstFinalization
		await child.waitForTermination()

		const passive = await fixture.provider.sendMessageToAgent(
			fixture.root,
			handle.path,
			"NATIVE_PASSIVE_MAIL: retain this for the next admitted turn.",
		)
		expect(passive.delivery).toBe("buffered")
		expect(fixture.store.getAgent(taskId, fixture.root.taskId)?.status).toBe("completed")
		expect(fixture.childrenCaptured).toHaveLength(1)
		const second = fixture.queueTurn(taskId, "NATIVE_SECOND_REPORT: follow-up verified.")
		const followup = await fixture.provider.followupAgentTask(
			fixture.root,
			handle.path,
			"NATIVE_TRIGGER: verify the next case.",
		)
		expect(followup).toMatchObject({ taskId, path: handle.path, followup: true })
		const secondFinalization = ownedFinalization(fixture, taskId)
		await second.entered
		expect(JSON.stringify(second.messages)).toContain("NATIVE_PASSIVE_MAIL")
		expect(JSON.stringify(second.messages)).toContain("NATIVE_TRIGGER")
		const followupChild = fixture.provider.getLiveTask(taskId)
		expect(followupChild).toBeInstanceOf(Task)
		if (!followupChild) throw new Error("Follow-up must register its exact Task generation")
		expect(followupChild.taskId).toBe(child.taskId)
		expect(followupChild.cwd).toBe(child.cwd)
		const originalPolicy = child.subagentContextManifest!.runtimePolicy
		const { digest: _digest, autoApproval, ...authority } = originalPolicy
		// Admission refreshes salted approval identities; durable capability,
		// workspace and tool ceilings still belong to the original child.
		expect(followupChild.subagentContextManifest?.runtimePolicy).toMatchObject(authority)
		expect(followupChild.subagentContextManifest?.runtimePolicy.autoApproval).toMatchObject({
			alwaysAllowWrite: autoApproval?.alwaysAllowWrite,
			alwaysAllowExecute: autoApproval?.alwaysAllowExecute,
			alwaysAllowReadOnlyOutsideWorkspace: autoApproval?.alwaysAllowReadOnlyOutsideWorkspace,
			alwaysAllowWriteOutsideWorkspace: autoApproval?.alwaysAllowWriteOutsideWorkspace,
		})
		second.release()
		await expect(fixture.runs.waitForResult(taskId)).resolves.toMatchObject({ status: "completed" })
		await secondFinalization
		await followupChild.waitForTermination()
		expect(new Set(fixture.childrenCaptured.map((task) => task.taskId))).toEqual(new Set([taskId]))

		const waitSchema = new ToolRegistry().resolve("wait_agent")!.schema
		if (waitSchema.type !== "function") throw new Error("Expected a native wait function schema")
		expect(Object.keys(waitSchema.function.parameters!.properties as object)).toEqual(["timeout_ms"])
		rootTurn.chunks = [
			{
				type: "tool_call",
				id: "native-wait",
				name: "wait_agent",
				arguments: JSON.stringify({ timeout_ms: 10_000 }),
			},
		]
		const finalRoot = fixture.queueTurn(fixture.root.taskId, "Integrated and verified both delegated reports.")
		rootTurn.release()
		await finalRoot.entered
		finalRoot.release()
		await fixture.root.waitForTermination()
		const transcript = await readApiMessages({
			taskId: fixture.root.taskId,
			globalStoragePath: fixture.storagePath,
		})
		const results = transcript.flatMap((message) =>
			message.role === "user" && Array.isArray(message.content)
				? message.content.filter((block) => block.type === "tool_result" && block.tool_use_id === "native-wait")
				: [],
		)
		expect(results).toHaveLength(1)
		expect(results[0]).toMatchObject({ type: "tool_result", is_error: false })
		await expect(fixture.provider.getParentCompletionDecision(fixture.root)).resolves.toMatchObject({
			allowed: true,
		})
		const usage = Reflect.get(fixture.provider, "getSubagentRootUsage").call(fixture.provider, fixture.root.taskId)
		expect(usage).toEqual({ tokens: 10, cost: 0.002 })
	})
})
