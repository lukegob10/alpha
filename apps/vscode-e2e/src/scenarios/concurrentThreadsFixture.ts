import * as assert from "assert"

export const COLLECT_CHILD_RESULTS = "Collect the completed child results."

export type ScriptChunk =
	| { type: "text"; text: string }
	| { type: "tool_call"; id: string; name: string; arguments: string }
	| { type: "usage"; inputTokens: number; outputTokens: number; totalCost: number }

export function findLatestToolResult(messages: unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const content = (messages[index] as { content?: unknown } | undefined)?.content
		if (!Array.isArray(content)) continue
		for (let contentIndex = content.length - 1; contentIndex >= 0; contentIndex--) {
			const block = content[contentIndex] as { type?: string; content?: unknown } | undefined
			if (block?.type === "tool_result") {
				if (typeof block.content === "string") return block.content
				if (Array.isArray(block.content)) {
					return block.content
						.flatMap((item: { type?: string; text?: unknown }) =>
							item.type === "text" && typeof item.text === "string" ? [item.text] : [],
						)
						.join("\n")
				}
				return JSON.stringify(block.content)
			}
		}
	}
	throw new Error("The scripted model did not receive a terminal tool result")
}

export class ConcurrentThreadsAI {
	readonly id = "concurrent-threads-e2e"
	readonly started = new Set<string>()
	readonly receivedResults = new Set<string>()
	readonly children: string[] = []
	private rootTaskId?: string
	private readonly turns = new Map<string, number>()
	private releaseRequests!: () => void
	private readonly mayFinish = new Promise<void>((resolve) => {
		this.releaseRequests = resolve
	})
	private finishHostLaunch!: () => void
	private readonly hostChildrenReady = new Promise<void>((resolve) => {
		this.finishHostLaunch = resolve
	})

	constructor(
		private readonly childCount = 0,
		private readonly delivery: "native" | "host" = "native",
	) {}

	registerHostChildren(taskIds: string[]): void {
		assert.equal(this.delivery, "host")
		assert.equal(this.children.length, 0)
		assert.equal(new Set(taskIds).size, this.childCount)
		this.children.push(...taskIds)
		this.finishHostLaunch()
	}

	get coordinatorRequests(): number {
		return (this.rootTaskId && this.turns.get(this.rootTaskId)) || 0
	}

	getDiagnostics() {
		return { turns: [...this.turns], started: [...this.started], receivedResults: [...this.receivedResults] }
	}

	private collectResults(messages: unknown[]): void {
		const history = JSON.stringify(messages)
		for (const childId of this.children) {
			if (history.includes(`Concurrent child ${childId} completed.`)) this.receivedResults.add(childId)
		}
	}

	release(): void {
		this.releaseRequests()
		this.finishHostLaunch()
	}

	async *createMessage(
		_system: string,
		messages: unknown[],
		metadata?: { taskId?: string; signal?: AbortSignal; tools?: Array<{ function?: { name?: string } }> },
	): AsyncGenerator<ScriptChunk> {
		const taskId = metadata?.taskId
		assert.ok(taskId)
		const turn = this.turns.get(taskId) ?? 0
		this.turns.set(taskId, turn + 1)
		if (this.childCount > 0) this.rootTaskId ??= taskId
		if (taskId === this.rootTaskId) {
			if (this.delivery === "native" && turn > 0 && turn <= this.childCount) {
				const created = JSON.parse(findLatestToolResult(messages)) as { threadId: string }
				assert.ok(created.threadId, "Every create_thread call must return its child ID")
				this.children.push(created.threadId)
			}
			if (this.delivery === "host" && turn === 0) {
				await this.hostChildrenReady
				if (metadata?.signal?.aborted) return
			}
			if (this.delivery === "native" && turn < this.childCount) {
				assert.ok(metadata?.tools?.some((tool) => tool.function?.name === "create_thread"))
				yield {
					type: "tool_call",
					id: `${taskId}-create-${turn}`,
					name: "create_thread",
					arguments: JSON.stringify({ prompt: `Concurrent child ${turn + 1}` }),
				}
			} else {
				if (this.delivery === "native" && turn > this.childCount) {
					assert.ok(
						JSON.stringify(messages).includes(COLLECT_CHILD_RESULTS),
						"Collection requires a human follow-up",
					)
					const previousCount = this.receivedResults.size
					this.collectResults(messages)
					if (turn > this.childCount + 1)
						assert.ok(
							this.receivedResults.size > previousCount,
							"Each explicit wait must return new child results",
						)
					assert.ok(turn <= this.childCount * 2 + 1, "Explicit result collection must remain bounded")
					if (this.receivedResults.size < this.childCount) {
						assert.ok(metadata?.tools?.some((tool) => tool.function?.name === "wait_threads"))
						yield {
							type: "tool_call",
							id: `${taskId}-collect-${turn}`,
							name: "wait_threads",
							arguments: JSON.stringify({
								targets: this.children
									.filter((id) => !this.receivedResults.has(id))
									.slice(0, 8)
									.map((threadId) => ({ threadId })),
								timeoutMs: 0,
							}),
						}
						yield { type: "usage", inputTokens: 10, outputTokens: 5, totalCost: 0 }
						return
					}
				} else if (this.delivery === "host" && turn > 0) {
					this.collectResults(messages)
					assert.ok(this.receivedResults.size > 0, "A resumed coordinator must receive child results")
					assert.ok(turn <= this.childCount, "Child results must not cause duplicate wake loops")
				}
				yield {
					type: "text",
					text: `Launched ${this.children.length}; integrated ${this.receivedResults.size}.`,
				}
			}
		} else {
			assert.equal(turn, 0, "Each concurrent worker should need one model request")
			const signal = metadata?.signal
			assert.ok(signal)
			this.started.add(taskId)
			let cancelled!: () => void
			const cancellation = new Promise<void>((resolve) => {
				cancelled = resolve
			})
			if (signal.aborted) cancelled()
			else signal.addEventListener("abort", cancelled, { once: true })
			try {
				await Promise.race([this.mayFinish, cancellation])
			} finally {
				signal.removeEventListener("abort", cancelled)
			}
			if (signal.aborted) return
			yield { type: "text", text: `Concurrent child ${taskId} completed.` }
		}
		yield { type: "usage", inputTokens: 10, outputTokens: 5, totalCost: 0 }
	}

	getModel() {
		return {
			id: this.id,
			info: { contextWindow: 128_000, maxTokens: 8_192, supportsImages: false, supportsPromptCache: false },
		}
	}

	async countTokens(content: unknown[]): Promise<number> {
		return Math.max(1, Math.ceil(JSON.stringify(content).length / 4))
	}

	async completePrompt(): Promise<string> {
		return ""
	}
}
