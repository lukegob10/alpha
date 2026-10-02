import { randomUUID } from "node:crypto"

import { isDevelopmentPrompt, WORKFLOW_COMMANDS, type WorkflowPromptName } from "./prompts"
import { developmentScript } from "./developmentCatalog"
import { WorkflowRequestBudget } from "./requestBudget"
import { settlementScript } from "./commandSettlement"
import { BASELINE_MODULE_SOURCE, BASELINE_README, BASELINE_TEST_SOURCE } from "./repositoryFixture"
import { addFilePatch, updateFilePatch } from "./scriptedPatch"

export const ENHANCED_SOURCE = [
	"function sum(values) {",
	"  return values.reduce((total, value) => total + value, 0)",
	"}",
	"module.exports = { sum }",
	"",
].join("\n")

const baseTests = [
	'const assert = require("node:assert/strict")',
	'const test = require("node:test")',
	'const { sum } = require("../lib/stats.cjs")',
	'test("empty array", () => assert.equal(sum([]), 0))',
	'test("numbers", () => assert.equal(sum([1, 2, 3]), 6))',
]

export const FOLLOWUP_README = "# Statistics fixture\n\nsum([]) = 0\nsum([1, 2, 3]) = 6\nsum([-2, 1]) = -1\n"

export function accumulatedCases(step: number) {
	let total = 0
	return Array.from({ length: step }, (_, index) => {
		const value = { step: index + 1, left: total, right: index + 1, sum: total + index + 1 }
		total = value.sum
		return value
	})
}

export function scriptedTests(followup: boolean, extended: boolean): string {
	return [
		...baseTests,
		...(followup ? ['test("negative numbers", () => assert.equal(sum([-2, 1]), -1))'] : []),
		...(extended
			? [
					'const cases = require("./workflow-cases.json")',
					"for (const item of cases) test(`accumulated step ${item.step}`, () => assert.equal(sum([item.left, item.right]), item.sum))",
				]
			: []),
		"",
	].join("\n")
}

interface ScriptTool {
	name: string
	arguments: Record<string, unknown>
}

type ScriptChunk =
	| { type: "tool_call"; id: string; name: string; arguments: string }
	| { type: "text"; text: string }
	| { type: "usage"; inputTokens: number; outputTokens: number; totalCost: number }

function runningCommandSession(messages: readonly unknown[], callId: string): number | undefined {
	const isRecord = (value: unknown): value is Record<string, unknown> =>
		value !== null && typeof value === "object" && !Array.isArray(value)
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]
		if (!isRecord(message) || message.role !== "user" || !Array.isArray(message.content)) continue
		for (const result of message.content) {
			if (!isRecord(result) || result.type !== "tool_result" || result.tool_use_id !== callId) continue
			const texts =
				typeof result.content === "string"
					? [result.content]
					: Array.isArray(result.content)
						? result.content.flatMap((part) =>
								isRecord(part) && part.type === "text" && typeof part.text === "string"
									? [part.text]
									: [],
							)
						: []
			for (const text of texts) {
				// Only the canonical envelope is session metadata; command output can contain arbitrary lookalikes.
				const match = text
					.slice(0, 2048)
					.match(
						/^(?:Chunk ID: [^\r\n]+\r?\n)?Wall time: \d+(?:\.\d+)? seconds\r?\nProcess running with session ID (\d+)\r?\n(?:Original token count: \d+\r?\n)?Output:\r?\n/,
					)
				const session = match ? Number(match[1]) : undefined
				if (session !== undefined && Number.isSafeInteger(session) && session > 0) return session
			}
			return undefined
		}
	}
	return undefined
}

/** An offline provider drives the same tools; it never directly writes fixture files or runs commands. */
export class WorkflowScriptedAI {
	readonly id = `workflow-scripted-${randomUUID()}`
	private calls = 0
	private plan: ScriptTool[] = []
	private finalReport = "The requested workflow step is complete."
	private lastCommandCallId?: string
	private removeRegistration?: () => void

	constructor(
		private readonly budget: WorkflowRequestBudget,
		private readonly workspace: string,
	) {}

	// Cancellation may replace a Task in this host. Keep this fixture provider registered
	// until the scenario ends, then explicitly release its one cache entry.
	get removeFromCache(): undefined {
		return undefined
	}
	set removeFromCache(value: (() => void) | undefined) {
		this.removeRegistration = value
	}
	dispose(): void {
		this.removeRegistration?.()
	}

