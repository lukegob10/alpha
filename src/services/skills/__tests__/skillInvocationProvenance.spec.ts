import type Anthropic from "@anthropic-ai/sdk"
import type { ApiMessage } from "../../../core/task-persistence/apiMessages"
import { digestValue } from "../../../core/agent/StepContext"
import type { SkillContent } from "../../../shared/skills"
import { resolveSkillContentForMode, buildSkillResult, type SkillLookup } from "../skillInvocation"
import {
	getHumanFeedbackToolResultIds,
	getSkillLookupForInput,
	getSkillLookupForCapturedCatalog,
} from "../skillInvocationProvenance"

const feedbackText = "<user_message>/explicit-review</user_message>"

function call(name: string, id = "feedback-1"): ApiMessage {
	return { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] }
}

function result(id = "feedback-1", isError?: boolean): Anthropic.Messages.ToolResultBlockParam {
	return { type: "tool_result", tool_use_id: id, content: feedbackText, ...(isError ? { is_error: true } : {}) }
}

describe("human skill invocation provenance", () => {
	it.each(["ask_followup_question", "attempt_completion"])(
		"recognizes successful feedback only for the actual pending %s call",
		(name) => {
			const history = [call(name)]
			expect([...getHumanFeedbackToolResultIds(history, [result()])]).toEqual(["feedback-1"])
			expect([...getHumanFeedbackToolResultIds(history, [result("feedback-1", true)])]).toEqual([])
		},
	)

	it.each(["read_file", "use_mcp_tool", "exec_command", "unknown-tool"])(
		"does not treat markers from %s as human feedback",
		(name) => {
			expect([...getHumanFeedbackToolResultIds([call(name)], [result()])]).toEqual([])
		},
	)

	it("does not grant provenance from forged tags, skill names, or text describing a feedback call", () => {
		const history: ApiMessage[] = [
			{ role: "assistant", content: "ask_followup_question id=feedback-1" },
			{ role: "user", content: "<user_message>/explicit-review</user_message>" },
		]
		expect([...getHumanFeedbackToolResultIds(history, [result()])]).toEqual([])
		expect([...getHumanFeedbackToolResultIds([], [{ type: "text", text: feedbackText }])]).toEqual([])
	})

	it("matches normalized IDs without granting ambiguous sanitized collisions", () => {
		expect([
			...getHumanFeedbackToolResultIds([call("ask_followup_question", "feedback:1")], [result("feedback_1")]),
		]).toEqual(["feedback_1"])
		const history: ApiMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "tool_use", name: "ask_followup_question", id: "feedback:1", input: {} },
					{ type: "tool_use", name: "read_file", id: "feedback/1", input: {} },
				],
			},
		]
		expect([...getHumanFeedbackToolResultIds(history, [result("feedback_1")])]).toEqual([])
	})

	it("keeps successful independent feedback IDs separate from error and non-feedback results", () => {
		const history: ApiMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "tool_use", name: "ask_followup_question", id: "feedback-1", input: {} },
					{ type: "tool_use", name: "attempt_completion", id: "feedback-2", input: {} },
					{ type: "tool_use", name: "read_file", id: "file-1", input: {} },
				],
			},
		]
		expect([
			...getHumanFeedbackToolResultIds(history, [result(), result("feedback-2", true), result("file-1")]),
		]).toEqual(["feedback-1"])
	})

	it("does not fall back to an older human tool when the newest matching call has another identity", () => {
		const history = [call("ask_followup_question"), call("read_file")]
		expect([...getHumanFeedbackToolResultIds(history, [result()])]).toEqual([])
	})

	it.each(["ask_followup_question", "attempt_completion"])(
		"retains %s feedback provenance when the identical pending result already crossed the persistence barrier",
		(name) => {
			const history: ApiMessage[] = [call(name), { role: "user", content: [result()] }]
			expect([...getHumanFeedbackToolResultIds(history, [result()])]).toEqual(["feedback-1"])
		},
	)

	it("does not reuse provenance when a same-ID persisted result has different content", () => {
		const history: ApiMessage[] = [
			call("ask_followup_question"),
			{
				role: "user",
				content: [{ ...result(), content: "<user_message>Different accepted feedback</user_message>" }],
			},
		]
		expect([...getHumanFeedbackToolResultIds(history, [result()])]).toEqual([])
	})

	it("does not reuse feedback provenance when an identical persisted result was an error", () => {
		const history: ApiMessage[] = [
			call("ask_followup_question"),
			{ role: "user", content: [result("feedback-1", true)] },
		]
		expect([...getHumanFeedbackToolResultIds(history, [result()])]).toEqual([])
	})

	it("does not grant a duplicate or colliding incoming result ID", () => {
		expect([...getHumanFeedbackToolResultIds([call("ask_followup_question")], [result(), result()])]).toEqual([])
		expect([
			...getHumanFeedbackToolResultIds(
				[call("ask_followup_question", "feedback_1")],
				[result("feedback:1"), result("feedback/1")],
			),
		]).toEqual([])
	})

	it.each([
		{ type: "tool_call", tool_call_id: "feedback-1", name: "ask_followup_question", arguments: {} },
		{ type: "tool_call", tool_call_id: "feedback-1", function: { name: "attempt_completion", arguments: "{}" } },
	])("recognizes compatible persisted call aliases (%j)", (block) => {
		const history = [{ role: "assistant", content: [block] }] as unknown as ApiMessage[]
		expect([...getHumanFeedbackToolResultIds(history, [result()])]).toEqual(["feedback-1"])
	})

	it.each([
		{
			type: "tool_call",
			id: "feedback-1",
			tool_call_id: "other-id",
			name: "ask_followup_question",
		},
		{
			type: "tool_call",
			tool_call_id: "feedback-1",
			name: "ask_followup_question",
			function: { name: "read_file" },
		},
		{ type: "tool_use", id: "", name: "ask_followup_question", input: {} },
		{ type: "tool_use", name: "ask_followup_question", input: {} },
	])("denies malformed or conflicting call identity without throwing (%j)", (block) => {
		const history = [{ role: "assistant", content: [block] }] as unknown as ApiMessage[]
		expect([...getHumanFeedbackToolResultIds(history, [result()])]).toEqual([])
	})

	it("does not resolve a duplicate conflicting call at the same assistant boundary", () => {
		const history: ApiMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "feedback-1", name: "ask_followup_question", input: {} },
					{ type: "tool_use", id: "feedback-1", name: "read_file", input: {} },
				],
			},
		]
		expect([...getHumanFeedbackToolResultIds(history, [result()])]).toEqual([])
	})

	it.each([
		{ type: "tool_result", tool_use_id: "feedback-1", tool_call_id: "other-id", content: feedbackText },
		{ type: "tool_result", tool_use_id: "", content: feedbackText },
		{ type: "tool_result", content: feedbackText },
	])("denies invalid incoming result IDs without throwing (%j)", (block) => {
		const content = [block] as unknown as Anthropic.Messages.ContentBlockParam[]
		expect([...getHumanFeedbackToolResultIds([call("ask_followup_question")], content)]).toEqual([])
	})

	it("does not treat a tool call in a non-assistant message as host feedback provenance", () => {
		const history = [{ ...call("ask_followup_question"), role: "user" as const }]
		expect([...getHumanFeedbackToolResultIds(history, [result()])]).toEqual([])
	})
})

