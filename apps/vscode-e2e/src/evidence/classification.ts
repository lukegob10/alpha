import type { EvidenceFailure, EvidenceOutcome, EvidenceSummary } from "./types"

const PERSISTENCE_CODES = new Set(["ELOCKOWNER", "ELOCKLEGACY", "ELOCKED", "EQUEUEFULL", "ENOSPC", "EROFS"])
const PROVIDER_CODES = new Set(["AUTH_REQUIRED", "MODEL_UNAVAILABLE", "RATE_LIMITED", "QUOTA_EXHAUSTED"])
const CODES = new Set([
	...PERSISTENCE_CODES,
	...PROVIDER_CODES,
	"EACCES",
	"EPERM",
	"EBUSY",
	"ENOENT",
	"EIO",
	"ETIMEDOUT",
	"ABORT_ERR",
	"ERR_ASSERTION",
	"HOST_EXIT",
	"TOOL_ERROR",
	"MISSING_TERMINAL_RECEIPT",
	"UNKNOWN",
])

/** Do not let an arbitrary Error.message or provider payload become a user-facing summary. */
export function classifyFailure(outcome: EvidenceOutcome, failure?: EvidenceFailure): EvidenceSummary {
	if (outcome === "passed") return { category: "none", code: "OK" }
	const code = failure?.code && CODES.has(failure.code) ? failure.code : "UNKNOWN"
	if (PERSISTENCE_CODES.has(code)) return { category: "persistence", code }
	if (PROVIDER_CODES.has(code)) return { category: "provider", code }
	if (code === "ERR_ASSERTION") return { category: "assertion", code }
	const categories = ["provider", "tool", "persistence", "lifecycle", "assertion", "host"] as const
	const category = categories.find((candidate) => candidate === failure?.phase) ?? "unknown"
	return { category, code }
}

export function knownFailureCode(value: unknown): string | undefined {
	return typeof value === "string" && CODES.has(value) ? value : undefined
}
