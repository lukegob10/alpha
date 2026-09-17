import { isRetryableStatus, type TrialTerminalStatus } from "../lifecycle/index"
import type { HarnessClock, HarnessRandomSource, HarnessSleeper } from "./ports"

export type RetryPolicy = {
	maxAttempts: number
	baseDelayMs: number
	maxDelayMs: number
}

export type RetryAttemptResult = {
	attemptNumber: number
	status: TrialTerminalStatus
	startedAt: string
	finishedAt: string
	delayBeforeMs: number
}

export type RetryPolicyResult = {
	status: TrialTerminalStatus
	attempts: RetryAttemptResult[]
	exhausted: boolean
}

export async function executeRetryPolicy(
	policy: RetryPolicy,
	ports: { clock: HarnessClock; random: HarnessRandomSource; sleeper: HarnessSleeper },
	execute: (attemptNumber: number) => Promise<TrialTerminalStatus>,
	onExhausted: () => Promise<void>,
): Promise<RetryPolicyResult> {
	if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
		throw new Error("maxAttempts must be a positive integer")
	}

	const attempts: RetryAttemptResult[] = []
	for (let attemptNumber = 1; attemptNumber <= policy.maxAttempts; attemptNumber++) {
		const delayBeforeMs = attemptNumber === 1 ? 0 : calculateBackoffMs(attemptNumber, policy, ports.random)
		if (delayBeforeMs > 0) await ports.sleeper.sleep(delayBeforeMs)
		const startedAt = ports.clock.now().toISOString()
		const status = await execute(attemptNumber)
		const finishedAt = ports.clock.now().toISOString()
		attempts.push({ attemptNumber, status, startedAt, finishedAt, delayBeforeMs })

		if (!isRetryableStatus(status)) return { status, attempts, exhausted: false }
	}

	await onExhausted()
	return { status: attempts.at(-1)!.status, attempts, exhausted: true }
}

export function calculateBackoffMs(attemptNumber: number, policy: RetryPolicy, random: HarnessRandomSource): number {
	if (attemptNumber <= 1) return 0
	const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attemptNumber - 2))
	return Math.round(exponential * (0.5 + clampUnit(random.next())))
}

function clampUnit(value: number): number {
	return Math.min(1, Math.max(0, value))
}
