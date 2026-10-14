export type BudgetFixtureMode = "hold" | "output" | "root" | "process"

export interface BudgetFixtureObservation {
	taskId: string
	mode: BudgetFixtureMode
	signalProvided: boolean
	abortObserved: boolean
	usageEmitted: boolean
}

type BudgetFixtureChunk =
	| { type: "text"; text: string }
	| { type: "tool_call"; id: string; name: string; arguments: string }
	| { type: "usage"; inputTokens: number; outputTokens: number; totalCost: number }

/**
 * Local-only provider fixture for managed-agent budget boundaries. Usage is
 * deliberately synthetic (and always zero cost); the acceptance suite reports
 * that it is not billing or model-quality evidence.
 */
export class ManagedAgentBudgetAI {
	readonly id = `managed-agent-budget-${Date.now()}`
	removeFromCache?: () => void
	readonly entered = new Set<string>()
	readonly observations = new Map<string, BudgetFixtureObservation>()
	private readonly modes = new Map<string, BudgetFixtureMode>()
	private readonly turns = new Map<string, number>()
	private readonly usageReleaseWaiters = new Map<string, () => void>()
	private readonly usageReleased = new Set<string>()
	private readonly completionReleaseWaiters = new Map<string, () => void>()
	private readonly completionReleased = new Set<string>()

	constructor(private readonly processCommand?: string) {}

	registerRole(taskId: string, mode: BudgetFixtureMode): void {
		this.modes.set(taskId, mode)
	}

	releaseUsage(taskId: string): void {
		this.usageReleased.add(taskId)
		this.usageReleaseWaiters.get(taskId)?.()
		this.usageReleaseWaiters.delete(taskId)
	}

	/**
	 * Allow a usage-bearing stream to close after the host has observed its
	 * usage chunk. Provider usage is settled by the host when the response
	 * completes, so keeping the generator open would intentionally suppress
	 * the budget check and turn a deterministic limit into a timeout.
	 */
	releaseCompletion(taskId: string): void {
		this.completionReleased.add(taskId)
		this.completionReleaseWaiters.get(taskId)?.()
		this.completionReleaseWaiters.delete(taskId)
	}

	private waitForCompletionRelease(taskId: string): Promise<void> {
		if (this.completionReleased.has(taskId)) return Promise.resolve()
		return new Promise<void>((resolve) => this.completionReleaseWaiters.set(taskId, resolve))
	}

	async *createMessage(
		_systemPrompt: string,
		_messages: unknown[],
		metadata?: { taskId?: string; signal?: AbortSignal },
	): AsyncGenerator<BudgetFixtureChunk> {
		const taskId = metadata?.taskId
		if (!taskId) throw new Error("Budget fixture provider request is missing taskId")
		const mode = this.modes.get(taskId) ?? "hold"
		const signal = metadata?.signal
		const observation =
			this.observations.get(taskId) ??
			({
				taskId,
				mode,
				signalProvided: false,
				abortObserved: false,
				usageEmitted: false,
			} satisfies BudgetFixtureObservation)
		observation.signalProvided ||= signal !== undefined
		this.observations.set(taskId, observation)
		if (signal) {
			const onAbort = () => {
				observation.abortObserved = true
			}
			if (signal.aborted) onAbort()
			else signal.addEventListener("abort", onAbort, { once: true })
		}

		const turn = this.turns.get(taskId) ?? 0
		this.turns.set(taskId, turn + 1)
		this.entered.add(taskId)
		if (mode !== "hold" && !this.usageReleased.has(taskId)) {
			await new Promise<void>((resolve) => this.usageReleaseWaiters.set(taskId, resolve))
		}
		if (mode === "process" && turn === 0) {
			if (!this.processCommand) throw new Error("Budget process fixture is missing its command")
			yield {
				type: "tool_call",
				id: `budget-process-${taskId}`,
				name: "shell",
				arguments: JSON.stringify({ command: this.processCommand, timeout: 120 }),
			}
			observation.usageEmitted = true
			yield { type: "usage", inputTokens: 2, outputTokens: 8, totalCost: 0 }
			return
		}
		if (mode === "root" && turn === 0) {
			// A real lifecycle tool result drives the next provider request. The
			// continuation is held by the next provider turn while the sibling's
			// usage is accounted, so root-budget exhaustion can cancel both active
			// children.
			yield {
				type: "tool_call",
				id: `budget-root-wait-${taskId}`,
				name: "wait_agent",
				arguments: JSON.stringify({ timeout_ms: 10_000 }),
			}
			observation.usageEmitted = true
			yield { type: "usage", inputTokens: 2, outputTokens: 8, totalCost: 0 }
			return
		}
		if (!signal) throw new Error("Budget fixture provider request is missing an AbortSignal")
		if (turn > 0 && mode !== "process") {
			if (mode === "root") {
				await new Promise<void>((resolve) => {
					if (signal.aborted) {
						resolve()
						return
					}
					signal.addEventListener("abort", () => resolve(), { once: true })
				})
				return
			}
			yield { type: "text", text: "budget-fixture-followup" }
			return
		}
		if (mode === "process") {
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
			return
		}

		yield { type: "text", text: mode === "hold" ? "budget-fixture-hold" : "budget-fixture-usage" }
		if (mode === "output") {
			observation.usageEmitted = true
			// The values are intentionally synthetic and cost-free. They are large
			// enough to cross the configured local limit deterministically.
			yield { type: "usage", inputTokens: 2, outputTokens: 8, totalCost: 0 }
			await this.waitForCompletionRelease(taskId)
			return
		}

		await new Promise<void>((resolve) => {
			if (signal.aborted) {
				resolve()
				return
			}
			const release = () => resolve()
			signal.addEventListener("abort", release, { once: true })
		})
	}

	dispose(): void {
		for (const release of this.usageReleaseWaiters.values()) release()
		this.usageReleaseWaiters.clear()
		for (const release of this.completionReleaseWaiters.values()) release()
		this.completionReleaseWaiters.clear()
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
