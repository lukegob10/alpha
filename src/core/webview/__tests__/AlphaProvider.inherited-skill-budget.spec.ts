import * as path from "path"
import { describe, expect, it, vi } from "vitest"
import { AlphaProvider } from "../AlphaProvider"
import { buildInternalTaskEnvelope } from "../../agent/InternalTaskEnvelope"
import { captureSubagentContext } from "../../agent/SubagentContextCapture"
import type { SkillCatalogEntry } from "../../prompts/sections/skills"

describe("managed child initial inherited skill context", () => {
	it("bounds a 1,000-entry catalog before child creation while retaining every frozen identity", async () => {
		const cwd = process.cwd()
		const skills: SkillCatalogEntry[] = Array.from({ length: 1_000 }, (_, index) => {
			const name = `review-${String(index).padStart(4, "0")}`
			return { name, description: "D".repeat(1_024), path: path.join(cwd, ".agents", "skills", name, "SKILL.md") }
		})
		skills.push({
			name: "hidden-review",
			description: "HIDDEN_DESCRIPTION",
			path: path.join(cwd, "HIDDEN_PATH", "SKILL.md"),
			allowImplicitInvocation: false,
		})
		const policy = {
			read: true,
			execute: false,
			mutate: false,
			delegate: false,
			network: false,
			externalSideEffects: false,
			requireApproval: true,
		}
		const route = {
			source: "parent" as const,
			resolution: "selected" as const,
			profileName: "Default",
			provider: "openai",
			modelId: "fixture-model",
		}
		const orchestration = {
			ancestry: { rootTaskId: "parent-1", parentTaskId: "parent-1", depth: 1, maxDepth: 2 },
			delegationPolicy: {
				policy: "explicit-only" as const,
				source: "task" as const,
				authorization: "task-opt-in" as const,
				explicitUserRequest: true,
			},
			limits: {
				maxConcurrentTasks: 3,
				maxConcurrentSubagents: 2,
				maxInputTokens: 24_000,
				maxOutputTokens: 6_000,
				roleTimeoutsMs: { explore: 120_000, review: 300_000, worker: 900_000 },
				timeoutMs: 300_000,
				rootTokenBudget: null,
				rootCostBudget: null,
			},
		}
		const { manifest } = captureSubagentContext({
			parentTaskId: "parent-1",
			capturedAt: 1,
			forkTurns: "none",
			history: [],
			instructions: {
				effectiveText: "Frozen repository instructions",
				sources: [
					{ kind: "aggregate", ref: "task:parent-1:instructions", text: "Frozen repository instructions" },
				],
			},
			skills: skills.map((skill) => ({ ...skill, content: "Frozen skill instructions" })),
			cwd,
			workspaceRoots: [cwd],
			modelRoute: route,
			orchestration,
			runtimePolicy: { role: "review", ...policy, allowedTools: ["read_file", "skill"], workspaceRoots: [cwd] },
		})
		const envelope = buildInternalTaskEnvelope({
			id: "child-1",
			parentTaskId: "parent-1",
			rootTaskId: "parent-1",
			depth: 1,
			objective: "Review the repository",
			agentKind: "review",
			parentPolicy: policy,
			requestedPolicy: {},
			workspaceRoots: [cwd],
			budget: {
				maxDepth: 2,
				maxConcurrency: 2,
				maxInputTokens: 24_000,
				maxOutputTokens: 6_000,
				timeoutMs: 300_000,
			},
		})
		const descriptor = {
			parent: { taskId: "parent-1", cwd, historyWorkspacePath: cwd },
			groupId: "group-1",
			nickname: "reviewer",
			role: "review",
			modelRoute: {
				route,
				apiConfiguration: { apiProvider: "openai", openAiModelId: "fixture-model" },
				apiConfigName: "Default",
			},
			contextManifest: manifest,
			inheritedSkills: skills,
			inheritedSkillMode: "code",
			inheritedInstructions: "Frozen repository instructions",
		}
		let initialContext: string | undefined
		const stopAfterInputCapture = new Error("Input captured before child launch")
		const createTask = vi.fn(
			async (
				_prompt: string,
				_images: unknown,
				_parent: unknown,
				options: { subagentInitialContext?: string },
			) => {
				initialContext = options.subagentInitialContext
				throw stopAfterInputCapture
			},
		)
		const provider = Object.assign(Object.create(AlphaProvider.prototype), {
			subagentDescriptors: new Map([[envelope.id, descriptor]]),
			preparedSubagentGroups: new Map(),
			createTask,
		}) as AlphaProvider

		await expect(provider["executeSubagentEnvelope"](envelope, new AbortController().signal)).rejects.toBe(
			stopAfterInputCapture,
		)
		expect(createTask).toHaveBeenCalledOnce()
		expect(initialContext).toContain("Host-supplied managed-child context")
		expect(initialContext).toContain("review-0000")
		expect(initialContext).not.toContain("review-0999")
		expect(initialContext).not.toContain("hidden-review")
		expect(initialContext).not.toContain("HIDDEN_DESCRIPTION")
		expect(initialContext).not.toContain("HIDDEN_PATH")
		const metadata = /<available_skills>\n?([\s\S]*?)\n?<\/available_skills>/.exec(initialContext ?? "")?.[1]
		expect(metadata).toBeDefined()
		expect(Array.from(metadata ?? "").length).toBeLessThanOrEqual(8_000)
		expect(descriptor.contextManifest.skills).toHaveLength(1_001)
		expect(descriptor.inheritedSkills).toHaveLength(1_001)
	})
})
