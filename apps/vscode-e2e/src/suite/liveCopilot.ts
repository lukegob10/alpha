import type { RooCodeAPI } from "@alpha-code/types"
import { TestRunError } from "../runFailure"

import {
	configureLiveCopilot,
	type LiveCopilotAuthDependencies,
	type LiveCopilotOptions,
	type LiveCopilotPreflightMetadata,
} from "../liveModelSelection"

function readSetupFlag(value: string | undefined): boolean {
	return value === "1" || value === "true"
}

export function getLiveCopilotOptionsFromEnvironment(
	env: NodeJS.ProcessEnv = process.env,
	artifactsDir?: string,
): LiveCopilotOptions | undefined {
	const modelId = env.ALPHA_E2E_MODEL_ID
	if (modelId === undefined) return undefined

	return {
		modelId,
		...(env.ALPHA_E2E_MODEL_FAMILY !== undefined ? { modelFamily: env.ALPHA_E2E_MODEL_FAMILY } : {}),
		...(env.ALPHA_E2E_REASONING_EFFORT !== undefined ? { reasoningEffort: env.ALPHA_E2E_REASONING_EFFORT } : {}),
		setup: readSetupFlag(env.ALPHA_E2E_SETUP),
		...(artifactsDir !== undefined ? { artifactsDir } : {}),
	}
}

export async function runLiveCopilotPreflight(
	api: RooCodeAPI,
	options: LiveCopilotOptions,
	dependencies?: LiveCopilotAuthDependencies,
): Promise<LiveCopilotPreflightMetadata> {
	return configureLiveCopilot(api, options, dependencies)
}

export type LiveSetupAction = "continue" | "finish" | "cancel" | undefined
export type LiveSetupState<T> = { phase: "waiting" | "checking" | "ready"; check?: T }
export type LiveSetupResult<T> = { status: "finished"; check: T } | { status: "cancelled" | "timed-out" }

export function validateLiveSetupTimeout(timeoutMs: number | undefined, setup: boolean): void {
	if (
		timeoutMs !== undefined &&
		(!setup || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000)
	) {
		throw new TestRunError("invalid-options", "Setup timeout requires --setup and 1–86400000 milliseconds")
	}
}

/** Setup is user-driven: no polling, implicit deadline, automatic request, or completion on UI dismissal. */
export async function runPersistentLiveSetup<T extends { ready: boolean }>(
	check: (signal: AbortSignal) => Promise<T>,
	controls: {
		onAction: (dispatch: (action: LiveSetupAction) => void) => { dispose(): void }
		render: (state: LiveSetupState<T>) => void
		signal?: AbortSignal
		timeoutMs?: number
	},
): Promise<LiveSetupResult<T>> {
	validateLiveSetupTimeout(controls.timeoutMs, true)
	const cancellation = new AbortController()
	let state: LiveSetupState<T> = { phase: "waiting" }
	let settled = false
	let pending: Promise<void> | undefined
	let subscription: { dispose(): void } | undefined
	let timer: ReturnType<typeof setTimeout> | undefined
	let resolveResult!: (result: LiveSetupResult<T>) => void
	let rejectResult!: (error: unknown) => void
	const result = new Promise<LiveSetupResult<T>>((resolve, reject) => {
		resolveResult = resolve
		rejectResult = reject
	})
	const finish = (value: LiveSetupResult<T>) => {
		if (settled) return
		settled = true
		cancellation.abort()
		resolveResult(value)
	}
	const cancel = () => finish({ status: "cancelled" })
	const dispatch = (action: LiveSetupAction) => {
		if (settled || action === undefined) return
		if (action === "cancel") return cancel()
		if (action === "finish") {
			if (state.phase === "ready" && state.check) finish({ status: "finished", check: state.check })
			return
		}
		if (state.phase === "checking") return
		state = { phase: "checking" }
		// Start synchronously in the user gesture; this is the sole request-admission path.
		pending = (async () => {
			try {
				controls.render(state)
				const value = await check(cancellation.signal)
				if (!settled) {
					state = { phase: value.ready ? "ready" : "waiting", check: value }
					controls.render(state)
				}
			} catch (error) {
				if (!settled) {
					settled = true
					cancellation.abort()
					rejectResult(error)
				}
			}
		})()
	}
	try {
		controls.signal?.addEventListener("abort", cancel, { once: true })
		if (controls.signal?.aborted) cancel()
		if (!settled) {
			controls.render(state)
			subscription = controls.onAction(dispatch)
			if (controls.timeoutMs !== undefined)
				timer = setTimeout(() => finish({ status: "timed-out" }), controls.timeoutMs)
		}
		return await result
	} finally {
		settled = true
		cancellation.abort()
		if (timer !== undefined) clearTimeout(timer)
		controls.signal?.removeEventListener("abort", cancel)
		subscription?.dispose()
		// Drain bounded checks before terminal artifacts/capture; never permit late writes after Finish/Cancel.
		await pending
	}
}
