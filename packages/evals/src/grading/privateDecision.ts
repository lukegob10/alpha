import { z } from "zod"

const decisionSchema = z
	.object({
		schemaVersion: z.literal(1),
		passed: z.boolean(),
		decisionCode: z.string().regex(/^[a-z][a-z0-9-]{0,95}$/),
		evidenceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
		diagnostic: z.string().max(256),
	})
	.strict()

/** A hidden grader must return one bounded decision, with a matching process outcome. */
export function inspectPrivateDecision(stdout: string, exitCode: number): "passed" | "failed" | "error" {
	if (Buffer.byteLength(stdout, "utf8") > 2048) throw new Error("Invalid private grader decision")
	const line = stdout.replace(/\r?\n$/, "")
	try {
		const parsed: unknown = JSON.parse(line)
		if (JSON.stringify(parsed) !== line) throw new Error("Noncanonical decision")
		const decision = decisionSchema.parse(parsed)
		if (decision.passed !== (decision.decisionCode === "passed")) throw new Error("Inconsistent decision")
		const infrastructure = decision.decisionCode.startsWith("infrastructure-")
		if (exitCode !== (decision.passed ? 0 : infrastructure ? 2 : 1)) throw new Error("Inconsistent exit code")
		return decision.passed ? "passed" : infrastructure ? "error" : "failed"
	} catch {
		throw new Error("Invalid private grader decision")
	}
}
