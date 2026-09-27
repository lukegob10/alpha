import { describe, expect, it, vi } from "vitest"

import type { ModelInfo } from "@alpha-code/types"

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: () => ({ isFeatureEnabled: false, isFeatureConfigured: false, isInitialized: false }),
	},
}))

import type { AlphaProvider } from "../../webview/AlphaProvider"
import { buildNativeToolsArrayWithRestrictions } from "../build-tools"

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

describe("async user input tool catalog", () => {
	it("exposes the schema only when exact catalog metadata opts in", async () => {
		expect(await getCatalogNames()).not.toContain("request_user_input_async")
		expect(
			await getCatalogNames({ ...capableModel, experimental_supported_tools: ["send_user_message_async"] }),
		).toContain("request_user_input_async")
		expect(await getCatalogNames({ ...capableModel, experimental_supported_tools: ["other_tool"] })).not.toContain(
			"request_user_input_async",
		)
	})

	it("keeps the question action out of managed child catalogs", async () => {
		expect(await getCatalogNames(capableModel, "subagent")).not.toContain("request_user_input_async")
	})
})
