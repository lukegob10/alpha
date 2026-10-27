import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { createContext, runInContext } from "node:vm"

import type { CdpConnection } from "../ui/cdp"
import { exerciseUnattendedLifecycle } from "../ui/renderedUnattendedLifecycle"

async function fixture(queueApplicationFrames: boolean) {
	const temporaryRoot = await fs.realpath(os.tmpdir())
	const directory = await fs.mkdtemp(path.join(temporaryRoot, "alpha-unattended-unit-"))
	assert.equal(path.dirname(await fs.realpath(directory)), temporaryRoot)
	const nativeFrames = new Map<number, FrameRequestCallback>()
	let nextFrame = 0
	let round = 0
	const selection = {
		rangeCount: 0,
		isCollapsed: true,
		removeAllRanges() {
			this.rangeCount = 0
			this.isCollapsed = true
		},
		addRange() {
			this.rangeCount = 1
			this.isCollapsed = false
		},
	}
	const view = {
		requestAnimationFrame(callback: FrameRequestCallback) {
			nativeFrames.set(++nextFrame, callback)
			return nextFrame
		},
		cancelAnimationFrame(id: number) {
			nativeFrames.delete(id)
		},
	}
	const document = {
		defaultView: view,
		visibilityState: "visible",
		getSelection: () => selection,
		createRange: () => ({ selectNodeContents() {} }),
		addEventListener() {},
		removeEventListener() {},
		querySelector: () => ({
			getBoundingClientRect: () => ({ width: 100, height: 100 }),
			getAttribute: () => "80",
			disabled: false,
			textContent: Array.from({ length: 6 }, (_, index) => `UNATTENDED_FINAL_${index}`).join(" "),
		}),
	}
	const context = createContext({ d: document })
	const evaluate = async <T>(expression: string): Promise<T> => {
		const result = runInContext(expression, context)
		// Advance only native frames. The injected scheduler owns and holds its own callbacks.
		for (let tick = 0; tick < 2; tick++) {
			const callbacks = [...nativeFrames.values()]
			nativeFrames.clear()
			for (const callback of callbacks) callback(tick)
		}
		return await result
	}
	const cdp = {
		request: async () => ({ result: { value: round !== 1 && round !== 4 } }),
	} as unknown as CdpConnection
	return {
		directory,
		run: () =>
			exerciseUnattendedLifecycle(cdp, "workbench", directory, "unit-nonce", {
				evaluate,
				ready: async (stage) => {
					round = stage.charCodeAt(stage.length - 1) - "a".charCodeAt(0)
					if (stage.startsWith("unattended-complete-") && queueApplicationFrames) {
						// Completion snapshots flush partial state and cancel its scheduled callback.
						runInContext(
							"d.defaultView.cancelAnimationFrame(d.defaultView.requestAnimationFrame(()=>{}))",
							context,
						)
					}
				},
				acknowledge: async () => undefined,
			}),
		cleanup: () => fs.rm(directory, { recursive: true, force: true }),
	}
}

test("held-frame acceptance records application work even when completion cancels its callback", async (t) => {
	const probe = await fixture(true)
	t.after(probe.cleanup)
	await probe.run()
	const evidence = JSON.parse(await fs.readFile(path.join(probe.directory, "ui-unattended-lifecycle.json"), "utf8"))
	assert.equal(evidence.observations.length, 6)
	for (const observation of evidence.observations.filter((entry: { mode: string }) => entry.mode === "held-frames")) {
		assert.equal(observation.completed.pendingFrames, observation.before.pendingFrames)
		assert.ok(observation.completed.heldFrameRequests > observation.before.heldFrameRequests)
		assert.equal(observation.completed.frameTicks, observation.before.frameTicks)
	}
})

test("held-frame acceptance rejects a probe heartbeat without application frame work", async (t) => {
	const probe = await fixture(false)
	t.after(probe.cleanup)
	await assert.rejects(probe.run(), /Actual application frame work must be queued/)
})
