import { performance } from "node:perf_hooks"

import type { AgentLifecycleEvent } from "@alpha-code/types"

import { AgentIncidentMonitor } from "../AgentIncidentMonitor"
import { createAgentLifecycleSnapshot, reduceAgentLifecycleEvent } from "../lifecycle/reducer"

const eventCount = 512
const snapshotCount = 1_000
const events: AgentLifecycleEvent[] = Array.from({ length: eventCount }, (_, index) => ({
	version: 1,
	eventId: `bench-${index}`,
	sequence: index + 1,
	taskId: "bench-task",
	runId: "bench-run",
	turnId: "bench-turn",
	occurredAt: index + 1,
	type: "phase_changed",
	payload: { phase: "working" },
}))
const capacityEventCount = 10_000
const capacityEvents: AgentLifecycleEvent[] = Array.from({ length: capacityEventCount }, (_, index) => ({
	version: 1,
	eventId: `capacity-${index}`,
	sequence: index + 1,
	taskId: "capacity-task",
	runId: "capacity-run",
	turnId: "capacity-turn",
	occurredAt: index + 1,
	type: "phase_changed",
	payload: { phase: "working" },
}))

interface Measurement {
	wallMs: number
	cpuMs: number
}

function runWorkload(withMonitor: boolean): Measurement {
	let lifecycle = createAgentLifecycleSnapshot({ taskId: "bench-task", runId: "bench-run", turnId: "bench-turn" })
	const monitor = withMonitor ? new AgentIncidentMonitor({ now: () => 20_000 }) : undefined
	monitor?.subscribe(() => undefined)
	const start = performance.now()
	const cpuStart = process.cpuUsage()
	for (const event of events) {
		lifecycle = reduceAgentLifecycleEvent(lifecycle, event)
		monitor?.observe(event)
	}
	const cpuElapsed = process.cpuUsage(cpuStart)
	return {
		wallMs: performance.now() - start,
		cpuMs: (cpuElapsed.user + cpuElapsed.system) / 1_000,
	}
}

function median(values: number[]): number {
	return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]
}

// Warm both paths, then alternate their order to reduce scheduling bias.
runWorkload(false)
runWorkload(true)
const projectorOnlyRuns: Measurement[] = []
const projectorAndMonitorRuns: Measurement[] = []
const pairedWallOverheadRuns: number[] = []
const pairedCpuOverheadRuns: number[] = []
const measuredRunsPerPath = 7
for (let index = 0; index < measuredRunsPerPath; index++) {
	const measureProjectorFirst = index % 2 === 0
	const first = runWorkload(!measureProjectorFirst)
	const second = runWorkload(measureProjectorFirst)
	const projectorOnly = measureProjectorFirst ? first : second
	const projectorAndMonitor = measureProjectorFirst ? second : first
	projectorOnlyRuns.push(projectorOnly)
	projectorAndMonitorRuns.push(projectorAndMonitor)
	pairedWallOverheadRuns.push(projectorAndMonitor.wallMs - projectorOnly.wallMs)
	pairedCpuOverheadRuns.push(projectorAndMonitor.cpuMs - projectorOnly.cpuMs)
}
const projectorOnlyWallMs = median(projectorOnlyRuns.map((run) => run.wallMs))
const projectorAndMonitorWallMs = median(projectorAndMonitorRuns.map((run) => run.wallMs))
const monitorOverheadWallMs = median(pairedWallOverheadRuns)
const monitorOverheadCpuMs = median(pairedCpuOverheadRuns)
const monitorOverheadWallPercent = median(
	pairedWallOverheadRuns.map((overhead, index) => (overhead / projectorOnlyRuns[index].wallMs) * 100),
)
const monitorOverheadCpuPercent = median(
	pairedCpuOverheadRuns.map((overhead, index) => (overhead / projectorOnlyRuns[index].cpuMs) * 100),
)

const monitor = new AgentIncidentMonitor({ now: () => 20_000 })
for (const event of events) monitor.observe(event)
const snapshotStart = performance.now()
for (let index = 0; index < snapshotCount; index++) monitor.snapshot()
const snapshotWallMs = performance.now() - snapshotStart

const capacityMonitor = new AgentIncidentMonitor({ now: () => 20_000 })
capacityMonitor.subscribe(() => undefined)
for (const event of capacityEvents.slice(0, 1_000)) capacityMonitor.observe(event)
const capacityStart = performance.now()
for (const event of capacityEvents) capacityMonitor.observe(event)
const capacityWallMs = performance.now() - capacityStart

console.log(
	JSON.stringify({
		node: process.version,
		platform: process.platform,
		eventCount,
		warmupRunsPerPath: 1,
		measuredRunsPerPath,
		projectorOnlyMedianWallMs: Number(projectorOnlyWallMs.toFixed(2)),
		projectorAndMonitorMedianWallMs: Number(projectorAndMonitorWallMs.toFixed(2)),
		pairedMonitorOverheadWallMs: pairedWallOverheadRuns.map((value) => Number(value.toFixed(2))),
		monitorOverheadMedianWallMs: Number(monitorOverheadWallMs.toFixed(2)),
		monitorOverheadMedianWallPercent: Number(monitorOverheadWallPercent.toFixed(1)),
		pairedMonitorOverheadCpuMs: pairedCpuOverheadRuns.map((value) => Number(value.toFixed(2))),
		monitorOverheadMedianCpuMs: Number(monitorOverheadCpuMs.toFixed(2)),
		monitorOverheadMedianCpuPercent: Number(monitorOverheadCpuPercent.toFixed(1)),
		snapshotCount,
		snapshotWallMs: Number(snapshotWallMs.toFixed(2)),
		capacityEventCount,
		capacityObserveWallMs: Number(capacityWallMs.toFixed(2)),
		capacityObserveEventsPerSecond: Math.round(capacityEventCount / (capacityWallMs / 1_000)),
	}),
)
