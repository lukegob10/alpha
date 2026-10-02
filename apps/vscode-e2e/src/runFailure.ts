export const TEST_RUN_FAILURE_CODES = [
	"host-cancelled",
	"setup-incomplete",
	"setup-timeout",
	"invalid-options",
	"profile-invalid",
	"profile-busy",
	"host-failed",
	"host-preflight-missing",
	"host-completion-missing",
	"host-completion-invalid",
	"host-startup-timeout",
	"host-close-timeout",
	"host-version-mismatch",
	"host-not-owned",
	"model-unavailable",
	"model-selection-ambiguous",
	"effort-unsupported",
	"effort-unavailable",
	"authentication-required",
	"provider-unavailable",
	"request-budget-unsupported",
	"evidence-failed",
	"authentication-unknown",
	"no-tests-executed",
	"tests-skipped",
	"invalid-test-counts",
	"evidence-retention-failed",
] as const

export type TestRunFailureCode = (typeof TEST_RUN_FAILURE_CODES)[number]

const CONFIGURATION_GUIDANCE = {
	"profile-paths-required":
		"Provide --profile-dir, --workspace, and --artifacts-dir together as separate absolute test paths; or omit all three for a disposable run. Add --init-profile only when initializing empty test roots.",
	"profile-initialization-needs-profile":
		"--init-profile requires --profile-dir, --workspace, and --artifacts-dir. Omit --init-profile for the default disposable test profile.",
	"exact-profile-host-required":
		"Persistent test profiles require an exact --vscode-version such as 1.125.0, not stable or insiders.",
} as const

export type TestRunDiagnostic = keyof typeof CONFIGURATION_GUIDANCE

export class TestRunError extends Error {
	constructor(
		readonly code: TestRunFailureCode,
		message: string,
		readonly diagnostic?: TestRunDiagnostic,
	) {
		super(message)
		this.name = "TestRunError"
	}
}

const FAILURE_GUIDANCE: Record<TestRunFailureCode, string> = {
	"host-completion-missing":
		"The development host closed without a matching terminal receipt. Inspect retained evidence; an early manual close is not a passing run.",
	"host-completion-invalid":
		"The development host receipt did not match this launch. Preserve the profile and evidence; do not resume from stale completion data.",
	"host-startup-timeout":
		"The live test sidecar did not start within its deadline. Inspect the dedicated window and retained lease before another launch.",
	"host-close-timeout":
		"The dedicated window did not close after completion. Close that window normally and verify ownership before releasing its retained lease.",
	"setup-incomplete":
		"Interactive setup has not been finished. Use Copilot test setup in the dedicated window's status bar to Continue / Retry, then Finish after a successful check. Dismissing setup controls leaves the window open.",
	"setup-timeout":
		"The explicitly configured setup deadline expired. Rerun --setup without --setup-timeout-ms for an interactive window that waits for Finish or Cancel.",
	"evidence-retention-failed":
		"Evidence retention could not establish a complete within-budget result. Preserve protected/raw sources, inspect the durable retention report, and stop further campaign admission until storage state is known.",
	"no-tests-executed":
		"The selected Mocha suite executed no non-pending tests. Check --file and --grep and any suite skip conditions; a zero-match or fully skipped run is not a passing test gate.",
	"tests-skipped":
		"A required suite skipped selected tests. Inspect its pending test count and skip conditions; every selected hard-gate test must execute and pass.",
	"invalid-test-counts":
		"The host did not report coherent test execution counts. Preserve the run receipts and inspect the selected runner; an incomplete count cannot establish acceptance.",
	"invalid-options":
		"Check option names and values in docs/vscode-live-test-profiles.md. Use --provider scripted for a disposable deterministic run, or provide all three dedicated paths for a persistent run.",
	"profile-invalid":
		"Use separate absolute profile, workspace, and artifact paths outside the checkout and normal VS Code data. Initialize only empty profile/workspace roots with --init-profile; existing roots need valid ownership markers.",
	"profile-busy":
		"Close the dedicated test profile's windows and inspect its launch lease offline. Do not delete an unknown lease or terminate unrelated VS Code processes.",
	"host-cancelled":
		"The owned host launch was cancelled. Inspect its exit receipt and retained lease before restarting; cancellation does not prove every storage writer stopped.",
	"host-failed":
		"Inspect this run's host preflight, host logs, and scenario result. Rerun the same bounded scenario after identifying the failing operation.",
	"host-preflight-missing":
		"The host did not produce a valid matching preflight. Check the extension build, test entry point, and selected executable; do not treat this as a passing test or offline-repair proof.",
	"host-version-mismatch":
		"Use an executable matching --vscode-version exactly, or omit --vscode-executable to resolve the requested host. An executable override does not bypass the version gate.",
	"host-not-owned":
		"Close existing windows using this dedicated test profile, then retry. The extension host must descend from this runner; do not reuse the normal editor profile.",
	"model-unavailable":
		"Run --provider live-copilot --setup in the dedicated profile, inspect live-copilot-preflight.json, and choose an exact discovered --model-id and optional --model-family.",
	"model-selection-ambiguous":
		"Inspect the discovered Copilot identities and supply an exact --model-id and --model-family. If duplicates remain, resolve provider registration; no fallback model is selected.",
	"effort-unsupported":
		"Choose an explicitly supported --reasoning-effort or omit the effort override. The runner will not substitute a lower effort automatically.",
	"effort-unavailable":
		"Inspect live-copilot-preflight.json for Alpha's model capability result. Choose an explicitly supported effort; unknown support is not assumed to work.",
	"authentication-required":
		"Run --setup in this version's dedicated profile, sign in through Accounts, and click Continue setup. Alpha's own Copilot access must be granted; credentials are not copied from the normal profile.",
	"authentication-unknown":
		"Alpha's own Copilot access could not be verified. Complete interactive --setup and inspect the preflight; a sidecar consent probe alone does not establish Alpha access.",
	"provider-unavailable":
		"Check Copilot installation, account access, and model availability in the dedicated host. Inspect the safe live preflight before retrying; do not substitute another provider silently.",
	"request-budget-unsupported":
		"Use --request-limit with a guarded --scenario-id workflow. Arbitrary live suites and setup probes do not implement that request budget.",
	"evidence-failed":
		"Keep the retained source directories. Inspect the evidence manifest and artifact directory permissions/limits; do not repair or prune from incomplete evidence.",
}

