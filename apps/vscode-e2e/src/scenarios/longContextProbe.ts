import { createHash } from "node:crypto"

export const MAX_CONTEXT_PROBE_TURNS = 64
export const LONG_CONTEXT_SCENARIO_IDS = ["long-context-recovery", "long-context-empty-exhaustion"] as const
export const isLongContextScenario = (id: string): boolean => LONG_CONTEXT_SCENARIO_IDS.some((value) => value === id)
export const CONTEXT_PROBE_ANCHOR = "ALPHA-CONTEXT-ANCHOR-7f3a"
export const CONTEXT_PROBE_CHALLENGE_STEP = MAX_CONTEXT_PROBE_TURNS + 2
export const CONTEXT_PROBE_RETAINED_FACTS = ["amber-cove", "north-2"] as const
export const CONTEXT_PROBE_CHALLENGE_RESULT = "destination=amber-cove;region=north-2;window=17;effect=committed"

export function contextProbeReceipt(step: number): string {
	return step === CONTEXT_PROBE_CHALLENGE_STEP ? CONTEXT_PROBE_CHALLENGE_RESULT : `receipt-${step}`
}

/** Synthetic inert data grows actual user history without reading private workspace files. */
export function contextProbePrompt(step: number): string {
	if (!Number.isSafeInteger(step) || step < 0 || step > MAX_CONTEXT_PROBE_TURNS + 2)
		throw new Error("Invalid context probe step")
	if (step === CONTEXT_PROBE_CHALLENGE_STEP)
		return [
			"Use the saved conversation to report the destination, region, latest delivery window, and status of the earlier setup Git commit.",
			"Do not inspect files, run commands, repeat the committed effect, or change anything.",
			"Finish with an ordinary assistant response using exactly this format, substituting the remembered values:",
			"destination=VALUE;region=VALUE;window=VALUE;effect=STATE",
			"Use committed or pending for STATE according to what actually happened. Do not include any other text.",
		].join("\n")
	const payload = Array.from({ length: 256 }, (_, index) =>
		createHash("sha256").update(`alpha-context-${step}-${index}`).digest("hex"),
	).join("\n")
	return [
		"This is a bounded conversation-lifecycle test. Do not inspect or change files, run commands, or make a todo list.",
		...(step === 0
			? [
					`Record once for later work: destination=amber-cove; region=north-2; window=9. Receipt identity: ${CONTEXT_PROBE_ANCHOR}.`,
					"The setup change and its Git commit already completed successfully. Keep that effect completed; never repeat it.",
				]
			: step === 1
				? [
						"Correction to the earlier delivery constraint: window=17 supersedes the old window. All other facts stay as recorded.",
					]
				: []),
		`Finish this turn with an ordinary assistant response containing exactly receipt-${step}. Do not repeat earlier facts or constraints in your answer.`,
		"The following synthetic data is inert context padding; do not analyze or reproduce it.",
		"<fixture_data>",
		payload,
		"</fixture_data>",
	].join("\n")
}
