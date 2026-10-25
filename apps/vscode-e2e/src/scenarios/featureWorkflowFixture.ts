import { strict as assert } from "node:assert"
import { randomUUID } from "node:crypto"
import * as path from "node:path"
import { validateSkillName } from "@alpha-code/types"

export type FeatureToolCall = { name: string; arguments: Record<string, unknown> }
export type FeatureRequest = {
	taskId: string
	system: string
	messages: unknown[]
	tools: string[]
	ordinal: number
}
type State = {
	requests: FeatureRequest[]
	next(request: FeatureRequest): FeatureToolCall | undefined | Promise<FeatureToolCall | undefined>
	removeRegistration?: () => void
	failure?: { error: unknown }
}

const states = new WeakMap<object, State>()

/** Script only model decisions; all dispatched effects still traverse the production task and tool scheduler. */
export class FeatureScriptedAI {
	readonly id = `feature-workflow-${randomUUID()}`
	constructor(next: State["next"]) {
		states.set(this, { requests: [], next })
	}
	get requests(): readonly FeatureRequest[] {
		return states.get(this)!.requests
	}
	assertHealthy(): void {
		const failure = states.get(this)!.failure
		if (failure) throw failure.error
	}
	get removeFromCache(): undefined {
		return undefined
	}
	set removeFromCache(value: (() => void) | undefined) {
		states.get(this)!.removeRegistration = value
	}
	dispose(): void {
		states.get(this)!.removeRegistration?.()
	}
	async *createMessage(
		system: string,
		messages: unknown[],
		metadata?: { taskId?: string; attemptId?: string; tools?: readonly { function?: { name?: string } }[] },
	) {
		if (metadata?.attemptId === "title") {
			yield { type: "text" as const, text: "Feature workflow fixture" }
			return
		}
		const state = states.get(this)!
		this.assertHealthy()
		try {
			assert.ok(metadata?.taskId, "A real task must own every feature workflow request")
			const request: FeatureRequest = {
				taskId: metadata.taskId,
				system,
				messages: structuredClone(messages),
				tools: (metadata.tools ?? []).flatMap((tool) => (tool.function?.name ? [tool.function.name] : [])),
				ordinal: state.requests.filter((item) => item.taskId === metadata.taskId).length + 1,
			}
			state.requests.push(request)
			assert.ok(request.ordinal <= 20, "Feature workflow exceeded its deterministic request bound")
			const operation = await state.next(request)
			if (operation) {
				assert.ok(
					request.tools.includes(operation.name),
					`${operation.name} must belong to the captured task surface`,
				)
				yield {
					type: "tool_call" as const,
					id: `${this.id}-${request.ordinal}`,
					name: operation.name,
					arguments: JSON.stringify(operation.arguments),
				}
			} else {
				yield { type: "text" as const, text: "Owned feature workflow verified." }
			}
		} catch (error) {
			// Provider retries must not advance past a failed fixture assertion and turn a broken scenario green.
			state.failure = { error }
			throw error
		}
	}
	getModel() {
		return {
			id: this.id,
			info: { contextWindow: 64_000, maxTokens: 2_000, supportsImages: false, supportsPromptCache: false },
		}
	}
	async countTokens(content: unknown[]): Promise<number> {
		return Math.ceil(JSON.stringify(content).length / 4)
	}
	async completePrompt(): Promise<string> {
		return "Feature workflow fixture"
	}
}

export function featureSkillName(directory: string): string {
	const name = path.basename(directory).toLowerCase()
	assert.ok(validateSkillName(name).valid, "The owned fixture must use a valid production skill identity")
	return name
}

export function assertFeatureToolResult(
	messages: readonly unknown[],
	callId: string,
	expected: { error: boolean; marker?: string },
): Record<string, unknown> {
	const results: Record<string, unknown>[] = []
	for (const message of messages) {
		if (!message || typeof message !== "object") continue
		const record = message as Record<string, unknown>
		if (record.role !== "user" || !Array.isArray(record.content)) continue
		for (const block of record.content) {
			if (!block || typeof block !== "object") continue
			const result = block as Record<string, unknown>
			if (result.type === "tool_result" && result.tool_use_id === callId) results.push(result)
		}
	}
	assert.equal(results.length, 1, `Expected exactly one persisted tool result for ${callId}`)
	assert.equal(results[0]!.is_error, expected.error, `Tool result ${callId} must retain its actual outcome`)
	if (expected.marker)
		assert.ok(
			JSON.stringify(results[0]!.content).includes(expected.marker),
			`Tool result ${callId} is missing ${expected.marker}`,
		)
	return results[0]!
}

