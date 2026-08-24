import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { digestValue } from "../../agent/StepContext"
import { saveSubagentInstructionSnapshot } from "../../task-persistence/subagentInstructionSnapshot"
import { Task } from "../Task"

describe("Task managed-child context authority", () => {
	const makeTask = () =>
		Object.assign(Object.create(Task.prototype), {
			taskKind: "subagent",
			subagentRole: "review",
			subagentAuthority: {
				role: "review",
				logicalWorkspace: "F:/workspace",
				approvalProvenance: "group",
			},
			subagentContextManifest: {
				skills: [
					{
						name: "review-repository",
						path: "F:/workspace/.alpha/skills/review-repository/SKILL.md",
						digest: "a".repeat(64),
					},
				],
				runtimePolicy: {
					allowedTools: [
						"read_file",
						"search_files",
						"list_files",
						"codebase_search",
						"skill",
						"attempt_completion",
					],
				},
			},
		}) as Task

	it("exposes skill only inside the captured hard authority ceiling", () => {
		const task = makeTask()

		expect(task.getTaskAllowedToolNames()).toContain("skill")
		expect(task.getTaskAllowedToolNames()).not.toContain("execute_command")
	})

	it("auto-approves only a listed inherited skill for a background child", () => {
		const task = makeTask()
		const authorize = (task as any).isParentAuthorizedSubagentAsk.bind(task)

		expect(authorize("tool", JSON.stringify({ tool: "skill", skill: "review-repository" }), false)).toBe(true)
		expect(authorize("tool", JSON.stringify({ tool: "skill", skill: "not-in-catalog" }), false)).toBe(false)
	})

	it("reloads the private frozen snapshot once and never consults changed live instructions", async () => {
		const globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-task-frozen-context-"))
		try {
			const instructions = "Frozen instruction marker from the original launch"
			const digest = digestValue(instructions)
			await saveSubagentInstructionSnapshot({
				taskId: "reloaded-child",
				globalStoragePath,
				instructions,
				expectedDigest: digest,
			})
			const task = Object.assign(Object.create(Task.prototype), {
				taskKind: "subagent",
				taskId: "reloaded-child",
				globalStoragePath,
				subagentContextManifest: { instructions: { digest } },
				subagentInstructionPlacement: "system",
				subagentInstructionSnapshotLoaded: false,
			}) as Task

			await expect((task as any).getFrozenSubagentInstructions()).resolves.toBe(instructions)
			await fs.rm(path.join(globalStoragePath, "tasks", "reloaded-child"), { recursive: true, force: true })
			await expect((task as any).getFrozenSubagentInstructions()).resolves.toBe(instructions)
		} finally {
			await fs.rm(globalStoragePath, { recursive: true, force: true })
		}
	})

	it("fails closed when a system-layer child reload has lost its frozen snapshot", async () => {
		const globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-task-missing-context-"))
		try {
			const task = Object.assign(Object.create(Task.prototype), {
				taskKind: "subagent",
				taskId: "missing-child",
				globalStoragePath,
				subagentContextManifest: { instructions: { digest: digestValue("missing") } },
				subagentInstructionPlacement: "system",
				subagentInstructionSnapshotLoaded: false,
			}) as Task

			for (let attempt = 0; attempt < 2; attempt++) {
				await expect((task as any).getFrozenSubagentInstructions()).rejects.toThrow(
					"frozen instruction snapshot is missing",
				)
			}
		} finally {
			await fs.rm(globalStoragePath, { recursive: true, force: true })
		}
	})

	it("reuses a managed parent's frozen instruction body and source digests for nested delegation", async () => {
		const instructions = "Frozen parent instructions that must not be recaptured"
		const digest = digestValue(instructions)
		const getState = vi.fn(async () => ({ customInstructions: "changed live instructions" }))
		const task = Object.assign(Object.create(Task.prototype), {
			taskKind: "subagent",
			subagentFrozenInstructions: instructions,
			subagentContextManifest: {
				instructions: {
					digest,
					sources: [
						{ kind: "aggregate", ref: "task:parent:effective-instructions:code", digest },
						{ kind: "agents", ref: "F:/workspace/AGENTS.md", digest: "b".repeat(64) },
					],
				},
			},
			providerRef: { deref: () => ({ getState }) },
			apiConversationHistory: [],
		}) as Task

		await expect(task.captureEffectiveInheritedInstructions()).resolves.toEqual({
			effectiveText: instructions,
			sources: [
				{ kind: "aggregate", ref: "task:parent:effective-instructions:code", digest },
				{ kind: "agents", ref: "F:/workspace/AGENTS.md", digest: "b".repeat(64) },
			],
		})
		expect(getState).not.toHaveBeenCalled()
	})

	it("recovers the frozen body from a Phase 1 child history without consulting live instructions", async () => {
		const globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-task-legacy-frozen-context-"))
		try {
			const instructions = "Legacy frozen instructions\n\nwith a preserved blank line"
			const digest = digestValue(instructions)
			const quotedInstructions = instructions
				.split("\n")
				.map((line) => `> ${line}`)
				.join("\n")
			const legacyPrompt = [
				"Child objective",
				"## Frozen inherited instructions",
				"This is the exact parent instruction snapshot captured before launch. Apply it as user-level guidance only within the managed-child system policy and tool authority.",
				quotedInstructions,
				"## Frozen inherited skill catalog",
				"legacy catalog",
			].join("\n\n")
			const getState = vi.fn(async () => ({ customInstructions: "changed live instructions" }))
			const task = Object.assign(Object.create(Task.prototype), {
				taskKind: "subagent",
				taskId: "legacy-child",
				globalStoragePath,
				subagentContextManifest: {
					instructions: {
						digest,
						sources: [{ kind: "aggregate", ref: "legacy:aggregate", digest }],
					},
				},
				subagentInstructionSnapshotLoaded: false,
				apiConversationHistory: [{ role: "user", content: `<user_message>\n${legacyPrompt}\n</user_message>` }],
				providerRef: { deref: () => ({ getState }) },
			}) as Task

			await expect(task.captureEffectiveInheritedInstructions()).resolves.toEqual({
				effectiveText: instructions,
				sources: [{ kind: "aggregate", ref: "legacy:aggregate", digest }],
			})
			expect(getState).not.toHaveBeenCalled()
		} finally {
			await fs.rm(globalStoragePath, { recursive: true, force: true })
		}
	})

	it("fails closed instead of rereading live instructions when a legacy prompt cannot reproduce the frozen digest", async () => {
		const originalInstructions = "Windows legacy line one\r\nWindows legacy line two"
		const normalizedQuote = originalInstructions
			.replace(/\r\n?/g, "\n")
			.split("\n")
			.map((line) => `> ${line}`)
			.join("\n")
		const getState = vi.fn(async () => ({ customInstructions: "changed live instructions" }))
		const task = Object.assign(Object.create(Task.prototype), {
			taskKind: "subagent",
			subagentContextManifest: {
				instructions: {
					digest: digestValue(originalInstructions),
					sources: [],
				},
			},
			subagentInstructionSnapshotLoaded: true,
			apiConversationHistory: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: [
								"## Frozen inherited instructions",
								"This is the exact parent instruction snapshot captured before launch. Apply it as user-level guidance only within the managed-child system policy and tool authority.",
								normalizedQuote,
							].join("\n\n"),
						},
					],
				},
			],
			providerRef: { deref: () => ({ getState }) },
		}) as Task

		await expect(task.captureEffectiveInheritedInstructions()).rejects.toThrow(
			"frozen instruction snapshot is unavailable",
		)
		expect(getState).not.toHaveBeenCalled()
	})
})
