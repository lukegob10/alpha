import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { Task } from "../../task/Task"
import type { SkillMetadata } from "../../../shared/skills"
import type { ToolCallbacks } from "../BaseTool"
import { skillTool } from "../SkillTool"
import { subagentContextManifestSchema } from "@alpha-code/types"
import {
	captureSubagentContext,
	isValidSubagentContextManifest,
	serializeSubagentContextManifest,
} from "../../agent/SubagentContextCapture"
import { getSkillsCatalogSectionParts } from "../../prompts/sections/skills"
import { digestValue } from "../../agent/StepContext"

const pageSchema = z.object({
	skills: z.array(z.object({ name: z.string(), description: z.string(), path: z.string() })),
	next_cursor: z.string().nullable(),
	omitted_oversized: z.number().int().nonnegative(),
})

function metadata(index: number, description = "Review a file"): SkillMetadata {
	const name = `review-${String(index).padStart(4, "0")}`
	return { name, description, path: `/skills/${name}/SKILL.md`, source: "project" }
}

function fixture(skills: SkillMetadata[] = []) {
	const manager = {
		getSkillsForMode: vi.fn(() => skills),
		getSkillContent: vi.fn(),
		getSkillContentByPath: vi.fn(),
	}
	const provider = { getSkillsManager: vi.fn(async () => manager), getState: vi.fn() }
	const state = {
		taskKind: "primary",
		consecutiveMistakeCount: 0,
		didToolFailInCurrentTurn: false,
		getTaskMode: vi.fn(async () => "architect"),
		providerRef: { deref: vi.fn(() => provider) },
		recordToolError: vi.fn(),
		recordLoadedSkill: vi.fn(async () => undefined),
		sayAndCreateMissingParamError: vi.fn(async () => "Missing skill"),
		getInheritedSubagentSkillNames: vi.fn(() => [] as string[]),
		getInheritedSubagentSkill: vi.fn<
			(name: string) =>
				| {
						name: string
						path: string
						digest: string
						allowImplicitInvocation?: boolean
				  }
				| undefined
		>(),
	}
	const callbacks = {
		askApproval: vi.fn<ToolCallbacks["askApproval"]>(async () => true),
		handleError: vi.fn<ToolCallbacks["handleError"]>(async () => undefined),
		pushToolResult: vi.fn<ToolCallbacks["pushToolResult"]>(),
		getRemainingOutputChars: vi.fn(() => 8_000),
		signal: new AbortController().signal,
	}
	const list = async (cursor: string | null = null) => {
		callbacks.pushToolResult.mockClear()
		await skillTool.execute(
			{ action: "list", skill: null, args: null, cursor },
			state as unknown as Task,
			callbacks,
		)
		expect(state.sayAndCreateMissingParamError).not.toHaveBeenCalled()
		expect(callbacks.askApproval).toHaveBeenCalled()
		const output = callbacks.pushToolResult.mock.calls[0]?.[0]
		if (typeof output !== "string") throw new Error("Expected a string skill catalog page")
		expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(8_000)
		return pageSchema.parse(JSON.parse(output))
	}
	return { state, manager, provider, callbacks, list }
}

beforeEach(() => vi.clearAllMocks())

