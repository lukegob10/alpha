import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"

import { agentLifecycleSnapshotSchema, type AgentLifecycleEvent, TaskStatus } from "@alpha-code/types"

import type { Task } from "../../src/core/task/Task"
import { TaskSessionRegistry } from "../../src/core/webview/TaskSessionRegistry"

// Run: pnpm exec tsx scripts/benchmarks/webview-lifecycle-transport.ts
// Measures JSON wire bytes for the old full-snapshot envelopes and the current
// metadata projection. It does not measure browser memory or live task latency.
// The transport regression tests separately exercise AlphaProvider publication.
const textBytesPerItem = 8_000
const observations = []
for (const events of [100, 500, 1_000]) {
	const registry = new TaskSessionRegistry()
	registry.register({
		taskId: "task",
		metadata: {},
		taskStatus: TaskStatus.Running,
		isStreaming: false,
		isTurnActive: () => true,
		alphaMessages: [],
	} as unknown as Task)
	const snapshot = agentLifecycleSnapshotSchema.parse({
		version: 1,
		taskId: "task",
		runId: "run",
		turnId: "turn",
		status: "in_progress",
		phase: "working",
		lastSequence: 0,
		items: [],
		steps: [],
		acceptedToolCallIds: [],
		effectStartedToolCallIds: [],
		terminalToolCallIds: [],
		processedEvents: [],
	})
	let eventBytes = 0
	let legacyWireBytes = 0
	const legacyStarted = performance.now()
	for (let sequence = 1; sequence <= events; sequence++) {
		const item = { itemId: `text-${sequence}`, type: "assistant_text" as const, text: "x".repeat(textBytesPerItem) }
		const event: AgentLifecycleEvent = {
			version: 1,
			eventId: `event-${sequence}`,
			taskId: "task",
			runId: "run",
			turnId: "turn",
			sequence,
			occurredAt: sequence,
			type: "item_added",
			payload: { item },
		}
		snapshot.items.push(item)
		snapshot.lastSequence = sequence
		snapshot.processedEvents.push({ eventId: event.eventId, sequence, fingerprint: JSON.stringify(event) })
		eventBytes += Buffer.byteLength(JSON.stringify(event))
		// Omit the old metadata/settings fields for a conservative legacy count.
		legacyWireBytes +=
			Buffer.byteLength(
				JSON.stringify({
					type: "agentLifecycleEvent",
					taskId: "task",
					payload: event,
					agentLifecycleSnapshot: snapshot,
				}),
			) +
			Buffer.byteLength(JSON.stringify({ type: "state", state: { agentLifecycleSnapshots: { task: snapshot } } }))
	}
	const legacySerializeMs = performance.now() - legacyStarted
	agentLifecycleSnapshotSchema.parse(snapshot)
	registry.markLifecycleSnapshot("task", snapshot)
	const metadata = { ...registry.getMetadataForTask("task"), lastUpdatedAt: 1 }
	assert.equal(metadata.turnId, "turn")
	assert.equal(metadata.hasPendingToolCalls, false)
	let compactWireBytes = 0
	const compactStarted = performance.now()
	for (let taskStateSeq = 1; taskStateSeq <= events; taskStateSeq++) {
		compactWireBytes += Buffer.byteLength(
			JSON.stringify({
				type: "state",
				state: {
					currentView: { type: "newTaskDraft" },
					activeTaskId: "task",
					liveTaskIds: ["task"],
					liveTasksById: { task: metadata },
					agentLifecycleDegraded: {},
					taskStateSeq,
				},
			}),
		)
	}
	const compactSerializeMs = performance.now() - compactStarted
	assert.ok(compactWireBytes < events * 1_000, "Lifecycle transport must remain independent of accumulated text")
	observations.push({
		events,
		textBytesPerItem,
		snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)),
		eventBytes,
		legacyWireBytes,
		compactWireBytes,
		legacySerializeMs,
		compactSerializeMs,
	})
}

console.log(
	JSON.stringify(
		{ benchmark: "webview-lifecycle-transport", node: process.version, provider: "none", observations },
		null,
		2,
	),
)
