import * as assert from "node:assert/strict"
import { test } from "node:test"

import { SelectionLayoutTrace } from "./renderedSelectionLayout"

const phases = (pid: number) => [
	{ pid, name: "UpdateLayoutTree" },
	{ pid, name: "LocalFrameView::RunCompositingInputsLifecyclePhase" },
	{ pid, name: "HitTest" },
]

test("native workbench activity cannot stand in for Alpha's renderer phases", () => {
	const trace = new SelectionLayoutTrace("alpha-marker")
	trace.observe({
		method: "Tracing.dataCollected",
		params: { value: [...phases(8), { pid: 7, name: "alpha-marker" }] },
	})
	assert.deepEqual(trace.snapshot().phases, { layout: 0, compositing: 0, hitTest: 0 })
	trace.observe({ method: "Tracing.dataCollected", params: { value: phases(7) } })
	assert.deepEqual(trace.snapshot().phases, { layout: 1, compositing: 1, hitTest: 1 })
})

test("a replacement renderer cannot silently satisfy the native coverage check", () => {
	const trace = new SelectionLayoutTrace("alpha-marker")
	trace.observe({
		method: "Tracing.dataCollected",
		params: {
			value: [{ pid: 7, name: "alpha-marker" }, ...phases(7), { pid: 9, name: "alpha-marker" }, ...phases(9)],
		},
	})
	assert.deepEqual(trace.snapshot().rendererPids, [7, 9])
	assert.deepEqual(trace.snapshot().phases, { layout: 0, compositing: 0, hitTest: 0 })
})

test("trace overflow is explicit and retained evidence stays bounded", () => {
	const trace = new SelectionLayoutTrace("alpha-marker", 2)
	trace.observe({ method: "Tracing.dataCollected", params: { value: phases(7) } })
	assert.equal(trace.snapshot().overflow, true)
	assert.equal(trace.snapshot().records, 3)
})

test("malformed native records cannot supply renderer identity or phase evidence", () => {
	const trace = new SelectionLayoutTrace("alpha-marker")
	trace.observe({
		method: "Tracing.dataCollected",
		params: { value: [null, 42, {}, { pid: "7", name: "alpha-marker" }, { pid: NaN, name: "HitTest" }] },
	})
	assert.deepEqual(trace.snapshot().rendererPids, [])
	assert.deepEqual(trace.snapshot().phases, { layout: 0, compositing: 0, hitTest: 0 })
})
