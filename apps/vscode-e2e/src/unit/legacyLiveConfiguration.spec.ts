import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { test as unitTest } from "node:test"
import type { AlphaCodeSettings, AlphaMessage } from "@alpha-code/types"
import { AlphaCodeEventName, toolNames } from "@alpha-code/types"

type FixtureTest = () => Promise<void>
interface Fixture {
	title: string
	run: FixtureTest
}
interface Outcome {
	title: string
	rejectStart?: boolean
	invalidResponse?: boolean
	response?: string
}

async function loadFixtures(): Promise<Fixture[]> {
	const fixtures: Fixture[] = []
	const previousSuite = globalThis.suite
	const previousTest = globalThis.test
	globalThis.suite = ((_title: string, callback: () => void) =>
		callback.call({ timeout() {} })) as unknown as typeof suite
	globalThis.test = ((title: string, run: FixtureTest) => fixtures.push({ title, run })) as unknown as typeof test
	try {
		// Register the real Mocha callbacks only after their temporary globals exist.
		await import("../suite/task.test.js")
		await import("../suite/markdown-lists.test.js")
	} finally {
		globalThis.suite = previousSuite
		globalThis.test = previousTest
	}
	assert.equal(fixtures.length, 5, "Register the task probe and all four Markdown cases")
	return fixtures
}

function formattingOutcomes(title: string): Outcome[] {
	if (title.includes("unordered") && !title.includes("mixed"))
		return [
			{ title: "inline bullet prose", invalidResponse: true, response: "The items are - Apple, Banana, Orange." },
			{ title: "asterisk bullets", response: "* Apple\n* Banana\n* Orange" },
		]
	if (title.includes("ordered") && !title.includes("mixed"))
		return [
			{
				title: "inline numbered prose",
				invalidResponse: true,
				response: "The steps are 1. First step, 2. Second step, 3. Third step.",
			},
			{ title: "closing parenthesis markers", response: "1) First step\n2) Second step\n3) Third step" },
		]
	if (title.includes("nested"))
		return [
			{
				title: "blank lines without horizontal nesting",
				invalidResponse: true,
				response: "- Main item\n\n- Sub-item A\n- Sub-item B",
			},
			{
				title: "only the first child is indented",
				invalidResponse: true,
				response: "- Main item\n  - Sub-item A\n- Sub-item B",
			},
			{ title: "tab indentation", response: "- Main item\n\t- Sub-item A\n\t- Sub-item B" },
		]
	if (title.includes("mixed"))
		return [
			{ title: "hyphenated prose", invalidResponse: true, response: "1. The parser handles foo-bar" },
			{ title: "inline markers", invalidResponse: true, response: "The characters 1. and - are markers." },
			{ title: "nested mixed markers", response: "1. Main item\n   * Child item" },
		]
	return []
}

unitTest("legacy live fixture configuration and Markdown source contracts", async (context) => {
	for (const fixture of await loadFixtures()) {
		const outcomes: Outcome[] = [
			{ title: "completion" },
			{ title: "start failure", rejectStart: true },
			{ title: "wrong response", invalidResponse: true, response: "My name is Codex." },
			...formattingOutcomes(fixture.title),
		]
		for (const outcome of outcomes)
			await context.test(`${fixture.title}: ${outcome.title}`, async () => {
				const original: AlphaCodeSettings = {
					apiProvider: "vscode-lm",
					vsCodeLmModelSelector: { vendor: "copilot", id: "gpt-6-luna" },
					reasoningEffort: "max",
					approvalMode: "ask",
					autoApprovalEnabled: false,
					deniedCommands: ["git push", "npm install"],
				}
				const saved = structuredClone(original)
				let started: AlphaCodeSettings | undefined
				let startedPrompt: string | undefined
				let active = original
				const taskProbe = fixture.title === "Should handle prompt and response correctly"
				const completion: AlphaMessage = {
					ts: 1,
					type: "say",
					say: "completion_result",
					partial: false,
					text:
						outcome.response ??
						(taskProbe
							? "ALPHA_TASK_COMPLETION_PROBE_7F3A"
							: "- Apple\n- Banana\n- Orange\n1. First step\n2. Second step\n3. Third step\n- Main item\n  - Sub-item A\n  - Sub-item B"),
				}
				const task = {
					didComplete: true,
					alphaMessages: [completion],
					messageQueueService: { hasUnconsumedInput: () => false },
					waitForTermination: async () => {},
				}
				const api = Object.assign(new EventEmitter(), {
					sidebarProvider: { getLiveTask: () => task },
					getConfiguration: () => active,
					setConfiguration: async (configuration: AlphaCodeSettings) => {
						active = configuration
					},
					startNewTask: async ({
						configuration,
						text,
					}: {
						configuration: AlphaCodeSettings
						text: string
					}) => {
						started = configuration
						startedPrompt = text
						active = configuration
						if (outcome.rejectStart) throw new Error("Fixture start failed")
						setImmediate(() => {
							api.emit(AlphaCodeEventName.Message, { taskId: "live-fixture", message: completion })
							api.emit(AlphaCodeEventName.TaskCompleted, "live-fixture")
						})
						return "live-fixture"
					},
					clearCurrentTask: async () => {},
					cancelCurrentTask: async () => {},
				})
				const previousApi = globalThis.api
				const previousMode = process.env.ALPHA_E2E_PROVIDER_MODE
				globalThis.api = api as unknown as typeof globalThis.api
				process.env.ALPHA_E2E_PROVIDER_MODE = "live-copilot"
				try {
					if (outcome.rejectStart) await assert.rejects(fixture.run(), /Fixture start failed/)
					else if (outcome.invalidResponse) await assert.rejects(fixture.run(), { code: "ERR_ASSERTION" })
					else await fixture.run()
					assert.equal(started?.apiProvider, "vscode-lm")
					assert.deepEqual(started?.vsCodeLmModelSelector, saved.vsCodeLmModelSelector)
					assert.equal(started?.reasoningEffort, saved.reasoningEffort)
					assert.deepEqual(started?.deniedCommands, saved.deniedCommands)
					if (taskProbe) {
						assert.equal(
							startedPrompt,
							"Respond with exactly this one line and nothing else: ALPHA_TASK_COMPLETION_PROBE_7F3A",
						)
					} else {
						assert.deepEqual(started?.disabledTools, [...toolNames])
						assert.ok(
							startedPrompt?.startsWith("Return the requested Markdown directly in this chat message."),
						)
						assert.ok(
							startedPrompt?.includes(
								"Do not inspect or edit workspace files, run commands, or use tools.",
							),
						)
					}
					assert.deepEqual(active, saved)
					assert.deepEqual(original, saved)
					assert.equal(api.listenerCount(AlphaCodeEventName.Message), 0)
					assert.equal(api.listenerCount(AlphaCodeEventName.TaskCompleted), 0)
				} finally {
					globalThis.api = previousApi
					if (previousMode === undefined) delete process.env.ALPHA_E2E_PROVIDER_MODE
					else process.env.ALPHA_E2E_PROVIDER_MODE = previousMode
				}
			})
	}
})
