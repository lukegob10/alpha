import { createHash } from "node:crypto"
import { require as tsRequire } from "tsx/cjs/api"
import { outcomeFixture } from "./evidence.mjs"

const { joinProjectedEvidence } = tsRequire(
	"../../../apps/vscode-e2e/src/evidence/journalProjection.ts",
	import.meta.url,
)
const { DEVELOPMENT_SCENARIOS } = tsRequire(
	"../../../apps/vscode-e2e/src/scenarios/developmentCatalog.ts",
	import.meta.url,
)
const { DEVELOPMENT_PHASE_OUTCOME_CHECK_NAMES } = tsRequire(
	"../../../apps/vscode-e2e/src/scenarios/developmentFixture.ts",
	import.meta.url,
)
const { REPOSITORY_VERIFICATION_CHECK_NAMES } = tsRequire(
	"../../../apps/vscode-e2e/src/scenarios/repositoryFixture.ts",
	import.meta.url,
)
const independentChecks = (scenarioId) =>
	scenarioId === "review-edit-test-commit-followup"
		? Object.entries(REPOSITORY_VERIFICATION_CHECK_NAMES).flatMap(([phase, names]) =>
				names.map((name) => `${phase}_${name}`),
			)
		: DEVELOPMENT_SCENARIOS[scenarioId].phases.flatMap((phase) =>
				DEVELOPMENT_PHASE_OUTCOME_CHECK_NAMES[phase].map((name) => `${phase}_${name}`),
			)
const sha = (value) => createHash("sha256").update(value).digest("hex")
export const outcomeBuild = {
	bundleSha256: "a".repeat(64),
	extensionBuildDigest: "a".repeat(64),
	harnessDigest: "a".repeat(64),
}
export function proofFixture(id = "campaign-test") {
	const fixture = outcomeFixture(id)
	const proofs = fixture.campaign.attempts.map((attempt, index) => {
		const receipt = fixture.receipts[index]
		const taskId = attempt.result.taskIds[0]
		const event = {
			type: "turn_terminal",
			taskIdSha256: sha(taskId),
			runIdSha256: sha("run"),
			turnIdSha256: sha("turn"),
			stepIdSha256: sha("step"),
			sequence: 1,
			status: "completed",
		}
		const journal = {
			sourceBytes: 100,
			sourceSha256: sha("journal"),
			projection: {
				events: [event],
				captureStatus: "captured",
				validationStatus: "validated",
				complete: true,
				warnings: [],
			},
		}
		const repository = { files: [], complete: true, skipped: 1 }
		const values = {
			"repository-before.json": repository,
			"repository-after.json": repository,
			[`${taskId}-agent_lifecycle_events.jsonl.projection.json`]: journal,
			[`${taskId}-agent_turn_events.jsonl.projection.json`]: journal,
			[`${taskId}-api_conversation_history.json.projection.json`]: {
				sourceBytes: 100,
				sourceSha256: sha("conversation"),
				projection: [
					{ role: "assistant", tools: [{ type: "call", idSha256: sha("call") }] },
					{ role: "user", tools: [{ type: "result", idSha256: sha("call"), isError: false }] },
				],
			},
			[`${taskId}-evidence-join.json`]: JSON.parse(
				JSON.stringify({
					status: "captured",
					validation: { lifecycle: "validated", eventLog: "validated" },
					...joinProjectedEvidence({ lifecycle: [event], eventLog: [event] }),
				}),
			),
		}
		const artifacts = Object.entries(values).map(([path, original]) => {
			const value = JSON.parse(JSON.stringify(original))
			const bytes = Buffer.from(JSON.stringify(value, null, 2))
			return { path, value, bytes: bytes.length, sha256: sha(bytes) }
		})
		const value = {
			schemaVersion: 1,
			runId: receipt.runId,
			scenarioId: attempt.request.scenarioId,
			phase: "run",
			status: "passed",
			checks: [
				"tool_transactions_complete",
				"actual_tool_calls_present",
				"all_calls_have_receipts",
				"required_turns_completed",
				"no_unexpected_failed_turn",
				...independentChecks(attempt.request.scenarioId),
			].map((name) => ({ name, passed: true })),
			taskIds: [taskId],
			hostVersion: "1.125.0",
			providerMode: "scripted",
			model: {},
			requestsUsed: 1,
		}
		const workflowBytes = Buffer.from(JSON.stringify(value, null, 2) + "\n")
		return {
			schemaVersion: 1,
			kind: "alpha-scripted-outcome-proof",
			scenarioId: attempt.request.scenarioId,
			runId: receipt.runId,
			taskIds: [taskId],
			bundleSha256: outcomeBuild.bundleSha256,
			manifest: {
				kind: "alpha-vscode-e2e-run-evidence",
				version: 1,
				runId: receipt.runId,
				finalized: true,
				metadata: {
					scenarioId: attempt.request.scenarioId,
					requestedHostVersion: "1.125.0",
					hostVersion: "1.125.0",
					provider: "scripted",
					outcome: "passed",
					taskIds: [taskId],
					startedAt: receipt.startedAt,
					finishedAt: receipt.completedAt,
				},
				summary: { category: "none", code: "OK" },
				bundleSha256: outcomeBuild.bundleSha256,
				captureComplete: true,
				warnings: [],
				taskEvidence: [
					"agent_lifecycle_events.jsonl",
					"agent_turn_events.jsonl",
					"api_conversation_history.json",
				].map((file) => ({ taskId, file, status: "captured" })),
				artifacts: artifacts.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
			},
			workflow: { value, bytes: workflowBytes.length, sha256: sha(workflowBytes) },
			artifacts,
		}
	})
	return { ...fixture, proofs, build: outcomeBuild }
}
