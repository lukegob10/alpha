import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createContext, runInContext } from "node:vm"
import { completeHistoryUiRun, historyPointerProbeExpression, withHistoryPointerEvidence } from "../runHistoryUi"

const verifiedHost = {
	status: "passed",
	execution: "extension-host",
	ownershipGate: "verified",
	captureComplete: true,
	hostExitObserved: true,
	actualVSCodeVersion: "1.138.0",
} as const

function pointerDocumentFixture() {
	const listeners = new Map<string, (event: unknown) => void>()
	const rectangle = { left: 20, top: 40, width: 200, height: 24, right: 220, bottom: 64 }
	const target = {
		tagName: "DIV",
		isConnected: true,
		ownerDocument: undefined as unknown,
		getBoundingClientRect: () => rectangle,
		getAttribute: (name: string) => (name === "data-testid" ? "task-item-history-visual-0" : null),
		contains: (node: unknown) => node === target,
		matches: () => false,
		addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
		removeEventListener: (name: string) => listeners.delete(name),
	}
	let currentTarget: typeof target | null = target
	const document = {
		readyState: "complete",
		hasFocus: () => true,
		querySelector: () => currentTarget,
		elementFromPoint: (x: number, y: number) => (x === 120 && y === 52 ? currentTarget : null),
	}
	target.ownerDocument = document
	const frame = {
		isConnected: true,
		contentDocument: document,
		getBoundingClientRect: () => ({ left: 3, top: 5, width: 300, height: 500, right: 303, bottom: 505 }),
	}
	const outerDocument = {
		getElementById: () => frame,
		elementFromPoint: () => frame,
	}
	const context = createContext({ document: outerDocument, d: document, window: {}, Number })
	const observe = (action: "install" | "snapshot" | "dispose") =>
		JSON.parse(
			JSON.stringify(
				runInContext(
					historyPointerProbeExpression("[data-testid=task-item-history-visual-0]", action),
					context,
				),
			),
		)
	return {
		target,
		frame,
		document,
		listeners,
		observe,
		replace: () => {
			currentTarget = null
		},
	}
}

test("history pointer diagnostics retain current geometry, focus and a hit-test without manufacturing hover", () => {
	const fixture = pointerDocumentFixture()
	const observed = fixture.observe("install")
	assert.deepEqual(observed.row.bounds, { left: 20, top: 40, width: 200, height: 24 })
	assert.equal(observed.row.connected, true)
	assert.equal(observed.row.hovered, false)
	assert.equal(observed.document.focused, true)
	assert.deepEqual(observed.row.center, { x: 120, y: 52 })
	assert.equal(observed.row.hit.target, true)
	assert.deepEqual(observed.frame.bounds, { left: 3, top: 5, width: 300, height: 500 })
	fixture.observe("dispose")
	assert.equal(fixture.listeners.size, 0)
	const failedSnapshot = pointerDocumentFixture()
	failedSnapshot.observe("install")
	failedSnapshot.target.getBoundingClientRect = () => {
		throw new Error("diagnostic bounds unavailable")
	}
	assert.throws(() => failedSnapshot.observe("dispose"), /diagnostic bounds unavailable/)
	assert.equal(failedSnapshot.listeners.size, 0, "Listener cleanup precedes fallible final diagnostic sampling")
})

test("history pointer receipts preserve trusted flags with bounded metadata and clean replaced targets idempotently", () => {
	const fixture = pointerDocumentFixture()
	fixture.observe("install")
	const receive = fixture.listeners.get("pointerover")!
	for (let index = 0; index < 20; index++)
		receive({ type: "pointerover", isTrusted: index !== 0, clientX: 120, clientY: 52, target: fixture.target })
	const observed = fixture.observe("snapshot")
	assert.equal(observed.eventCount, 20)
	assert.equal(observed.events.length, 8)
	assert.equal(observed.events[0].trusted, false)
	assert.equal(observed.events[1].trusted, true)
	assert.ok(!JSON.stringify(observed).includes("outerHTML"))
	fixture.replace()
	const replaced = fixture.observe("dispose")
	assert.equal(replaced.row, null)
	assert.equal(replaced.events.length, 8)
	assert.equal(fixture.listeners.size, 0)
	fixture.observe("dispose")
	assert.equal(fixture.listeners.size, 0)
})

test("history diagnostic capture failures cannot replace the primary assertion or a successful interaction", async () => {
	const primary = new Error("original hover assertion")
	await assert.rejects(
		withHistoryPointerEvidence(
			async () => {
				throw primary
			},
			async () => {
				throw new Error("diagnostic unavailable")
			},
		),
		(error) => error === primary,
	)
	assert.equal(
		await withHistoryPointerEvidence(
			async () => "passed",
			async () => {
				throw new Error("diagnostic unavailable")
			},
		),
		"passed",
	)
})

test("history UI accepts only a complete result from its owned exact-version host", async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-history-ui-outcome-")))
	try {
		const evidence = path.join(root, "evidence")
		const output = path.join(root, "output")
		await fs.mkdir(evidence)
		await fs.mkdir(output)
		const nonce = "00000000-0000-4000-8000-000000000001"
		for (const stage of ["chats-small", "chats-dark", "chats-light", "chats-contrast"]) {
			await fs.writeFile(
				path.join(evidence, `ui-done-${stage}.json`),
				JSON.stringify({ nonce, stage, status: "passed" }),
			)
		}

		const accepted = await completeHistoryUiRun(verifiedHost, evidence, output, "verified")
		assert.equal(accepted.status, "passed")
		assert.deepEqual(accepted.host, verifiedHost)

		const comparative = await completeHistoryUiRun(
			{ ...verifiedHost, actualVSCodeVersion: "1.139.1" },
			evidence,
			output,
			"comparative-139",
			"1.139.1",
		)
		assert.equal(comparative.status, "passed")
		assert.equal(comparative.host.actualVSCodeVersion, "1.139.1")

		for (const [name, change] of [
			["failed", { status: "failed" }],
			["blocked", { status: "blocked" }],
			["test-seam", { execution: "test-seam" }],
			["unowned", { ownershipGate: undefined }],
			["incomplete", { captureComplete: false }],
			["host-open", { hostExitObserved: false }],
			["wrong-version", { actualVSCodeVersion: "1.123.0" }],
		] as const) {
			const runId = `invalid-${name}`
			await assert.rejects(
				completeHistoryUiRun({ ...verifiedHost, ...change }, evidence, output, runId),
				/History UI host validation failed/,
				`${name} host result must not pass even after every renderer stage was acknowledged`,
			)
			assert.equal(
				JSON.parse(await fs.readFile(path.join(output, runId, "ui-done-chats-contrast.json"), "utf8")).status,
				"passed",
				`Renderer receipts remain available for the ${name} failure`,
			)
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})