describe("bounded discovery on the existing skill tool", () => {
	it("paginates in captured order without duplicate identities and retains ordinary approval", async () => {
		const skills = Array.from({ length: 130 }, (_, index) => metadata(index))
		const { state, manager, provider, callbacks, list } = fixture(skills)
		const names: string[] = []
		let cursor: string | null = null
		let pages = 0
		do {
			const page = await list(cursor)
			expect(page.skills.length).toBeLessThanOrEqual(50)
			expect(page.omitted_oversized).toBe(0)
			names.push(...page.skills.map(({ name }) => name))
			cursor = page.next_cursor
			pages++
			expect(pages).toBeLessThan(10)
		} while (cursor !== null)

		expect(names).toEqual(skills.map(({ name }) => name))
		expect(new Set(names).size).toBe(names.length)
		expect(provider.getSkillsManager).toHaveBeenCalledWith(state)
		expect(manager.getSkillsForMode).toHaveBeenCalledWith("architect")
		expect(provider.getState).not.toHaveBeenCalled()
		expect(callbacks.askApproval).toHaveBeenCalledTimes(pages)
		expect(state.recordLoadedSkill).not.toHaveBeenCalled()
		expect(manager.getSkillContent).not.toHaveBeenCalled()
	})

	it("bounds escaped UTF-8 results and skips an oversized identity with an explicit count", async () => {
		const oversized = { ...metadata(0), path: "/" + '😀\\"'.repeat(8_000) }
		const skills = [
			oversized,
			...Array.from({ length: 20 }, (_, index) => metadata(index + 1, '😀<&"'.repeat(200))),
		]
		const { list } = fixture(skills)
		const page = await list()

		expect(page.omitted_oversized).toBe(1)
		expect(page.skills.length).toBeGreaterThan(0)
		expect(page.skills[0].name).toBe(skills[1].name)
		expect(page.skills).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: oversized.name })]))
		expect(page.next_cursor).not.toBeNull()
	})

	it("never exposes explicit-only metadata through a page or cursor continuity", async () => {
		const hidden = { ...metadata(1, "HIDDEN_DESCRIPTION"), name: "hidden-review", allowImplicitInvocation: false }
		const { list } = fixture([metadata(0), hidden, metadata(2)])
		const page = await list()

		expect(page.skills.map(({ name }) => name)).toEqual([metadata(0).name, metadata(2).name])
		expect(JSON.stringify(page)).not.toContain(hidden.name)
		expect(JSON.stringify(page)).not.toContain(hidden.description)
		expect(JSON.stringify(page)).not.toContain(hidden.path)
	})

	it("keeps legacy child identities compatible without captured descriptions or live metadata", async () => {
		const { state, manager, list } = fixture([metadata(2, "Mutable live catalog")])
		state.taskKind = "subagent"
		const inherited = [
			{ name: "frozen-review", path: "/frozen/review/SKILL.md", digest: "captured" },
			{
				name: "hidden-review",
				path: "/frozen/hidden/SKILL.md",
				digest: "captured",
				allowImplicitInvocation: false,
			},
		]
		state.getInheritedSubagentSkillNames.mockReturnValue(inherited.map(({ name }) => name))
		state.getInheritedSubagentSkill.mockImplementation((name) => inherited.find((skill) => skill.name === name))

		expect((await list()).skills).toEqual([
			{ name: "frozen-review", path: "/frozen/review/SKILL.md", description: "" },
		])
		expect(manager.getSkillsForMode).not.toHaveBeenCalled()
		expect(manager.getSkillContentByPath).not.toHaveBeenCalled()
	})

	it.each(["", "bad-cursor", "v1:" + "0".repeat(64) + ":-1"])(
		"rejects malformed cursors without publishing a page: %s",
		async (cursor) => {
			const { state, callbacks } = fixture([metadata(0)])
			await skillTool.execute(
				{ action: "list", skill: null, args: null, cursor },
				state as unknown as Task,
				callbacks,
			)

			expect(callbacks.handleError).toHaveBeenCalledWith("executing skill", expect.any(Error))
			expect(callbacks.pushToolResult).not.toHaveBeenCalled()
			expect(callbacks.askApproval).not.toHaveBeenCalled()
		},
	)

	it("rejects a cursor if the current visible catalog changed between pages", async () => {
		const { state, manager, callbacks, list } = fixture(Array.from({ length: 100 }, (_, index) => metadata(index)))
		const first = await list()
		expect(first.next_cursor).not.toBeNull()
		manager.getSkillsForMode.mockReturnValue([metadata(0, "Changed captured description")])
		callbacks.pushToolResult.mockClear()
		callbacks.askApproval.mockClear()
		await skillTool.execute(
			{ action: "list", skill: null, args: null, cursor: first.next_cursor },
			state as unknown as Task,
			callbacks,
		)

		expect(callbacks.handleError).toHaveBeenCalledWith("executing skill", expect.any(Error))
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
		expect(callbacks.askApproval).not.toHaveBeenCalled()
	})

	it("publishes nothing after approval denial or cancellation during approval", async () => {
		const { state, callbacks } = fixture([metadata(0)])
		callbacks.askApproval.mockResolvedValue(false)
		await skillTool.execute(
			{ action: "list", skill: null, args: null, cursor: null },
			state as unknown as Task,
			callbacks,
		)
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()

		const controller = new AbortController()
		callbacks.signal = controller.signal
		callbacks.askApproval.mockImplementation(async () => {
			controller.abort()
			return true
		})
		await skillTool.execute(
			{ action: "list", skill: null, args: null, cursor: null },
			state as unknown as Task,
			callbacks,
		)
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
		expect(callbacks.handleError).toHaveBeenCalled()
		expect(state.recordLoadedSkill).not.toHaveBeenCalled()
	})

	it("fits the complete cursor envelope within the remaining output allowance after approval", async () => {
		const { callbacks, list } = fixture(Array.from({ length: 100 }, (_, index) => metadata(index)))
		let approved = false
		callbacks.askApproval.mockImplementation(async () => {
			approved = true
			return true
		})
		callbacks.getRemainingOutputChars.mockImplementation(() => (approved ? 500 : 0))
		const page = await list()
		const output = callbacks.pushToolResult.mock.calls[0][0]

		expect(Buffer.byteLength(String(output), "utf8")).toBeLessThanOrEqual(500)
		expect(page.skills.length).toBeGreaterThan(0)
		expect(page.next_cursor).not.toBeNull()
	})

	it("fails explicitly when the remaining output budget cannot hold the pagination envelope", async () => {
		const { state, callbacks } = fixture([metadata(0)])
		callbacks.getRemainingOutputChars.mockReturnValue(10)
		await skillTool.execute(
			{ action: "list", skill: null, args: null, cursor: null },
			state as unknown as Task,
			callbacks,
		)

		expect(callbacks.handleError).toHaveBeenCalledWith("executing skill", expect.any(Error))
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
	})
})

