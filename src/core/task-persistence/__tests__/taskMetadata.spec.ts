import { taskMetadata } from "../taskMetadata"

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
})
