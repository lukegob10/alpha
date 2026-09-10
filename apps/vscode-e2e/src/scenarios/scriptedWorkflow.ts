import { randomUUID } from "node:crypto"

import { isDevelopmentPrompt, WORKFLOW_COMMANDS, type WorkflowPromptName } from "./prompts"
import { developmentScript } from "./developmentCatalog"
import { WorkflowRequestBudget } from "./requestBudget"
import { settlementScript } from "./commandSettlement"

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

/** An offline provider drives the same tools; it never directly writes fixture files or runs commands. */
export class WorkflowScriptedAI {
	readonly id = `workflow-scripted-${randomUUID()}`
	private calls = 0
	private plan: ScriptTool[] = []
	private finalReport = "The requested workflow step is complete."
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
		if (phase === "commandSettlement") {
			this.plan = settlementScript(step, this.workspace)
			return
		}
		this.finalReport =
			phase === "devSearchScope"
				? "Copilot matches: docs/integrations.md:3 and config/assistants.json:1. The initial lib search was empty."
				: phase === "devSearchAbsent"
					? "No matches for AlphaMissingProvider947 in tracked repository files."
					: "The requested workflow step is complete."
		if (isDevelopmentPrompt(phase)) {
			this.plan = developmentScript(phase, this.workspace)
			return
		}
		const read = (file: string): ScriptTool => ({ name: "read_file", arguments: { path: file } })
		const write = (file: string, content: string): ScriptTool => ({
			name: "write_to_file",
			arguments: { path: file, content },
		})
		const command = (value: string): ScriptTool => ({
			name: "execute_command",
			arguments: { command: value, cwd: this.workspace, timeout: 30 },
		})
		switch (phase) {
			case "review":
				this.plan = [read("lib/stats.cjs"), read("test/stats.test.cjs")]
				break
			case "enhance":
				this.plan = [
					read("lib/stats.cjs"),
					write("lib/stats.cjs", ENHANCED_SOURCE),
					write("test/stats.test.cjs", scriptedTests(false, false)),
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
					write("test/stats.test.cjs", scriptedTests(true, false)),
					write("README.md", FOLLOWUP_README),
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
				this.plan = [
					read("lib/stats.cjs"),
					command(WORKFLOW_COMMANDS.test),
					{ name: "attempt_completion", arguments: { result: this.finalReport, outcome: "completed" } },
				]
				break
			case "extend":
				this.plan = [
					read(step === 1 ? "test/stats.test.cjs" : "test/workflow-cases.json"),
					write("test/workflow-cases.json", JSON.stringify(accumulatedCases(step), null, 2) + "\n"),
					write("test/stats.test.cjs", scriptedTests(true, true)),
					command(WORKFLOW_COMMANDS.test),
				]
				break
		}
	}

	async *createMessage(): AsyncGenerator<ScriptChunk> {
		this.budget.consume()
		this.calls++
		const tool = this.plan.shift()
		if (tool)
			yield {
				type: "tool_call",
				id: `${this.id}-${this.calls}`,
				name: tool.name,
				arguments: JSON.stringify(tool.arguments),
			}
		else yield { type: "text", text: this.finalReport }
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
