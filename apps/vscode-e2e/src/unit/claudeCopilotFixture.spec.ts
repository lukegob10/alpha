import { strict as assert } from "node:assert"
import { readFile } from "node:fs/promises"
import * as path from "node:path"
import { test } from "node:test"
import { runInNewContext } from "node:vm"

class TextPart {
	constructor(readonly value: string) {}
}

class ThinkingPart {
	constructor(
		readonly value: string,
		readonly id: string,
		readonly metadata: Record<string, unknown>,
	) {}
}

class ToolCallPart {
	constructor(
		readonly callId: string,
		readonly name: string,
		readonly input: unknown,
	) {}
}

interface FixtureModel {
	id: string
	family: string
}

interface FixtureOptions {
	tools?: Array<{ name: string }>
	modelOptions?: Record<string, unknown>
	includeEncryptedThinking?: boolean
}

interface FixtureProvider {
	provideLanguageModelChatInformation(): FixtureModel[]
	provideLanguageModelChatResponse(
		model: FixtureModel,
		messages: unknown[],
		options: FixtureOptions,
		progress: { report(part: unknown): void },
		token: { isCancellationRequested: boolean; onCancellationRequested(): { dispose(): void } },
	): Promise<void>
}

interface FixtureControl {
	reset(scenario: string): void
	getRequests(): Array<{
		modelId: string
		modelOptions?: Record<string, unknown>
		includeEncryptedThinking?: boolean
	}>
}

async function loadFixture() {
	const providers = new Map<string, FixtureProvider>()
	const fixtureModule = { exports: {} }
	runInNewContext(
		await readFile(path.resolve(__dirname, "../../fixtures/vscode-lm-provider/extension.js"), "utf8"),
		{
			module: fixtureModule,
			require: (specifier: string) => {
				assert.equal(specifier, "vscode")
				return {
					LanguageModelTextPart: TextPart,
					LanguageModelThinkingPart: ThinkingPart,
					LanguageModelToolCallPart: ToolCallPart,
					LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
					lm: {
						registerLanguageModelChatProvider(vendor: string, provider: FixtureProvider) {
							providers.set(vendor, provider)
							return { dispose() {} }
						},
					},
				}
			},
			console: { log() {} },
		},
		{ timeout: 1_000 },
	)
	const extension = fixtureModule.exports as { activate(context: { subscriptions: unknown[] }): FixtureControl }
	return { control: extension.activate({ subscriptions: [] }), providers }
}

test("the deterministic Claude model is isolated from existing fixtures and never uses a live model ID", async () => {
	const { providers } = await loadFixture()
	assert.deepEqual(
		Array.from(providers.get("alpha-e2e")!.provideLanguageModelChatInformation(), ({ id }) => id),
		["alpha-e2e-model", "alpha-e2e-next-model"],
	)
	const claude = providers.get("copilot")!.provideLanguageModelChatInformation()
	assert.equal(claude.length, 1)
	assert.equal(claude[0]!.id, "alpha-e2e-fixture-claude-sonnet-4.6")
	assert.equal(claude[0]!.family, "claude-sonnet-4.6")
})

test("the native Copilot fixture withholds encrypted replay state unless the caller explicitly requests it", async () => {
	const { control, providers } = await loadFixture()
	const provider = providers.get("copilot")!
	const model = provider.provideLanguageModelChatInformation()[0]!
	for (const includeEncryptedThinking of [false, true]) {
		control.reset("claude-tool-followup")
		const parts: unknown[] = []
		await provider.provideLanguageModelChatResponse(
			model,
			[],
			{
				tools: [{ name: "exec_command" }],
				modelOptions: { reasoningEffort: "high", _enableThinking: true },
				includeEncryptedThinking,
			},
			{ report: (part) => parts.push(part) },
			{ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
		)
		const thinking = parts.filter((part): part is ThinkingPart => part instanceof ThinkingPart)
		assert.equal(thinking[0]!.value, "Inspect the Claude fixture")
		assert.equal(
			thinking.filter(({ metadata }) => typeof metadata.encrypted_content === "string").length,
			includeEncryptedThinking ? 1 : 0,
		)
		assert.equal(thinking.at(-1)!.id, "")
		assert.equal(thinking.at(-1)!.metadata.vscode_reasoning_done, true)
		assert.ok(parts.at(-1) instanceof ToolCallPart)
		const request = control.getRequests()[0]!
		assert.equal(request.modelId, model.id)
		assert.equal(request.includeEncryptedThinking, includeEncryptedThinking)
		assert.equal(request.modelOptions?.reasoningEffort, "high")
		assert.equal(request.modelOptions?._enableThinking, true)
	}
})
