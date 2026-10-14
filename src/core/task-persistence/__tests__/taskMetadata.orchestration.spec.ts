import { historyItemSchema, type SubagentManifestOrchestration } from "@alpha-code/types"

import { captureSubagentContext } from "../../agent/SubagentContextCapture"
import { taskMetadata } from "../taskMetadata"

const orchestration: SubagentManifestOrchestration = {
	ancestry: {
		rootTaskId: "root-1",
		parentTaskId: "parent-1",
		depth: 2,
		maxDepth: 3,
	},
	delegationPolicy: {
		policy: "explicit-only",
		source: "task",
		authorization: "task-opt-in",
		explicitUserRequest: true,
	},
	limits: {
		maxConcurrentTasks: 8,
		maxConcurrentSubagents: 3,
		maxInputTokens: 24_000,
		maxOutputTokens: 6_000,
		roleTimeoutsMs: {
			explore: 110_000,
			review: 130_000,
			worker: 800_000,
		},
		timeoutMs: 130_000,
		rootTokenBudget: 120_000,
		rootCostBudget: 15,
	},
}

describe("taskMetadata orchestration persistence", () => {
	let storageRoot: string
	let tempBase: string
	let workspace: string

	beforeEach(async () => {
		tempBase = await fs.realpath(os.tmpdir())
		storageRoot = await fs.mkdtemp(path.join(tempBase, "alpha-task-orchestration-"))
		workspace = path.join(storageRoot, "workspace")
	})

	afterEach(async () => {
		expect(path.dirname(storageRoot)).toBe(tempBase)
		expect(path.basename(storageRoot)).toMatch(/^alpha-task-orchestration-/)
		await fs.rm(storageRoot, { recursive: true, force: true })
	})

	it("round-trips frozen ancestry, policy, limits, opt-in, and stop reason without re-resolving defaults", async () => {
		const { manifest } = captureSubagentContext({
			parentTaskId: "parent-1",
			capturedAt: 100,
			forkTurns: "none",
			history: [],
			instructions: {
				effectiveText: "frozen instructions",
				sources: [{ kind: "agents", ref: path.join(workspace, "AGENTS.md"), text: "frozen instructions" }],
			},
			skills: [],
			cwd: workspace,
			workspaceRoots: [workspace],
			modelRoute: {
				source: "parent",
				resolution: "selected",
				profileName: "Parent",
				provider: "openai",
				modelId: "alpha-model",
			},
			runtimePolicy: {
				role: "review",
				read: true,
				execute: false,
				mutate: false,
				delegate: true,
				network: false,
				externalSideEffects: false,
				requireApproval: false,
				allowedTools: ["read_file", "spawn_agent", "attempt_completion"],
				workspaceRoots: [workspace],
			},
			orchestration,
		})

		const { historyItem } = await taskMetadata({
			taskId: "child-1",
			rootTaskId: "root-1",
			parentTaskId: "parent-1",
			taskNumber: 3,
			messages: [],
			globalStoragePath: storageRoot,
			workspace,
			taskKind: "subagent",
			subagentContextManifest: manifest,
			subagentInstructionPlacement: "system",
			subagentDelegationPolicy: "explicit-only",
			subagentDelegationExplicitlyEnabled: true,
			stopReason: "timeout",
		})

		orchestration.limits.maxConcurrentSubagents = 9
		const reloaded = historyItemSchema.parse(JSON.parse(JSON.stringify(historyItem)))

		expect(reloaded).toMatchObject({
			rootTaskId: "root-1",
			parentTaskId: "parent-1",
			subagentDelegationPolicy: "explicit-only",
			subagentDelegationExplicitlyEnabled: true,
			subagentInstructionPlacement: "system",
			stopReason: "timeout",
		})
		expect(reloaded.subagentContextManifest?.orchestration).toEqual({
			...orchestration,
			limits: { ...orchestration.limits, maxConcurrentSubagents: 3 },
		})
		expect(reloaded.subagentContextManifest).not.toBe(manifest)
	})
})
import fs from "fs/promises"
import os from "os"
import path from "path"
