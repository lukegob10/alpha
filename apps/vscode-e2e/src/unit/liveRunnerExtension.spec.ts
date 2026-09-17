import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { setImmediate as nextTurn } from "node:timers/promises"

import { executeLiveSidecar, type LiveSidecarEffects } from "../liveRunnerExtension"
import type { LiveHostReceipt } from "../liveHostProtocol"
import { TestRunError } from "../runFailure"

const identity = { runId: "sidecar-test", nonce: randomUUID(), actualVSCodeVersion: "1.122.1", pid: 123, ppid: 45 }

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => (resolve = done))
	return { promise, resolve }
}

function effects(overrides: Partial<LiveSidecarEffects> = {}) {
	const steps: string[] = []
	const receipts: LiveHostReceipt[] = []
	return {
		steps,
		receipts,
		operations: {
			verifyOwner: async () => {
				steps.push("owned")
			},
			write: async (receipt: LiveHostReceipt) => {
				receipts.push(receipt)
				steps.push(receipt.status)
			},
			runSuite: async () => {
				steps.push("suite")
			},
			closeWindow: async () => {
				steps.push("close")
			},
			...overrides,
		} satisfies LiveSidecarEffects,
	}
}

test("normal adapter runs exactly the existing suite and persists completion before graceful close", async () => {
	const host = effects()
	await executeLiveSidecar(identity, host.operations, new AbortController().signal)
	assert.deepEqual(host.steps, ["owned", "started", "suite", "passed", "close"])
	assert.equal(host.receipts[1]?.nonce, identity.nonce)
	assert.equal(host.receipts[1]?.pid, identity.pid)
})

test("a failing suite keeps its typed failure, redacts exceptions, and closes normally", async () => {
	for (const error of [new TestRunError("no-tests-executed", "sensitive detail"), new Error("sensitive detail")]) {
		const host = effects({
			runSuite: async () => {
				throw error
			},
		})
		await executeLiveSidecar(identity, host.operations, new AbortController().signal)
		assert.equal(host.receipts[1]?.status, "failed")
		assert.equal(host.receipts[1]?.failure, error instanceof TestRunError ? "no-tests-executed" : "host-failed")
		assert.equal(JSON.stringify(host.receipts).includes("sensitive detail"), false)
		assert.equal(host.steps.at(-1), "close")
	}
})

test("ownership refusal cannot invoke the suite, publish receipts, or close an unrelated window", async () => {
	const host = effects({
		verifyOwner: async () => {
			throw new TestRunError("host-not-owned", "not owned")
		},
	})
	await assert.rejects(executeLiveSidecar(identity, host.operations, new AbortController().signal), {
		code: "host-not-owned",
	})
	assert.deepEqual(host.steps, [])
})

test("early manual close cancels the sidecar and prevents a late successful receipt", async () => {
	const suite = deferred()
	const cancellation = new AbortController()
	const host = effects({ runSuite: () => suite.promise })
	const running = executeLiveSidecar(identity, host.operations, cancellation.signal)
	await nextTurn()
	cancellation.abort()
	suite.resolve()
	await assert.rejects(running, { name: "AbortError" })
	assert.deepEqual(host.steps, ["owned", "started"])
})

test("pre-cancelled execution cannot inspect ownership or invoke anything", async () => {
	const cancellation = new AbortController()
	cancellation.abort()
	const host = effects()
	await assert.rejects(executeLiveSidecar(identity, host.operations, cancellation.signal), { name: "AbortError" })
	assert.deepEqual(host.steps, [])
})

test("a failed terminal write does not request close or pretend the suite was durably completed", async () => {
	const host = effects({
		write: async (receipt) => {
			if (receipt.status !== "started") throw new Error("write failed")
		},
	})
	await assert.rejects(executeLiveSidecar(identity, host.operations, new AbortController().signal))
	assert.deepEqual(host.steps, ["owned", "suite"])
})

test("a vetoed or hanging close never becomes numeric-exit evidence from the sidecar", async () => {
	const close = deferred()
	const host = effects({ closeWindow: () => close.promise })
	let returned = false
	const running = executeLiveSidecar(identity, host.operations, new AbortController().signal).then(() => {
		returned = true
	})
	await nextTurn()
	assert.equal(host.receipts[1]?.status, "passed")
	assert.equal(returned, false)
	assert.equal("hostExitObserved" in host.receipts[1]!, false)
	close.resolve()
	await running
})
