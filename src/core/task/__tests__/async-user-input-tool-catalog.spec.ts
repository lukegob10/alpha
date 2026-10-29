import { describe, expect, it, vi } from "vitest"

import type { ModelInfo } from "@alpha-code/types"

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: () => ({ isFeatureEnabled: false, isFeatureConfigured: false, isInitialized: false }),
	},
}))

import type { AlphaProvider } from "../../webview/AlphaProvider"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { buildNativeToolsArrayWithRestrictions, buildTaskToolSurface, type BuildToolsOptions } from "../build-tools"
import { TaskToolCatalogCache } from "../TaskToolCatalogCache"

const capableModel: ModelInfo = {
	contextWindow: 128_000,
	supportsPromptCache: false,
	experimental_supported_tools: ["request_user_input_async"],
}

const asyncHistory: ApiMessage[] = [
	{
		role: "assistant",
		content: [
			{
				type: "tool_use",
				id: "saved-async-question",
				name: "request_user_input_async",
				input: { questions: [{ title: "Which environment?" }] },
			},
		],
	},
	{
		role: "user",
		content: [{ type: "tool_result", tool_use_id: "saved-async-question", content: '{"accepted":true}' }],
	},
]

function options(overrides: Partial<BuildToolsOptions> = {}): BuildToolsOptions {
	return {
		provider: { context: {}, getMcpHub: () => undefined } as unknown as AlphaProvider,
		cwd: process.cwd(),
		mode: "code",
		customModes: undefined,
		experiments: {},
		apiConfiguration: undefined,
		...overrides,
	}
}

function namesOf(tools: readonly { type: string; function?: { name: string } }[]): string[] {
	return tools.flatMap((tool) => (tool.type === "function" && tool.function ? [tool.function.name] : []))
}

async function getCatalogNames(overrides: Partial<BuildToolsOptions> = {}) {
	const result = await buildNativeToolsArrayWithRestrictions(options(overrides))
	return namesOf(result.tools)
}

