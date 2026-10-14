import fs from "fs/promises"
import os from "os"
import path from "path"

import { agentLifecycleEventSchema, type AgentToolResultStatus } from "@alpha-code/types"
import { hashAgentTurnEvidenceId } from "../../agent/AgentTurnEventLog"
import { GlobalFileNames } from "../../../shared/globalFileNames"
import { collectDiagnosticsEvidence } from "../diagnosticsEvidence"

describe("diagnostic evidence from canonical tool transactions", () => {
	let directory: string
	const identity = { taskId: "private-task", runId: "private-run", turnId: "private-turn", stepId: "private-step" }
	const hash = hashAgentTurnEvidenceId

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-evidence-"))
	})
	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true })
	})

	it.each<AgentToolResultStatus>(["completed", "success", "failed", "error", "denied", "cancelled", "indeterminate"])(
		"retains effect boundaries, nested %s results, and real joins without exporting private content",
		async (status) => {
			const events = [
				{ type: "turn_started", payload: { phase: "working", effectTrackingVersion: 1 } },
				{
					type: "tool_call_accepted",
					payload: {
						item: {
							itemId: "call-item",
							type: "tool_call",
							toolCallId: "private-call",
							name: "apply_patch",
							arguments: "PRIVATE ARGUMENTS",
						},
					},
				},
				{ type: "tool_effect_started", payload: { toolCallId: "private-call" } },
				{
					type: "tool_result_recorded",
					payload: {
						item: {
							itemId: "result-item",
							type: "tool_result",
							toolCallId: "private-call",
							status,
							output: "PRIVATE OUTPUT",
						},
					},
				},
			].map((event, index) =>
				agentLifecycleEventSchema.parse({
					...identity,
					version: 1,
					eventId: `private-event-${index}`,
					sequence: index + 1,
					occurredAt: index + 1,
					...event,
				}),
			)
			await fs.writeFile(
				path.join(directory, GlobalFileNames.agentLifecycleEvents),
				events.map((event) => JSON.stringify(event)).join("\n") + "\n",
			)
			await fs.writeFile(
				path.join(directory, GlobalFileNames.agentTurnEvents),
				JSON.stringify({
					...identity,
					sequence: 1,
					timestamp: 4,
					event: {
						type: "tool_result",
						callId: "private-call",
						name: "apply_patch",
						status:
							status === "completed"
								? "success"
								: status === "failed" || status === "indeterminate"
									? "error"
									: status,
						output: "PRIVATE OUTPUT",
					},
				}) + "\n",
			)
			const collected = await collectDiagnosticsEvidence(directory, identity.taskId)
			expect(collected.evidence.sources.lifecycle).toMatchObject({
				status: "captured",
				projection: {
					validationStatus: "validated",
					events: [
						expect.objectContaining({ type: "turn_started" }),
						expect.objectContaining({
							type: "tool_call_accepted",
							toolCallIdSha256: hash("private-call"),
							toolName: "apply_patch",
						}),
						expect.objectContaining({
							type: "tool_effect_started",
							toolCallIdSha256: hash("private-call"),
						}),
						expect.objectContaining({
							type: "tool_result_recorded",
							toolCallIdSha256: hash("private-call"),
							status,
						}),
					],
				},
			})
			expect(collected.evidence.joins.records).toEqual([
				expect.objectContaining({ status: "joined", lifecycleSequences: [1, 2, 3, 4], eventLogSequences: [1] }),
			])
			const serialized = JSON.stringify(collected)
			expect(serialized).not.toContain("PRIVATE")
			expect(serialized).not.toContain("private-")
		},
	)

	it("retains approval identity and decision while excluding its private reason", async () => {
		await fs.writeFile(
			path.join(directory, GlobalFileNames.agentLifecycleEvents),
			JSON.stringify(
				agentLifecycleEventSchema.parse({
					...identity,
					version: 1,
					eventId: "approval-event",
					sequence: 1,
					occurredAt: 1,
					type: "approval_resolved",
					payload: {
						item: {
							itemId: "approval-item",
							type: "approval",
							approvalId: "private-approval",
							toolCallId: "private-call",
							status: "denied",
							reason: "PRIVATE REASON",
						},
					},
				}),
			) + "\n",
		)
		const collected = await collectDiagnosticsEvidence(directory, identity.taskId)
		expect(collected.evidence.sources.lifecycle.projection).toMatchObject({
			events: [
				expect.objectContaining({
					status: "denied",
					approvalIdSha256: hash("private-approval"),
					toolCallIdSha256: hash("private-call"),
					reasonPresent: true,
				}),
			],
		})
		expect(JSON.stringify(collected)).not.toContain("PRIVATE REASON")
	})

	it("keeps captured but invalid event sequences incomplete in the overall evidence status", async () => {
		await fs.writeFile(
			path.join(directory, GlobalFileNames.agentLifecycleEvents),
			JSON.stringify({
				...identity,
				version: 1,
				eventId: "gap-event",
				sequence: 2,
				occurredAt: 2,
				type: "turn_started",
				payload: { phase: "working" },
			}) + "\n",
		)
		const collected = await collectDiagnosticsEvidence(directory, identity.taskId)
		expect(collected.evidence.sources.lifecycle).toMatchObject({
			status: "captured",
			projection: { validationStatus: "incomplete" },
		})
		expect(collected.evidence.status).toBe("incomplete")
	})

	it("hashes unrecognized tool names and retains effect-tracking snapshot counts", async () => {
		await fs.writeFile(
			path.join(directory, GlobalFileNames.agentLifecycleEvents),
			JSON.stringify(
				agentLifecycleEventSchema.parse({
					...identity,
					version: 1,
					eventId: "name-event",
					sequence: 1,
					occurredAt: 1,
					type: "tool_call_accepted",
					payload: {
						item: {
							itemId: "call-item",
							type: "tool_call",
							toolCallId: "private-call",
							name: "PRIVATE TOOL NAME",
							arguments: "PRIVATE ARGUMENTS",
						},
					},
				}),
			) + "\n",
		)
		await fs.writeFile(
			path.join(directory, GlobalFileNames.agentLifecycleSnapshot),
			JSON.stringify({
				...identity,
				version: 1,
				effectTrackingVersion: 1,
				acceptedToolCallIds: ["private-call"],
				effectStartedToolCallIds: ["private-call"],
				terminalToolCallIds: [],
			}),
		)
		const collected = await collectDiagnosticsEvidence(directory, identity.taskId)
		expect(collected.evidence.sources.lifecycle.projection).toMatchObject({
			events: [expect.objectContaining({ toolNameSha256: hash("PRIVATE TOOL NAME") })],
		})
		expect(collected.evidence.sources.lifecycleSnapshot.projection).toMatchObject({
			effectTrackingVersion: 1,
			acceptedToolCallIdsCount: 1,
			effectStartedToolCallIdsCount: 1,
			terminalToolCallIdsCount: 0,
		})
		expect(JSON.stringify(collected)).not.toContain("PRIVATE")
		expect(JSON.stringify(collected)).not.toContain("private-call")
	})
})
