import { customToolRegistry } from "@alpha-code/core"
import type { CustomToolDefinition } from "@alpha-code/types"
import { afterEach, describe, expect, it, vi } from "vitest"

import { webviewMessageHandler } from "../webviewMessageHandler"
import type { AlphaProvider } from "../AlphaProvider"

afterEach(() => vi.restoreAllMocks())

describe("custom tool refresh catalog", () => {
	it("publishes the owned workspace result and explicitly reports failed sources", async () => {
		const definition: CustomToolDefinition = {
			name: "workspace_tool",
			description: "Current workspace tool",
			execute: async () => "result",
		}
		const readGlobal = vi
			.spyOn(customToolRegistry, "getAllSerialized")
			.mockReturnValue([{ name: "other_workspace_tool", description: "Other workspace tool" }])
		vi.spyOn(customToolRegistry, "loadFromDirectories").mockResolvedValue({
			loaded: [definition.name],
			failed: [{ file: "broken.js", error: "reload failed" }],
			catalog: [definition],
		})
		const postMessageToWebview = vi.fn()
		const host = {
			cwd: "/workspace",
			contextProxy: { getValue: () => ({ customTools: true }) },
			getCurrentTask: () => undefined,
			postMessageToWebview,
		} as unknown as AlphaProvider

		await webviewMessageHandler(host, { type: "refreshCustomTools" })

		expect(readGlobal).not.toHaveBeenCalled()
		expect(postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "customToolsResult",
			tools: [
				{
					name: definition.name,
					description: definition.description,
					parameters: undefined,
					source: undefined,
				},
			],
			error: "broken.js: reload failed",
		})
	})

	it.each([undefined, false])("does not import workspace modules while saved enablement is %s", async (enabled) => {
		const load = vi.spyOn(customToolRegistry, "loadFromDirectories")
		const postMessageToWebview = vi.fn()
		const host = {
			cwd: "/workspace",
			contextProxy: { getValue: () => (enabled === undefined ? undefined : { customTools: enabled }) },
			postMessageToWebview,
		} as unknown as AlphaProvider
		await webviewMessageHandler(host, { type: "refreshCustomTools" })
		expect(load).not.toHaveBeenCalled()
		expect(postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "customToolsResult",
			tools: [],
			error: expect.any(String),
		})
	})
})
