import { describe, expect, it, vi } from "vitest"

import type { ModelInfo } from "@alpha-code/types"

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: () => ({ isFeatureEnabled: false, isFeatureConfigured: false, isInitialized: false }),
	},
}))

import type { AlphaProvider } from "../../webview/AlphaProvider"
import { buildNativeToolsArrayWithRestrictions, buildTaskToolSurface } from "../build-tools"

const capableModel: ModelInfo = {
	contextWindow: 128_000,
	supportsPromptCache: false,
	experimental_supported_tools: ["request_user_input_async"],
}

async function getCatalogNames(modelInfo?: ModelInfo, taskKind: "primary" | "subagent" = "primary") {
	const result = await buildNativeToolsArrayWithRestrictions({
		provider: { context: {}, getMcpHub: () => undefined } as unknown as AlphaProvider,
		cwd: process.cwd(),
		mode: "code",
		customModes: undefined,
		experiments: {},
		apiConfiguration: undefined,
		modelInfo,
		taskKind,
	})

	return result.tools.map((tool) => (tool.type === "function" ? tool.function.name : ""))
}

describe("user input tool catalog", () => {
	it("always exposes blocking questions to primary Code tasks and gates async questions by model metadata", async () => {
		expect(await getCatalogNames()).toContain("request_user_input")
		expect(await getCatalogNames()).not.toContain("request_user_input_async")
		expect(
			await getCatalogNames({ ...capableModel, experimental_supported_tools: ["send_user_message_async"] }),
		).toContain("request_user_input_async")
		expect(await getCatalogNames({ ...capableModel, experimental_supported_tools: ["other_tool"] })).not.toContain(
			"request_user_input_async",
		)
	})

	it("keeps the question action out of managed child catalogs", async () => {
		expect(await getCatalogNames(undefined, "subagent")).not.toContain("request_user_input")
		expect(await getCatalogNames(capableModel, "subagent")).not.toContain("request_user_input_async")
	})

	it("honors a captured async-question disable in schema visibility and executable authority", async () => {
		const surface = await buildTaskToolSurface({
			provider: { context: {}, getMcpHub: () => undefined } as unknown as AlphaProvider,
			cwd: process.cwd(),
			mode: "code",
			customModes: undefined,
			experiments: {},
			apiConfiguration: undefined,
			modelInfo: capableModel,
			taskKind: "primary",
			disabledTools: ["request_user_input_async"],
		})
		expect(surface.schemas.map((tool) => (tool.type === "function" ? tool.function.name : ""))).not.toContain(
			"request_user_input_async",
		)
		expect(surface.isCallable("request_user_input_async")).toBe(false)
		expect(surface.resolve("request_user_input_async")).toBeUndefined()
		expect(surface.isCallable("request_user_input")).toBe(true)
	})
})