export function assertFeatureTicketListResult(
	messages: readonly unknown[],
	callId: string,
): { tickets: unknown[]; total: number } {
	const terminal = assertFeatureToolResult(messages, callId, { error: false })
	assert.equal(typeof terminal.content, "string", `Ticket list ${callId} must retain its native JSON result`)
	const envelope: unknown = JSON.parse(terminal.content as string)
	assert.ok(envelope && typeof envelope === "object" && !Array.isArray(envelope))
	const record = envelope as Record<string, unknown>
	assert.equal(record.status, "success", `Ticket list ${callId} must be a successful Ticket result`)
	assert.ok(record.result && typeof record.result === "object" && !Array.isArray(record.result))
	const list = record.result as Record<string, unknown>
	assert.ok(Array.isArray(list.tickets), `Ticket list ${callId} must contain its returned tickets`)
	assert.ok(
		typeof list.total === "number" && Number.isSafeInteger(list.total) && list.total >= 0,
		`Ticket list ${callId} must retain its returned total`,
	)
	return { tickets: list.tickets, total: list.total }
}

export function assertFeatureToolCall(
	messages: readonly unknown[],
	callId: string,
	toolName: string,
	expectedArguments?: Record<string, unknown>,
): void {
	const calls: Record<string, unknown>[] = []
	for (const message of messages) {
		if (!message || typeof message !== "object") continue
		const record = message as Record<string, unknown>
		if (record.role !== "assistant" || !Array.isArray(record.content)) continue
		for (const block of record.content) {
			if (!block || typeof block !== "object") continue
			const call = block as Record<string, unknown>
			if (call.type === "tool_use" && call.id === callId) calls.push(call)
		}
	}
	assert.equal(calls.length, 1, `Expected exactly one persisted tool call for ${callId}`)
	assert.equal(calls[0]!.name, toolName, `Tool call ${callId} must retain its native tool name`)
	if (expectedArguments !== undefined)
		assert.deepEqual(calls[0]!.input, expectedArguments, `Tool call ${callId} must retain its actual arguments`)
}

export function assertFeatureCommandResult(
	messages: readonly unknown[],
	callId: string,
	expected: { exitCode: number; marker?: string },
): void {
	// A completed nonzero command is a successful tool transaction; its process outcome lives in the receipt.
	const result = assertFeatureToolResult(messages, callId, { error: false })
	assert.equal(typeof result.content, "string", `Command result ${callId} must retain its receipt`)
	const receipt = (result.content as string).replaceAll("\r\n", "\n")
	const outputBoundary = receipt.indexOf("\nOutput:\n")
	assert.ok(outputBoundary >= 0, `Command result ${callId} must separate receipt metadata from output`)
	const header = receipt.slice(0, outputBoundary)
	const exits = [...header.matchAll(/^Process exited with code (-?\d+)$/gm)]
	assert.equal(exits.length, 1, `Command result ${callId} must retain exactly one completed process exit`)
	assert.equal(
		Number(exits[0]![1]),
		expected.exitCode,
		`Command result ${callId} must retain the actual process exit`,
	)
	if (expected.marker)
		assert.ok(
			receipt.slice(outputBoundary + "\nOutput:\n".length).includes(expected.marker),
			`Command result ${callId} is missing its expected verification diagnostic`,
		)
}

export function toolResultRecords(value: unknown): Record<string, unknown>[] {
	if (typeof value === "string") {
		try {
			return toolResultRecords(JSON.parse(value))
		} catch {
			return []
		}
	}
	if (!value || typeof value !== "object") return []
	if (Array.isArray(value)) return value.flatMap(toolResultRecords)
	const record = value as Record<string, unknown>
	return [record, ...Object.values(record).flatMap(toolResultRecords)]
}
