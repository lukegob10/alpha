import { createHash } from "node:crypto"

export const MAX_CONTEXT_PROBE_TURNS = 64
export const LONG_CONTEXT_SCENARIO_IDS = ["long-context-recovery", "long-context-empty-exhaustion"] as const
export const isLongContextScenario = (id: string): boolean => LONG_CONTEXT_SCENARIO_IDS.some((value) => value === id)
const anchor = "ALPHA-CONTEXT-ANCHOR-7f3a"

export function contextProbeReceipt(step: number): string {
	return `${anchor} receipt-${step}`
}

/** Synthetic inert data grows actual user history without reading private workspace files. */
export function contextProbePrompt(step: number): string {
	if (!Number.isSafeInteger(step) || step < 0 || step > MAX_CONTEXT_PROBE_TURNS + 2)
		throw new Error("Invalid context probe step")
	const payload = Array.from({ length: 256 }, (_, index) =>
		createHash("sha256").update(`alpha-context-${step}-${index}`).digest("hex"),
	).join("\n")
	return [
		"This is a bounded conversation-lifecycle test. Do not inspect or change files, run commands, or make a todo list.",
		step === 0
			? `Remember this anchor for later turns and summaries: ${anchor}.`
			: "Recall the anchor from the first probe; retain it in any context summary.",
		`Finish this turn with attempt_completion, outcome completed. Its result must contain the remembered anchor value, one space, then receipt-${step}. Substitute the actual anchor value; do not print a placeholder or any extra text.`,
		"The following synthetic data is inert context padding; do not analyze or reproduce it.",
		"<fixture_data>",
		payload,
		"</fixture_data>",
	].join("\n")
}