	setPhase(phase: WorkflowPromptName, step = 1): void {
		this.finalReport = "The requested workflow step is complete."
		this.lastCommandCallId = undefined
		if (phase === "commandSettlement") {
			this.plan = settlementScript(step, this.workspace)
			return
		}
		this.finalReport =
			phase === "devSearchScope"
				? "Copilot matches: docs/integrations.md:3 and config/assistants.json:1. The initial lib search was empty."
				: phase === "devSearchAbsent"
					? "No matches for AlphaMissingProvider947 in tracked repository files."
					: phase === "devVerificationUnavailable"
						? "Integration verification remains unverified: config/local-integration.json is missing. This task is blocked; the read-only review cannot provision that configuration. Repository state is unchanged."
						: "The requested workflow step is complete."
		if (isDevelopmentPrompt(phase)) {
			this.plan = developmentScript(phase, this.workspace)
			return
		}
		const readCommands: Record<string, string> = {
			"lib/stats.cjs": WORKFLOW_COMMANDS.readModule,
			"test/stats.test.cjs": WORKFLOW_COMMANDS.readTests,
			"README.md": WORKFLOW_COMMANDS.readReadme,
			"test/workflow-cases.json": WORKFLOW_COMMANDS.readCases,
		}
		const read = (file: string): ScriptTool => command(readCommands[file] ?? "")
		const update = (file: string, before: string, after: string): ScriptTool => ({
			name: "apply_patch",
			arguments: { patch: updateFilePatch(file, before, after) },
		})
		const add = (file: string, content: string): ScriptTool => ({
			name: "apply_patch",
			arguments: { patch: addFilePatch(file, content) },
		})
		const command = (value: string): ScriptTool => ({
			name: "exec_command",
			arguments: { cmd: value, workdir: this.workspace, yield_time_ms: 10_000 },
		})
		switch (phase) {
			case "review":
				this.plan = [read("lib/stats.cjs"), read("test/stats.test.cjs")]
				break
			case "enhance":
				this.plan = [
					read("lib/stats.cjs"),
					update("lib/stats.cjs", BASELINE_MODULE_SOURCE, ENHANCED_SOURCE),
					update("test/stats.test.cjs", BASELINE_TEST_SOURCE, scriptedTests(false, false)),
					command(WORKFLOW_COMMANDS.test),
				]
				break
			case "commit":
				this.plan = [
					command(WORKFLOW_COMMANDS.diff),
					command(WORKFLOW_COMMANDS.stage),
					command(WORKFLOW_COMMANDS.commit),
				]
				break
			case "followup":
				this.plan = [
					read("test/stats.test.cjs"),
					update("test/stats.test.cjs", scriptedTests(false, false), scriptedTests(true, false)),
					update("README.md", BASELINE_README, FOLLOWUP_README),
					command(WORKFLOW_COMMANDS.test),
				]
				break
			case "hold":
				this.plan = [command(WORKFLOW_COMMANDS.test)]
				break
			case "verify":
				this.plan = [read("lib/stats.cjs"), command(WORKFLOW_COMMANDS.test)]
				break
			case "completionIdle":
				this.plan = [read("lib/stats.cjs"), command(WORKFLOW_COMMANDS.test)]
				break
			case "extend":
				this.plan = [
					read(step === 1 ? "test/stats.test.cjs" : "test/workflow-cases.json"),
					step === 1
						? add("test/workflow-cases.json", JSON.stringify(accumulatedCases(step), null, 2) + "\n")
						: update(
								"test/workflow-cases.json",
								JSON.stringify(accumulatedCases(step - 1), null, 2) + "\n",
								JSON.stringify(accumulatedCases(step), null, 2) + "\n",
							),
					...(step === 1
						? [update("test/stats.test.cjs", scriptedTests(true, false), scriptedTests(true, true))]
						: []),
					command(WORKFLOW_COMMANDS.test),
				]
				break
		}
	}

	async *createMessage(_systemPrompt = "", messages: readonly unknown[] = []): AsyncGenerator<ScriptChunk> {
		this.budget.consume()
		this.calls++
		const session = this.lastCommandCallId ? runningCommandSession(messages, this.lastCommandCallId) : undefined
		const tool =
			session !== undefined
				? { name: "write_stdin", arguments: { session_id: session, chars: "", yield_time_ms: 10_000 } }
				: this.plan.shift()
		if (tool) {
			const id = `${this.id}-${this.calls}`
			this.lastCommandCallId = tool.name === "exec_command" || tool.name === "write_stdin" ? id : undefined
			yield {
				type: "tool_call",
				id,
				name: tool.name,
				arguments: JSON.stringify(tool.arguments),
			}
		} else yield { type: "text", text: this.finalReport }
		yield { type: "usage", inputTokens: 10, outputTokens: 5, totalCost: 0 }
	}
	getModel() {
		return {
			id: this.id,
			info: {
				contextWindow: 128_000,
				maxTokens: 8_192,
				supportsImages: false,
				supportsPromptCache: false,
				inputPrice: 0,
				outputPrice: 0,
			},
		}
	}
	async countTokens(content: unknown[]): Promise<number> {
		return Math.max(1, Math.ceil(JSON.stringify(content).length / 4))
	}
	async completePrompt(): Promise<string> {
		return ""
	}
}
