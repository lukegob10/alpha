/** The registration ID is a separate contract from getModel().id and survives settings serialization. */
export class PairedScriptedAI {
	readonly id: string
	requests = 0
	removeFromCache?: () => void

	constructor(
		nonce: string,
		role: "a" | "b",
		private readonly onRequest: () => Promise<void>,
	) {
		this.id = `paired-host-${nonce}-${role}`
	}

	async *createMessage() {
		if (++this.requests !== 1) throw new Error("scripted_request_limit")
		await this.onRequest()
		yield { type: "text" as const, text: "Shared-storage verification completed." }
		yield { type: "usage" as const, inputTokens: 10, outputTokens: 5, totalCost: 0 }
	}

	getModel() {
		return { id: "paired-host-scripted", info: { contextWindow: 128_000, maxTokens: 8_192 } }
	}

	async countTokens() {
		return 10
	}
	async completePrompt() {
		return ""
	}
}
