import { createHash } from "node:crypto"
import { outcomeScenarioIds } from "../host-evidence.mjs"

export function hostReceipt(testFile = "core-loop.test") {
	return {
		schemaVersion: 1,
		kind: "alpha-extension-test-run",
		runId: `host-${testFile.replaceAll(".", "-")}`,
		startedAt: "2026-10-02T10:00:01.000Z",
		completedAt: "2026-10-02T10:00:02.000Z",
		testFile,
		scenarioId: null,
		scenarioPhase: null,
		requestedHostVersion: "1.125.0",
		actualHostVersion: "1.125.0",
		providerMode: testFile === "vscode-lm-contract.test" ? "vscode-lm-fixture" : "scripted",
		profile: { kind: "persistent", sha256: "a".repeat(64) },
		status: "passed",
		exitCode: 0,
		execution: "extension-host",
		hostExitObserved: true,
		ownershipGate: "verified",
		requireAllTests: true,
		testCounts: { total: 1, passed: 1, pending: 0, executed: 1, failed: 0 },
		captureComplete: true,
		retentionStatus: "complete",
		failure: null,
	}
}

export function outcomeFixture(id = "campaign-test") {
	const prefix = createHash("sha256").update(id).digest("hex")
	const receipts = outcomeScenarioIds.map((scenarioId, index) => ({
		...hostReceipt("workflow.test"),
		scenarioId,
		scenarioPhase: "run",
		runId: `${prefix}-attempt-000${index + 1}-run`,
	}))
	const campaign = {
		version: 1,
		id,
		mode: "report-only",
		requestedProvider: { mode: "scripted" },
		startedAt: "2026-10-02T10:00:00.000Z",
		finishedAt: "2026-10-02T10:00:03.000Z",
		stopReason: "completed",
		retention: { status: "complete" },
		evaluationIdentity: {
			extensionCommit: "a".repeat(40),
			workingTreeDigest: "a".repeat(64),
			extensionBuildDigest: "a".repeat(64),
			harnessDigest: "a".repeat(64),
			configDigest: "a".repeat(64),
			taskSetDigest: "a".repeat(64),
			sourceComponentsDigest: "a".repeat(64),
			unchanged: true,
			missing: [],
		},
		evaluationPlan: { scenarioIds: [...outcomeScenarioIds], hostVersions: ["1.125.0"], samples: 1 },
		counts: { passed: 3, failed: 0, blocked: 0 },
		attempts: outcomeScenarioIds.map((scenarioId, index) => ({
			request: {
				campaignId: id,
				attemptId: `attempt-000${index + 1}`,
				scenarioId,
				phase: "sample",
				sample: 1,
				host: { version: "1.125.0" },
				provider: { mode: "scripted" },
			},
			result: { status: "passed", actualHostVersion: "1.125.0", taskIds: [`task-${index + 1}`] },
			evidence: `attempt-000${index + 1}/evidence-index.json`,
		})),
	}
	return { campaign, receipts }
}