describe("user input tool catalog", () => {
	it.each([
		["code", undefined],
		["code", true],
		["code", false],
		["architect", undefined],
		["architect", true],
		["architect", false],
	] as const)(
		"keeps %s async questions available with waitForQuestionAnswers=%s",
		async (mode, waitForQuestionAnswers) => {
			const surface = await buildTaskToolSurface(
				options({ mode, modelInfo: capableModel, waitForQuestionAnswers, discoveryHistory: asyncHistory }),
			)

			expect(namesOf(surface.schemas)).toContain("request_user_input")
			expect(namesOf(surface.schemas)).toContain("request_user_input_async")
			expect(surface.allowedFunctionNames).toContain("request_user_input")
			expect(surface.allowedFunctionNames).toContain("request_user_input_async")
			expect(surface.isCallable("request_user_input")).toBe(true)
			expect(surface.isCallable("request_user_input_async")).toBe(true)
			expect(surface.resolve("request_user_input_async")).toBeDefined()
		},
	)

	it("gates async questions by model metadata while retaining blocking questions", async () => {
		expect(await getCatalogNames()).toContain("request_user_input")
		expect(await getCatalogNames()).not.toContain("request_user_input_async")
		expect(await getCatalogNames({ waitForQuestionAnswers: false })).not.toContain("request_user_input_async")
		expect(await getCatalogNames({ modelInfo: capableModel })).toEqual(
			expect.arrayContaining(["request_user_input", "request_user_input_async"]),
		)
		expect(
			await getCatalogNames({
				modelInfo: { ...capableModel, experimental_supported_tools: ["send_user_message_async"] },
				waitForQuestionAnswers: false,
			}),
		).toContain("request_user_input_async")
		expect(
			await getCatalogNames({
				modelInfo: { ...capableModel, experimental_supported_tools: ["other_tool"] },
				waitForQuestionAnswers: false,
			}),
		).not.toContain("request_user_input_async")
	})

	it("keeps the question action out of managed child catalogs", async () => {
		expect(await getCatalogNames({ taskKind: "subagent" })).not.toContain("request_user_input")
		expect(
			await getCatalogNames({ taskKind: "subagent", modelInfo: capableModel, waitForQuestionAnswers: false }),
		).not.toContain("request_user_input_async")
	})

	it("honors a captured async-question disable in schema visibility and executable authority", async () => {
		const surface = await buildTaskToolSurface(
			options({
				modelInfo: capableModel,
				taskKind: "primary",
				waitForQuestionAnswers: false,
				disabledTools: ["request_user_input_async"],
			}),
		)
		expect(namesOf(surface.schemas)).not.toContain("request_user_input_async")
		expect(surface.isCallable("request_user_input_async")).toBe(false)
		expect(surface.resolve("request_user_input_async")).toBeUndefined()
		expect(surface.isCallable("request_user_input")).toBe(true)
	})

	it.each([
		{ modelInfo: undefined, disabledTools: undefined },
		{ modelInfo: capableModel, disabledTools: ["request_user_input_async"] },
	])(
		"retains a restricted-provider historical async declaration without restoring callable authority (%j)",
		async ({ modelInfo, disabledTools }) => {
			const captured = options({
				apiConfiguration: { apiProvider: "vertex" },
				includeAllToolsWithRestrictions: true,
				modelInfo,
				disabledTools,
				waitForQuestionAnswers: true,
			})
			const fresh = await buildNativeToolsArrayWithRestrictions(captured)
			// Restricted providers retain supported declarations even when execution is disabled.
			expect(namesOf(fresh.tools).includes("request_user_input_async")).toBe(modelInfo !== undefined)
			expect(fresh.allowedFunctionNames).not.toContain("request_user_input_async")

			const historical = await buildNativeToolsArrayWithRestrictions({
				...captured,
				discoveryHistory: asyncHistory,
			})
			expect(namesOf(historical.tools)).toContain("request_user_input_async")
			expect(historical.allowedFunctionNames).not.toContain("request_user_input_async")
			expect(historical.surface?.allowedFunctionNames).not.toContain("request_user_input_async")
			expect(historical.surface?.isCallable("request_user_input_async")).toBe(false)
			expect(historical.surface?.resolve("request_user_input_async")).toBeUndefined()
			expect(historical.surface?.isCallable("request_user_input")).toBe(true)
		},
	)

	it.each(["openai", "vscode-lm", "vertex"] as const)(
		"keeps async authority independent of answer timing across cached %s catalogs",
		async (apiProvider) => {
			const captured = options({
				apiConfiguration: { apiProvider },
				includeAllToolsWithRestrictions: apiProvider === "vertex",
				modelInfo: capableModel,
				catalogCache: new TaskToolCatalogCache(),
			})
			const nonblocking = await buildTaskToolSurface({ ...captured, waitForQuestionAnswers: false })
			expect(nonblocking.isCallable("request_user_input_async")).toBe(true)

			const waiting = await buildTaskToolSurface({ ...captured, waitForQuestionAnswers: true })
			expect(waiting.digest).toBe(nonblocking.digest)
			expect(namesOf(waiting.schemas)).toContain("request_user_input_async")
			expect(waiting.allowedFunctionNames).toContain("request_user_input_async")
			expect(waiting.isCallable("request_user_input_async")).toBe(true)
			expect(waiting.resolve("request_user_input_async")).toBeDefined()
			expect(waiting.isCallable("request_user_input")).toBe(true)
			expect(nonblocking.isCallable("request_user_input_async")).toBe(true)

			const optedInAgain = await buildTaskToolSurface({ ...captured, waitForQuestionAnswers: false })
			expect(optedInAgain.isCallable("request_user_input_async")).toBe(true)
			expect(waiting.isCallable("request_user_input_async")).toBe(true)
		},
	)
})