export type TestExecutionCounts = {
	total: number
	passed: number
	pending: number
	executed: number
	failed: number
}

/** Validate receipts at the runner boundary; hook failures may outnumber ended tests. */
export function isTestExecutionCounts(value: unknown): value is TestExecutionCounts {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const counts = value as Record<string, unknown>
	if (
		!["total", "passed", "pending", "executed", "failed"].every(
			(key) => typeof counts[key] === "number" && Number.isSafeInteger(counts[key]) && counts[key] >= 0,
		)
	)
		return false
	return (
		counts.total === Number(counts.pending) + Number(counts.executed) &&
		Number(counts.passed) <= Number(counts.executed) &&
		(counts.failed !== 0 || counts.passed === counts.executed)
	)
}

/** Mocha's test-end count includes pending tests; zero failures alone is not an executed-test receipt. */
export function testSuiteOutcome(
	failures: number,
	stats?: { tests: number; passes: number; pending: number },
	options: { requireAllTests?: boolean } = {},
) {
	const counts: TestExecutionCounts = {
		total: stats?.tests ?? 0,
		passed: stats?.passes ?? 0,
		pending: stats?.pending ?? 0,
		executed: Math.max(0, (stats?.tests ?? 0) - (stats?.pending ?? 0)),
		failed: failures,
	}
	const coherent = isTestExecutionCounts(counts)
	const failure: TestRunFailureCode | undefined =
		failures > 0
			? "host-failed"
			: !coherent
				? "invalid-test-counts"
				: counts.executed === 0
					? "no-tests-executed"
					: options.requireAllTests && counts.pending > 0
						? "tests-skipped"
						: undefined
	return { counts, failure }
}

/** User-facing advice is allowlisted; Error.message and caller-supplied guidance are never serialized. */
export function describeTestRunFailure(value: unknown, fallback: TestRunFailureCode = "invalid-options") {
	const failure = testRunFailureCode(value, fallback)
	const diagnostic =
		value instanceof TestRunError &&
		value.diagnostic &&
		Object.prototype.hasOwnProperty.call(CONFIGURATION_GUIDANCE, value.diagnostic)
			? value.diagnostic
			: undefined
	return {
		failure,
		...(diagnostic ? { diagnostic } : {}),
		guidance: diagnostic ? CONFIGURATION_GUIDANCE[diagnostic] : FAILURE_GUIDANCE[failure],
		documentation: "docs/vscode-live-test-profiles.md",
	}
}

/** Classification is closed; arbitrary host/provider text must never be emitted in runner summaries. */
export function testRunFailureCode(value: unknown, fallback: TestRunFailureCode): TestRunFailureCode {
	if (
		value &&
		typeof value === "object" &&
		"code" in value &&
		typeof value.code === "string" &&
		TEST_RUN_FAILURE_CODES.includes(value.code as TestRunFailureCode)
	) {
		return value.code as TestRunFailureCode
	}
	return fallback
}