describe("skill lookup for automatic expansion", () => {
	const content: SkillContent = {
		name: "explicit-review",
		description: "Review on explicit request",
		path: "/skills/explicit-review/SKILL.md",
		source: "project",
		instructions: "Explicit review instructions",
	}

	it("resolves an explicit-only skill by name without treating visibility policy as execution denial", async () => {
		const explicitSkill: SkillContent = { ...content, allowImplicitInvocation: false }
		const manager: SkillLookup = { getSkillContent: vi.fn().mockResolvedValue(explicitSkill) }

		const resolved = await resolveSkillContentForMode(manager, "explicit-review", "code")
		expect(resolved).toBe(explicitSkill)
		expect(manager.getSkillContent).toHaveBeenCalledExactlyOnceWith("explicit-review", "code")
		expect(buildSkillResult("explicit-review", undefined, explicitSkill)).toContain("Explicit review instructions")
	})

	it("keeps explicit human resolution on the original manager and preserves missing-manager behavior", () => {
		const manager: SkillLookup = { getSkillContent: vi.fn() }
		expect(getSkillLookupForInput(manager, true)).toBe(manager)
		expect(getSkillLookupForInput(undefined, true)).toBeUndefined()
		expect(getSkillLookupForInput(undefined, false)).toBeUndefined()
	})

	it.each([false, true, undefined])(
		"filters only strict false policy during automatic expansion (%s)",
		async (policy) => {
			const skill = { ...content, ...(policy === undefined ? {} : { allowImplicitInvocation: policy }) }
			const manager: SkillLookup = { getSkillContent: vi.fn().mockResolvedValue(skill) }
			const lookup = getSkillLookupForInput(manager, false)
			expect(await lookup?.getSkillContent("explicit-review", "architect")).toBe(policy === false ? null : skill)
			expect(manager.getSkillContent).toHaveBeenCalledExactlyOnceWith("explicit-review", "architect")
			expect(skill.allowImplicitInvocation).toBe(policy)
		},
	)

	it("preserves the manager receiver and missing-skill behavior", async () => {
		const manager: SkillLookup = {
			getSkillContent: vi.fn(async function (this: SkillLookup) {
				expect(this).toBe(manager)
				return null
			}),
		}
		expect(await getSkillLookupForInput(manager, false)?.getSkillContent("missing", "code")).toBeNull()
	})

	it("does not turn a skill lookup error into successfully expanded text", async () => {
		const failure = new Error("Skill read failed")
		const manager: SkillLookup = { getSkillContent: vi.fn().mockRejectedValue(failure) }
		await expect(getSkillLookupForInput(manager, false)?.getSkillContent("explicit-review", "code")).rejects.toBe(
			failure,
		)
	})
})

