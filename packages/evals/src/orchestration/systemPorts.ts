import type { HarnessClock, HarnessRandomSource, HarnessSleeper } from "./ports"

export const systemClock: HarnessClock = {
	now: () => new Date(),
	monotonicMs: () => performance.now(),
}

export const systemRandom: HarnessRandomSource = { next: () => Math.random() }
export const systemSleeper: HarnessSleeper = { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }
