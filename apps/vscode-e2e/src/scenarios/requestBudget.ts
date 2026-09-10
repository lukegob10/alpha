import { WorkflowFailure, type WorkflowResult } from "./contracts"
import type { LiveResponseProbe } from "./liveResponseProbe"

export class WorkflowRequestBudget {
	used = 0
	exhausted = false
	failure?: WorkflowFailure
	model: WorkflowResult["model"] = {}
	/** Opt-in test fault at the real response boundary; ordinary guards preserve response identity. */
	transformResponse?: (response: unknown) => unknown
	responseProbe?: LiveResponseProbe

	constructor(
		readonly limit: number,
		private readonly expectedModelId?: string,
	) {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
			throw new WorkflowFailure("configuration", "invalid_request_limit", true)
		}
	}

	consume(): void {
		if (this.used >= this.limit) {
			this.exhausted = true
			throw new WorkflowFailure("provider", "request_limit_reached", true)
		}
		this.used++
	}

	observeModel(client: Record<string, unknown>): void {
		if (typeof client.id !== "string" || (this.expectedModelId && client.id !== this.expectedModelId)) {
			this.failure = new WorkflowFailure("configuration", "actual_model_mismatch", true)
			throw this.failure
		}
		this.model = {
			id: client.id,
			family: typeof client.family === "string" ? client.family : undefined,
			vendor: typeof client.vendor === "string" ? client.vendor : undefined,
		}
	}
}

/** Test-only predispatch fence. It never mutates the shared VS Code client or counts a turn as a request. */
export function guardVsCodeLmHandler(handler: unknown, budget: WorkflowRequestBudget): () => void {
	if (
		!handler ||
		typeof handler !== "object" ||
		!("getClient" in handler) ||
		typeof handler.getClient !== "function"
	) {
		throw new WorkflowFailure("configuration", "request_guard_unsupported_handler", true)
	}
	const target = handler as { getClient: (...args: unknown[]) => Promise<unknown> }
	const descriptor = Object.getOwnPropertyDescriptor(target, "getClient")
	const getClient = target.getClient
	const proxies = new WeakMap<object, object>()
	const guarded = async (...args: unknown[]) => {
		const client = await getClient.apply(target, args)
		if (
			!client ||
			typeof client !== "object" ||
			!("sendRequest" in client) ||
			typeof client.sendRequest !== "function"
		) {
			throw new WorkflowFailure("configuration", "request_guard_unsupported_client", true)
		}
		budget.observeModel(client as Record<string, unknown>)
		let proxy = proxies.get(client)
		if (!proxy) {
			// VS Code freezes model objects. Proxy invariants prohibit replacing their own fixed methods,
			// so intercept reads on a separate facade while retaining the real receiver for host APIs.
			const facade: object = Object.create(client)
			proxy = new Proxy(facade, {
				get(_facade, key) {
					const value: unknown = Reflect.get(client, key, client)
					if (key === "sendRequest") {
						return (...requestArgs: unknown[]) => {
							budget.consume()
							const request = budget.used
							const probe = budget.responseProbe
							const transform = budget.transformResponse
							const response: unknown = Reflect.apply(
								value as (...args: unknown[]) => unknown,
								client,
								requestArgs,
							)
							if (!probe && !transform) return response
							return Promise.resolve(response).then((value) => {
								const options = requestArgs[1] as { tools?: unknown[] } | undefined
								const observed = probe?.wrap(value, request, options?.tools?.length ?? 0) ?? value
								return transform ? transform(observed) : observed
							})
						}
					}
					return typeof value === "function" ? value.bind(client) : value
				},
			})
			proxies.set(client, proxy)
		}
		return proxy
	}
	Object.defineProperty(target, "getClient", { configurable: true, writable: true, value: guarded })
	return () => {
		if (target.getClient !== guarded) return
		if (descriptor) Object.defineProperty(target, "getClient", descriptor)
		else Reflect.deleteProperty(target, "getClient")
	}
}

/** Install from ClineProvider's synchronous taskCreated event, before Task.start/resume. */
export function guardTaskApi(task: { api: unknown }, budget: WorkflowRequestBudget): () => void {
	const descriptor = Object.getOwnPropertyDescriptor(task, "api")
	if (!descriptor || !descriptor.configurable || !("value" in descriptor)) {
		throw new WorkflowFailure("configuration", "request_guard_unsupported_task", true)
	}
	let api = task.api
	let release = guardVsCodeLmHandler(api, budget)
	const get = () => api
	Object.defineProperty(task, "api", {
		configurable: true,
		enumerable: descriptor.enumerable,
		get,
		set(value: unknown) {
			if (value === api) return
			const nextRelease = guardVsCodeLmHandler(value, budget)
			release()
			api = value
			release = nextRelease
		},
	})
	return () => {
		release()
		if (Object.getOwnPropertyDescriptor(task, "api")?.get === get) {
			Object.defineProperty(task, "api", { ...descriptor, value: api })
		}
	}
}