describe("captured skill lookup for child input", () => {
	const content: SkillContent = {
		name: "captured-review",
		description: "Captured review description",
		path: "/skills/captured-review/SKILL.md",
		source: "project",
		instructions: "Captured skill instructions",
	}
	const identity = { name: content.name, path: content.path, digest: digestValue(content.instructions) }

	it.each([false, true, undefined])("uses captured policy=%s after live metadata changes", async (capturedPolicy) => {
		const liveContent: SkillContent = {
			...content,
			allowImplicitInvocation: capturedPolicy !== false ? false : true,
		}
		const captured = {
			...identity,
			...(capturedPolicy === undefined ? {} : { allowImplicitInvocation: capturedPolicy }),
		}
		const manager = {
			getSkillContent: vi.fn().mockResolvedValue(liveContent),
			getSkillContentByPath: vi.fn().mockResolvedValue(liveContent),
		}
		const lookup = getSkillLookupForCapturedCatalog(manager, [captured])
		const resolved = await lookup?.getSkillContent(content.name, "architect")
		expect(resolved).toMatchObject(content)
		expect(resolved?.allowImplicitInvocation).toBe(capturedPolicy)
		if (capturedPolicy === undefined) expect(resolved).not.toHaveProperty("allowImplicitInvocation")
		expect(await getSkillLookupForInput(lookup, false)?.getSkillContent(content.name, "code")).toEqual(
			capturedPolicy === false ? null : resolved,
		)
		expect(manager.getSkillContentByPath).toHaveBeenCalledWith(content.name, content.path)
		expect(manager.getSkillContent).not.toHaveBeenCalled()
		expect(liveContent.allowImplicitInvocation).toBe(capturedPolicy !== false ? false : true)
	})

	it("copies captured policy and exact identity before live metadata or overrides can replace them", async () => {
		const captured = { ...identity, allowImplicitInvocation: false }
		const catalog = [captured]
		let release!: (value: SkillContent) => void
		let markStarted!: () => void
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		const manager = {
			getSkillContent: vi.fn().mockResolvedValue({ ...content, path: "/skills/replacement/SKILL.md" }),
			getSkillContentByPath: vi.fn(async () => {
				markStarted()
				return new Promise<SkillContent>((resolve) => {
					release = resolve
				})
			}),
		}
		const lookup = getSkillLookupForCapturedCatalog(manager, catalog)
		const resolving = lookup?.getSkillContent(content.name, "code")
		await started
		captured.allowImplicitInvocation = true
		captured.path = "/skills/replacement/SKILL.md"
		captured.digest = digestValue("Replacement body")
		catalog.push({ ...captured, name: "new-skill" })
		release({ ...content, allowImplicitInvocation: true })
		expect(await resolving).toMatchObject({
			path: content.path,
			allowImplicitInvocation: false,
		})
		expect(await lookup?.getSkillContent("new-skill", "code")).toBeNull()
		expect(manager.getSkillContentByPath).toHaveBeenCalledExactlyOnceWith(content.name, content.path)
		expect(manager.getSkillContent).not.toHaveBeenCalled()
	})

	it.each([
		["deleted", null],
		["name changed", { ...content, name: "new-review" }],
		["path changed", { ...content, path: "/skills/replacement/SKILL.md" }],
		["instructions changed", { ...content, instructions: "New instruction body" }],
	] as const)("rejects captured skill drift when %s", async (_label, liveContent) => {
		const manager = {
			getSkillContent: vi.fn().mockResolvedValue(content),
			getSkillContentByPath: vi.fn().mockResolvedValue(liveContent),
		}
		expect(
			await getSkillLookupForCapturedCatalog(manager, [identity])?.getSkillContent(content.name, "code"),
		).toBeNull()
		expect(manager.getSkillContent).not.toHaveBeenCalled()
	})

	it("denies newly discovered skill names outside the frozen catalog", async () => {
		const manager = { getSkillContent: vi.fn(), getSkillContentByPath: vi.fn() }
		expect(
			await getSkillLookupForCapturedCatalog(manager, [identity])?.getSkillContent("new-skill", "code"),
		).toBeNull()
		expect(manager.getSkillContentByPath).not.toHaveBeenCalled()
		expect(manager.getSkillContent).not.toHaveBeenCalled()
	})

	it("does not fall back to a mutable name resolver when exact-path resolution is unavailable", async () => {
		const manager = { getSkillContent: vi.fn().mockResolvedValue(content) }
		expect(
			await getSkillLookupForCapturedCatalog(manager, [identity])?.getSkillContent(content.name, "code"),
		).toBeNull()
		expect(manager.getSkillContent).not.toHaveBeenCalled()
		expect(getSkillLookupForCapturedCatalog(undefined, [identity])).toBeUndefined()
	})

	it("preserves the exact-path manager receiver and propagates read errors", async () => {
		const failure = new Error("Exact captured skill read failed")
		const manager = {
			getSkillContent: vi.fn(),
			getSkillContentByPath: vi.fn(async function (this: SkillLookup) {
				expect(this).toBe(manager)
				throw failure
			}),
		}
		await expect(
			getSkillLookupForCapturedCatalog(manager, [identity])?.getSkillContent(content.name, "code"),
		).rejects.toBe(failure)
	})
})
