import { AgentControlStore, InMemoryAgentControlPersistence } from "../AgentControlStore"
import { SubagentNicknameRegistry } from "../SubagentNicknameRegistry"
import { requireAgentTarget, requireNonEmptyMessage } from "../../tools/AgentLifecycleTool"

async function tree() {
	const persistence = new InMemoryAgentControlPersistence()
	const store = new AgentControlStore(persistence)
	await store.initialize()
	await store.ensureRoot({ taskId: "root", status: "running" })
	const add = (taskId: string, parentTaskId: string, nickname: string) =>
		store.createAgent({ taskId, parentTaskId, nickname, role: "review", objective: "Inspect", status: "running" })
	return { store, persistence, add }
}

describe("Codex-compatible managed agent addressing", () => {
	it("preserves a valid compatibility name containing both hyphens and underscores", async () => {
		const { add } = await tree()
		expect((await add("mixed-name", "root", "code-review_v2")).path).toBe("/root/code-review_v2")
	})
	it("preserves supplied names while resolving nested references against the caller", async () => {
		const { store, add } = await tree()
		const parent = await add("backend-id", "root", "backend_api")
		const child = await add("review-id", parent.taskId, "code_review")
		expect(child.path).toBe("/root/backend_api/code_review")
		expect(store.resolveAgentReference("root", "backend_api/code_review", "root")?.taskId).toBe(child.taskId)
		expect(store.resolveAgentReference(parent.taskId, "code_review", "root")?.taskId).toBe(child.taskId)
		expect(store.resolveAgentReference("root", child.taskId, "root")?.path).toBe(child.path)
	})

	it("keeps persisted hyphenated paths and original-name aliases readable after reload", async () => {
		const { store, persistence, add } = await tree()
		const parent = await add("backend-id", "root", "backend_api")
		await add("review-id", parent.taskId, "code_review")
		const saved = (await persistence.read())!
		for (const record of saved.agents) {
			record.path = record.path.replaceAll("_", "-")
			if (record.parentPath) record.parentPath = record.parentPath.replaceAll("_", "-")
		}
		await persistence.write(saved)
		const reloaded = new AgentControlStore(persistence)
		await reloaded.initialize()
		expect(reloaded.getAgent("/root/backend-api/code-review", "root")?.taskId).toBe("review-id")
		expect(reloaded.resolveAgentReference("root", "backend_api/code_review", "root")?.taskId).toBe("review-id")
		expect(reloaded.resolveAgentReference("backend-id", "code_review", "root")?.taskId).toBe("review-id")
		expect(store.getAgent("root")?.taskId).toBe("root")
	})

	it("scopes duplicate child names to their immediate parent", () => {
		const names = new SubagentNicknameRegistry()
		expect(names.assign("root", "one", 1, [], ["review"], "backend")).toEqual(["review"])
		expect(names.assign("root", "two", 1, [], ["review"], "frontend")).toEqual(["review"])
		expect(() => names.assign("root", "duplicate", 1, [], ["review"], "backend")).toThrow("already in use")
		names.release("one")
		expect(() => names.assign("root", "still-used", 1, [], ["review"], "frontend")).toThrow("already in use")
	})

	it("keeps root identity and resolves a local child ahead of a same-named peer", async () => {
		const { store, add } = await tree()
		await add("backend", "root", "backend")
		await add("frontend", "root", "frontend")
		await add("backend-review", "backend", "review")
		await add("frontend-review", "frontend", "review")
		await store.ensureRoot({ taskId: "foreign-root", status: "running" })
		expect(store.resolveAgentReference("backend", "review", "root")?.taskId).toBe("backend-review")
		expect(store.resolveAgentReference("frontend", "review", "root")?.taskId).toBe("frontend-review")
		expect(store.resolveAgentReference("root", "foreign-root", "root")).toBeUndefined()
	})

	it.each(["/root/backend_api/code_review", "backend_api/code_review", "code_review", "old-task-id"])(
		"accepts retained IDs and valid agent reference %s",
		(target) => expect(requireAgentTarget(target)).toBe(target),
	)

	it.each(["../review", "backend/../review", "backend//review", "backend\\review", "/other/review"])(
		"rejects reference traversal and malformed paths: %s",
		(target) => expect(() => requireAgentTarget(target)).toThrow(),
	)

	it("accepts a bounded detailed instruction without changing its content", () => {
		const message = `  Detailed review:\n${"finding ".repeat(1_000)}\n  `
		expect(requireNonEmptyMessage(message)).toBe(message)
		expect(() => requireNonEmptyMessage("x".repeat(32_769))).toThrow()
		expect(() => requireNonEmptyMessage("  \n")).toThrow()
	})
})
