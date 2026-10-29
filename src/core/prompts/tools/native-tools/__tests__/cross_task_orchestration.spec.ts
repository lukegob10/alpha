import { describe, expect, it } from "vitest"

import { providerNames, reasoningEffortsExtended } from "@alpha-code/types"

import { getNativeTools } from ".."
import { getToolCapabilities } from "../../../../tools/ToolRegistry"

const threadNames = [
	"list_threads",
	"list_archived_threads",
	"read_thread",
	"wait_threads",
	"send_message_to_thread",
	"create_thread",
	"fork_thread",
	"set_thread_title",
	"set_thread_archived",
	"steer_task",
	"stop_task",
]
const legacyNames = ["create_task", "list_tasks", "wait_task", "send_task_message"]

function namesFor(role: "root" | "child" | "none", includeCreateThreadSchema = false, includeForkThreadSchema = false) {
	return getNativeTools({ crossTaskRole: role, includeCreateThreadSchema, includeForkThreadSchema })
		.filter((tool) => tool.type === "function" && threadNames.includes(tool.function.name))
		.map((tool) => (tool.type === "function" ? tool.function.name : ""))
}

describe("thread orchestration tool surface", () => {
	it("offers peer controls and independently gates fresh creation and history forks", () => {
		for (const role of ["root", "child"] as const) {
			expect(namesFor(role)).toEqual(
				threadNames.filter((name) => !["create_thread", "fork_thread"].includes(name)),
			)
			expect(namesFor(role, true)).toEqual(threadNames.filter((name) => name !== "fork_thread"))
			expect(namesFor(role, false, true)).toEqual(threadNames.filter((name) => name !== "create_thread"))
			expect(namesFor(role, true, true)).toEqual(threadNames)
		}
		expect(namesFor("none")).toEqual([])
		const managed = getNativeTools({ taskKind: "subagent", crossTaskRole: "root", includeCreateThreadSchema: true })
		expect(managed.some((tool) => tool.type === "function" && threadNames.includes(tool.function.name))).toBe(false)
	})

	it("describes fresh handoffs separately from explicit history-preserving forks", () => {
		const tools = getNativeTools({
			crossTaskRole: "root",
			includeCreateThreadSchema: true,
			includeForkThreadSchema: true,
		})
		const description = (name: string) =>
			tools.flatMap((tool) =>
				tool.type === "function" && tool.function.name === name ? [tool.function.description] : [],
			)[0]
		expect(description("create_thread")).toContain("empty conversation history")
		expect(description("create_thread")).toContain("concise, self-contained prompt with ticket references")
		expect(description("create_thread")).toContain("do not copy the old transcript or compaction summary")
		expect(description("fork_thread")).toContain(
			"only when the user explicitly requests a fork or retaining that history",
		)
		expect(description("fork_thread")).toContain("remains idle")
	})

	it("retains historical task schemas only when provider replay explicitly needs them", () => {
		const fresh = getNativeTools({ crossTaskRole: "root", includeCreateThreadSchema: true })
		for (const name of legacyNames)
			expect(fresh.some((tool) => tool.type === "function" && tool.function.name === name)).toBe(false)
		const replay = getNativeTools({ crossTaskRole: "root", legacyCrossTaskToolNames: ["create_task", "wait_task"] })
		expect(replay.some((tool) => tool.type === "function" && tool.function.name === "create_task")).toBe(true)
		expect(replay.some((tool) => tool.type === "function" && tool.function.name === "wait_task")).toBe(true)
	})

	it("preserves upstream camelCase contracts and optional fields", () => {
		const tools = getNativeTools({ crossTaskRole: "root", includeCreateThreadSchema: true })
		const find = (name: string) => tools.find((tool) => tool.type === "function" && tool.function.name === name)
		expect(find("create_thread")).toMatchObject({
			function: {
				parameters: {
					required: ["prompt"],
					additionalProperties: false,
					properties: { prompt: { minLength: 1, maxLength: 1_000 } },
				},
			},
		})
		expect(find("read_thread")).toMatchObject({
			function: {
				parameters: {
					required: ["threadId"],
					properties: { turnLimit: { minimum: 1, maximum: 10 }, includeOutputs: { type: "boolean" } },
				},
			},
		})
		expect(find("wait_threads")).toMatchObject({
			function: {
				parameters: {
					required: ["targets"],
					properties: { targets: { minItems: 1, maxItems: 8 }, timeoutMs: { minimum: 0, maximum: 120_000 } },
				},
			},
		})
	})

	it("uses the same independent model selection fields for fresh tasks, forks, and follow-ups", () => {
		const tools = getNativeTools({
			crossTaskRole: "root",
			includeCreateThreadSchema: true,
			includeForkThreadSchema: true,
		})
		for (const name of ["create_thread", "fork_thread", "send_message_to_thread"]) {
			expect(tools.find((tool) => tool.type === "function" && tool.function.name === name)).toMatchObject({
				function: {
					parameters: {
						additionalProperties: false,
						properties: {
							provider: { type: "string", enum: [...providerNames] },
							profile: { type: "string", minLength: 1 },
							model: { type: "string", minLength: 1 },
							reasoning_effort: { type: "string", enum: [...reasoningEffortsExtended] },
						},
					},
				},
			})
		}
	})

	it("serializes lifecycle effects and approval-gates every mutation", () => {
		for (const name of [
			"create_thread",
			"fork_thread",
			"send_message_to_thread",
			"set_thread_title",
			"set_thread_archived",
			"steer_task",
			"stop_task",
		]) {
			expect(getToolCapabilities(name)).toMatchObject({
				concurrency: "barrier",
				sideEffects: "task",
				controlFlow: true,
				requiresApproval: true,
			})
		}
		for (const name of ["list_threads", "list_archived_threads", "read_thread", "wait_threads"]) {
			expect(getToolCapabilities(name)).toMatchObject({
				concurrency: name === "wait_threads" ? "barrier" : "serial",
				requiresApproval: false,
				sideEffects: "none",
			})
		}
	})
})
