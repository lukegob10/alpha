const vscode = require("vscode")

const MODEL = Object.freeze({
	id: "alpha-e2e-model",
	name: "Alpha deterministic E2E model",
	family: "alpha-e2e",
	version: "1.0.0",
	maxInputTokens: 128_000,
	maxOutputTokens: 8_192,
	capabilities: { imageInput: false, toolCalling: true },
})

let scenario = "tool-followup"
let requests = []
let heldRequestIndexes = new Set()
let releaseRequests = new Map()
let events = []
let scenarioStartedAt = Date.now()

const recordEvent = (type, requestIndex, token) => {
	const event = {
		type,
		requestIndex,
		elapsedMs: Date.now() - scenarioStartedAt,
		cancellationRequested: token?.isCancellationRequested,
	}
	events.push(event)
	console.log(`[alpha-e2e-lm] ${JSON.stringify(event)}`)
}

const summarizePart = (part) => {
	if (part instanceof vscode.LanguageModelToolCallPart) {
		return { kind: "tool_call", callId: part.callId, name: part.name, input: part.input }
	}
	if (part instanceof vscode.LanguageModelToolResultPart) {
		return { kind: "tool_result", callId: part.callId, content: part.content.map(summarizePart) }
	}
	if (part instanceof vscode.LanguageModelTextPart) return { kind: "text", value: part.value }
	return { kind: "unknown", value: String(part) }
}

const waitForRelease = async (requestIndex, token) => {
	if (!heldRequestIndexes.has(requestIndex)) return !token.isCancellationRequested

	return new Promise((resolve) => {
		let cancellationDisposable
		const finish = (released) => {
			cancellationDisposable?.dispose()
			releaseRequests.delete(requestIndex)
			resolve(released)
		}
		releaseRequests.set(requestIndex, () => finish(true))
		cancellationDisposable = token.onCancellationRequested(() => finish(false))
		if (token.isCancellationRequested) finish(false)
	})
}

const assertToolAvailable = (options, toolName) => {
	if (!options.tools?.some((tool) => tool.name === toolName)) {
		throw new Error(`Alpha did not expose required tool '${toolName}' to the VS Code LM provider`)
	}
}

const provider = {
	provideLanguageModelChatInformation() {
		return [MODEL]
	},

	async provideLanguageModelChatResponse(_model, messages, options, progress, token) {
		const requestIndex = requests.length
		const request = {
			index: requestIndex,
			scenario,
			cancelled: token.isCancellationRequested,
			messages: messages.map((message) => ({
				role: message.role,
				parts: message.content.map(summarizePart),
			})),
			tools: options.tools?.map((tool) => tool.name) ?? [],
		}
		requests.push(request)
		recordEvent("provider-request-registered", requestIndex, token)
		const cancellationDisposable = token.onCancellationRequested(() => {
			request.cancelled = true
			recordEvent("provider-token-cancelled", requestIndex, token)
		})

		try {
			if (scenario === "cancellation") {
				heldRequestIndexes.add(requestIndex)
				recordEvent("provider-wait-started", requestIndex, token)
				const released = await waitForRelease(requestIndex, token)
				recordEvent(released ? "provider-wait-released" : "provider-wait-cancelled", requestIndex, token)
				return
			}
			if (scenario === "error-recovery" && requestIndex === 0) {
				throw new Error("Deterministic VS Code LM transport failure")
			}
			if (!(await waitForRelease(requestIndex, token))) return

			if (scenario === "tool-followup" && requestIndex === 0) {
				assertToolAvailable(options, "list_files")
				progress.report(
					new vscode.LanguageModelToolCallPart("alpha-e2e-list-files-1", "list_files", {
						path: ".",
						recursive: false,
					}),
				)
				return
			}

			assertToolAvailable(options, "attempt_completion")
			const result =
				scenario === "tool-followup" && requestIndex >= 2
					? "The same-task follow-up completed through VS Code LM."
					: "The VS Code LM contract turn completed."
			progress.report(
				new vscode.LanguageModelToolCallPart(`alpha-e2e-completion-${requestIndex}`, "attempt_completion", {
					result,
				}),
			)
		} finally {
			recordEvent("provider-request-returned", requestIndex, token)
			cancellationDisposable.dispose()
		}
	},

	async provideTokenCount(_model, value) {
		return Math.max(1, Math.ceil(JSON.stringify(value).length / 4))
	},
}

const control = {
	reset(nextScenario, options = {}) {
		for (const release of releaseRequests.values()) release()
		scenario = nextScenario
		requests = []
		heldRequestIndexes = new Set(options.holdRequestIndexes ?? [])
		releaseRequests = new Map()
		events = []
		scenarioStartedAt = Date.now()
	},
	getRequests() {
		return requests.map((request) => ({
			...request,
			messages: request.messages.map((message) => ({
				...message,
				parts: message.parts.map((part) => ({ ...part })),
			})),
			tools: [...request.tools],
		}))
	},
	getEvents() {
		return events.map((event) => ({ ...event }))
	},
	releaseRequest(requestIndex) {
		heldRequestIndexes.delete(requestIndex)
		releaseRequests.get(requestIndex)?.()
	},
	releaseAll() {
		for (const requestIndex of [...heldRequestIndexes]) this.releaseRequest(requestIndex)
	},
}

function activate(context) {
	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider("alpha-e2e", provider))
	return control
}

function deactivate() {
	control.releaseAll()
}

module.exports = { activate, deactivate }