function reloadCapturedSkillContext(skills: readonly SkillMetadata[]) {
	const cwd = process.cwd()
	const captured = captureSubagentContext({
		parentTaskId: "q1-parent",
		capturedAt: 1,
		forkTurns: "none",
		history: [],
		instructions: {
			effectiveText: "Frozen repository instructions",
			sources: [
				{ kind: "aggregate", ref: "task:q1-parent:instructions", text: "Frozen repository instructions" },
			],
		},
		skills: skills.map((skill) => ({ ...skill, content: "Captured skill instructions" })),
		cwd,
		workspaceRoots: [cwd],
		modelRoute: {
			source: "parent",
			resolution: "selected",
			profileName: "Default",
			provider: "openai",
			modelId: "fixture-model",
		},
		runtimePolicy: {
			role: "review",
			read: true,
			execute: false,
			mutate: false,
			delegate: false,
			network: false,
			externalSideEffects: false,
			requireApproval: true,
			allowedTools: ["read_file", "skill"],
			workspaceRoots: [cwd],
		},
	})
	return subagentContextManifestSchema.parse(JSON.parse(serializeSubagentContextManifest(captured.manifest)))
}

describe("Q1 frozen child description recovery across durable context", () => {
	it("recovers an omitted captured description from bounded pages after live metadata changes", async () => {
		const liveSkills = Array.from({ length: 1_000 }, (_, index) => metadata(index, "Routine source review"))
		liveSkills[999] = metadata(999, "Audit the signed release manifest before publishing a release")
		const hidden = {
			...metadata(1_000, "HIDDEN_FROZEN_DESCRIPTION"),
			name: "hidden-q1-review",
			path: "/hidden-q1/SKILL.md",
			allowImplicitInvocation: false,
		}
		liveSkills.push(hidden)
		const frozenCatalog = Object.freeze(liveSkills.map((skill) => Object.freeze({ ...skill })))
		const target = frozenCatalog[999]!
		const durable = reloadCapturedSkillContext(frozenCatalog)
		expect(isValidSubagentContextManifest(durable)).toBe(true)
		expect(durable.skills).toHaveLength(frozenCatalog.length)

		const initial = getSkillsCatalogSectionParts(frozenCatalog, "code").catalog
		const initialMetadata = /<available_skills>\n?([\s\S]*?)\n?<\/available_skills>/.exec(initial)?.[1]
		expect(initialMetadata).toBeDefined()
		expect(Array.from(initialMetadata ?? "").length).toBeLessThanOrEqual(8_000)
		expect(initial).not.toContain(`<name>${target.name}</name>`)
		expect(initial).not.toContain(target.description)
		expect(initial).not.toContain(hidden.name)
		expect(initial).not.toContain(hidden.description)
		expect(initial).not.toContain(hidden.path)

		const recovered = new Map<string, { name: string; description: string; path: string }>()
		for (const entry of (initialMetadata ?? "").matchAll(
			/<skill>\s*<name>([^<]*)<\/name>\s*<description>([^<]*)<\/description>\s*<location>([^<]*)<\/location>\s*<\/skill>/g,
		)) {
			recovered.set(entry[1]!, { name: entry[1]!, description: entry[2]!, path: entry[3]! })
		}

		const { state, manager, provider, callbacks, list } = fixture(liveSkills)
		const child = Object.assign(state, { subagentContextManifest: durable }) as unknown as Task
		state.taskKind = "subagent"
		state.getTaskMode.mockResolvedValue("code")
		state.getInheritedSubagentSkillNames.mockImplementation(() =>
			Task.prototype.getInheritedSubagentSkillNames.call(child),
		)
		state.getInheritedSubagentSkill.mockImplementation((name) =>
			Task.prototype.getInheritedSubagentSkill.call(child, name),
		)
		liveSkills[999] = { ...metadata(999, "MUTABLE_LIVE_REPLACEMENT"), path: "/mutable-q1/SKILL.md" }
		const rejectMutableLookup = () => {
			throw new Error("Q1 child discovery must not read mutable skill metadata or content")
		}
		manager.getSkillsForMode.mockImplementation(rejectMutableLookup)
		manager.getSkillContent.mockImplementation(rejectMutableLookup)
		manager.getSkillContentByPath.mockImplementation(rejectMutableLookup)

		const pageNames: string[] = []
		const cursors = new Set<string>()
		let cursor: string | null = null
		let pageCount = 0
		do {
			const page = await list(cursor)
			expect(page.skills.length).toBeLessThanOrEqual(50)
			expect(page.omitted_oversized).toBe(0)
			for (const entry of page.skills) {
				pageNames.push(entry.name)
				recovered.set(entry.name, entry)
			}
			cursor = page.next_cursor
			if (cursor !== null) {
				expect(cursors.has(cursor)).toBe(false)
				cursors.add(cursor)
			}
			pageCount++
			expect(pageCount).toBeLessThan(100)
		} while (cursor !== null)

		expect(pageNames).toHaveLength(1_000)
		expect(new Set(pageNames).size).toBe(pageNames.length)
		expect(pageNames).toEqual(
			durable.skills.filter((skill) => skill.allowImplicitInvocation !== false).map((skill) => skill.name),
		)
		expect(recovered.get(target.name)).toEqual({
			name: target.name,
			path: target.path,
			description: target.description,
		})
		const visibleMetadata = JSON.stringify([...recovered.values()])
		expect(visibleMetadata).not.toContain(hidden.name)
		expect(visibleMetadata).not.toContain(hidden.description)
		expect(visibleMetadata).not.toContain(hidden.path)
		expect(visibleMetadata).not.toContain("MUTABLE_LIVE_REPLACEMENT")
		expect(visibleMetadata).not.toContain("/mutable-q1/")
		expect(callbacks.askApproval).toHaveBeenCalledTimes(pageCount)
		expect(state.recordLoadedSkill).not.toHaveBeenCalled()
		expect(manager.getSkillsForMode).not.toHaveBeenCalled()
		expect(manager.getSkillContent).not.toHaveBeenCalled()
		expect(manager.getSkillContentByPath).not.toHaveBeenCalled()
		expect(provider.getState).not.toHaveBeenCalled()
		expect(provider.getSkillsManager).not.toHaveBeenCalled()
		expect(state.providerRef.deref).not.toHaveBeenCalled()
		expect(state.getTaskMode).not.toHaveBeenCalled()
	})

	it("lists durable child identities when the live manager cannot initialize", async () => {
		const skill = metadata(0, "Frozen relevance remains independent of a live manager")
		const durable = reloadCapturedSkillContext([skill])
		expect(isValidSubagentContextManifest(durable)).toBe(true)
		const { state, manager, provider, callbacks } = fixture()
		const child = Object.assign(state, { subagentContextManifest: durable }) as unknown as Task
		state.taskKind = "subagent"
		state.getTaskMode.mockResolvedValue("code")
		state.getInheritedSubagentSkillNames.mockImplementation(() =>
			Task.prototype.getInheritedSubagentSkillNames.call(child),
		)
		state.getInheritedSubagentSkill.mockImplementation((name) =>
			Task.prototype.getInheritedSubagentSkill.call(child, name),
		)
		provider.getSkillsManager.mockRejectedValue(new Error("Mutable skill manager unavailable"))

		await skillTool.execute({ action: "list", skill: null, args: null, cursor: null }, child, callbacks)

		expect(provider.getSkillsManager).not.toHaveBeenCalled()
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(callbacks.askApproval).toHaveBeenCalledOnce()
		const output = callbacks.pushToolResult.mock.calls[0]?.[0]
		expect(typeof output).toBe("string")
		if (typeof output !== "string") throw new Error("Expected a durable child catalog page")
		expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(8_000)
		const page = pageSchema.parse(JSON.parse(output))
		expect(page.skills).toEqual([expect.objectContaining({ name: skill.name, path: skill.path })])
		expect(page.next_cursor).toBeNull()
		expect(page.omitted_oversized).toBe(0)
		expect(state.recordLoadedSkill).not.toHaveBeenCalled()
		expect(manager.getSkillsForMode).not.toHaveBeenCalled()
		expect(manager.getSkillContent).not.toHaveBeenCalled()
		expect(manager.getSkillContentByPath).not.toHaveBeenCalled()
		expect(provider.getState).not.toHaveBeenCalled()
		expect(state.providerRef.deref).not.toHaveBeenCalled()
		expect(state.getTaskMode).not.toHaveBeenCalled()
	})

	it("returns exact escaped Unicode child descriptions with no live manager or mode resolution", async () => {
		const description = '  Inspect 😀 é <xml> "quoted"\\path\nNext stage  '
		const skill = metadata(0, description)
		const durable = reloadCapturedSkillContext([skill])
		const { state, provider, list } = fixture()
		const child = Object.assign(state, {
			taskKind: "subagent",
			subagentContextManifest: durable,
		}) as unknown as Task
		state.getInheritedSubagentSkillNames.mockImplementation(() =>
			Task.prototype.getInheritedSubagentSkillNames.call(child),
		)
		state.getInheritedSubagentSkill.mockImplementation((name) =>
			Task.prototype.getInheritedSubagentSkill.call(child, name),
		)
		provider.getSkillsManager.mockRejectedValue(new Error("No live manager"))
		state.getTaskMode.mockRejectedValue(new Error("No live mode"))

		expect((await list()).skills).toEqual([{ name: skill.name, path: skill.path, description }])
		expect(provider.getSkillsManager).not.toHaveBeenCalled()
		expect(state.getTaskMode).not.toHaveBeenCalled()
		expect(state.providerRef.deref).not.toHaveBeenCalled()
	})

	it.each([false, true])("retains native approval for explicit frozen loads: approved=%s", async (approved) => {
		const skill = { ...metadata(0, "Frozen explicit relevance"), allowImplicitInvocation: false }
		const durable = reloadCapturedSkillContext([skill])
		const { state, manager, provider, callbacks } = fixture()
		const child = Object.assign(state, {
			taskKind: "subagent",
			subagentContextManifest: durable,
		}) as unknown as Task
		state.getTaskMode.mockResolvedValue("code")
		state.getInheritedSubagentSkillNames.mockImplementation(() =>
			Task.prototype.getInheritedSubagentSkillNames.call(child),
		)
		state.getInheritedSubagentSkill.mockImplementation((name) =>
			Task.prototype.getInheritedSubagentSkill.call(child, name),
		)
		manager.getSkillContentByPath.mockResolvedValue({ ...skill, instructions: "Captured skill instructions" })
		callbacks.askApproval.mockResolvedValue(approved)

		await skillTool.execute({ action: "load", skill: skill.name, args: null, cursor: null }, child, callbacks)

		expect(provider.getSkillsManager).toHaveBeenCalledExactlyOnceWith(state)
		expect(manager.getSkillContentByPath).toHaveBeenCalledExactlyOnceWith(skill.name, skill.path)
		expect(callbacks.askApproval).toHaveBeenCalledOnce()
		expect(callbacks.handleError).not.toHaveBeenCalled()
		if (approved) {
			expect(state.recordLoadedSkill).toHaveBeenCalledExactlyOnceWith(
				skill.name,
				skill.path,
				digestValue("Captured skill instructions"),
			)
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Captured skill instructions"),
			)
		} else {
			expect(state.recordLoadedSkill).not.toHaveBeenCalled()
			expect(callbacks.pushToolResult).not.toHaveBeenCalled()
		}
	})

	it.each([
		{ path: "/mutable/replaced/SKILL.md", instructions: "Captured skill instructions" },
		{ path: metadata(0).path, instructions: "Changed skill body" },
	])("still rejects frozen load path/body drift before approval", async (changed) => {
		const skill = metadata(0, "Frozen relevance does not authorize changed content")
		const durable = reloadCapturedSkillContext([skill])
		const { state, manager, callbacks } = fixture()
		const child = Object.assign(state, {
			taskKind: "subagent",
			subagentContextManifest: durable,
		}) as unknown as Task
		state.getTaskMode.mockResolvedValue("code")
		state.getInheritedSubagentSkill.mockImplementation((name) =>
			Task.prototype.getInheritedSubagentSkill.call(child, name),
		)
		manager.getSkillContentByPath.mockResolvedValue({ ...skill, ...changed })

		await skillTool.execute({ action: "load", skill: skill.name, args: null, cursor: null }, child, callbacks)

		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(state.recordLoadedSkill).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringMatching(/no longer resolves|changed after this child task captured/),
		)
	})

	it("cancels an approved frozen load before recording or publishing instructions", async () => {
		const skill = metadata(0, "Frozen relevance")
		const durable = reloadCapturedSkillContext([skill])
		const { state, manager, callbacks } = fixture()
		const child = Object.assign(state, {
			taskKind: "subagent",
			subagentContextManifest: durable,
		}) as unknown as Task
		state.getTaskMode.mockResolvedValue("code")
		state.getInheritedSubagentSkill.mockImplementation((name) =>
			Task.prototype.getInheritedSubagentSkill.call(child, name),
		)
		manager.getSkillContentByPath.mockResolvedValue({ ...skill, instructions: "Captured skill instructions" })
		const controller = new AbortController()
		callbacks.signal = controller.signal
		callbacks.askApproval.mockImplementation(async () => {
			controller.abort(new Error("Cancelled approved skill load"))
			return true
		})

		await skillTool.execute({ action: "load", skill: skill.name, args: null, cursor: null }, child, callbacks)

		expect(callbacks.askApproval).toHaveBeenCalledOnce()
		expect(callbacks.handleError).toHaveBeenCalledWith("executing skill", expect.any(Error))
		expect(state.recordLoadedSkill).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
	})
})
