const MAX_PROMPT_ENHANCEMENTS_PER_PROVIDER = 8
const LEGACY_REQUEST_KEY = Symbol("legacy-prompt-enhancement")

interface OwnedEnhancement {
	controller: AbortController
	taskId?: string
}

const requestsByProvider = new WeakMap<object, Map<string | symbol, OwnedEnhancement>>()

export function beginPromptEnhancement(provider: object, requestId?: string, taskId?: string) {
	let requests = requestsByProvider.get(provider)
	if (!requests) {
		requests = new Map()
		requestsByProvider.set(provider, requests)
	}
	const key = requestId ?? LEGACY_REQUEST_KEY
	const previous = requests.get(key)
	if (!previous && requests.size >= MAX_PROMPT_ENHANCEMENTS_PER_PROVIDER) {
		throw new Error("Too many concurrent prompt enhancements")
	}
	previous?.controller.abort()
	const owned: OwnedEnhancement = { controller: new AbortController(), taskId }
	requests.set(key, owned)
	return {
		signal: owned.controller.signal,
		isOwned: () => requests.get(key) === owned,
		finish: () => {
			if (requests.get(key) === owned) requests.delete(key)
		},
	}
}

export function cancelPromptEnhancement(provider: object, requestId: string, taskId?: string): void {
	const owned = requestsByProvider.get(provider)?.get(requestId)
	if (owned && (taskId === undefined || owned.taskId === undefined || taskId === owned.taskId)) {
		owned.controller.abort()
	}
}

/** Fire cancellation before joining accepted webview operations or native task termination. */
export function cancelPromptEnhancements(provider: object, taskId?: string): void {
	for (const owned of requestsByProvider.get(provider)?.values() ?? []) {
		if (taskId === undefined || owned.taskId === undefined || taskId === owned.taskId) {
			owned.controller.abort()
		}
	}
}
