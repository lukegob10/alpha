import { taskMetadata } from "../taskMetadata"
import { captureSubagentContext } from "../../agent/SubagentContextCapture"

describe("taskMetadata sub-agent routing", () => {
	it("persists only the credential-free route snapshot", async () => {
		const route = {
			source: "role" as const,
			resolution: "selected" as const,
			profileId: "explore-id",
			profileName: "Fast Explorer",
			provider: "openrouter",
			modelId: "fast/model",
		}

		const { historyItem } = await taskMetadata({
			taskId: "child-1",
			parentTaskId: "parent-1",
			taskNumber: 2,
			messages: [],
			globalStoragePath: "F:/storage",
			workspace: "F:/workspace",
			taskKind: "subagent",
			subagentModelRoute: route,
		})

		expect(historyItem.subagentModelRoute).toEqual(route)
		expect(historyItem.subagentModelRoute).not.toBe(route)
		expect(JSON.stringify(historyItem.subagentModelRoute)).not.toMatch(/key|secret|authorization/i)
	})

	it("persists a cloned context manifest without private instruction or turn bodies", async () => {
		const route = {
			source: "parent" as const,
			resolution: "selected" as const,
			profileName: "Parent",
			provider: "openai",
			modelId: "alpha-model",
		}
		const { manifest } = captureSubagentContext({
			parentTaskId: "parent-1",
			capturedAt: 100,
			forkTurns: "all",
			history: [{ role: "user", content: "private parent body" }],
			instructions: {
				effectiveText: "private frozen instructions",
				sources: [{ kind: "agents", ref: "F:/workspace/AGENTS.md", text: "private AGENTS body" }],
			},
			skills: [],
			cwd: "F:/workspace",
			workspaceRoots: ["F:/workspace"],
			modelRoute: route,
			runtimePolicy: {
				role: "review",
				read: true,
				execute: false,
				mutate: false,
				delegate: false,
				network: false,
				externalSideEffects: false,
				requireApproval: false,
				allowedTools: ["read_file", "attempt_completion"],
				workspaceRoots: ["F:/workspace"],
			},
		})

		const { historyItem } = await taskMetadata({
			taskId: "child-1",
			parentTaskId: "parent-1",
			taskNumber: 2,
			messages: [],
			globalStoragePath: "F:/storage",
			workspace: "F:/workspace",
			taskKind: "subagent",
			subagentContextManifest: manifest,
		})

		expect(historyItem.subagentContextManifest).toEqual(manifest)
		expect(historyItem.subagentContextManifest).not.toBe(manifest)
		expect(JSON.stringify(historyItem.subagentContextManifest)).not.toContain("private parent body")
		expect(JSON.stringify(historyItem.subagentContextManifest)).not.toContain("private frozen instructions")
		expect(JSON.stringify(historyItem.subagentContextManifest)).not.toContain("private AGENTS body")
	})
})
