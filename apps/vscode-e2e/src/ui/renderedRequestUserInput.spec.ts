import * as assert from "node:assert/strict"
import { test } from "node:test"
import { createContext, runInContext } from "node:vm"
import type { CdpConnection } from "./cdp"
import { questionAlignmentExpression, sampleQuestionViewport } from "./renderedRequestUserInput"

const nonce = "question-renderer-reload"

function documentFixture(options: { nonce?: string; loading?: boolean; missing?: boolean; detached?: boolean } = {}) {
	let reads = 0
	let targetReads = 0
	let painted = 0
	const paints: Array<() => void> = []
	const document = {
		readyState: options.loading ? "loading" : "complete",
		defaultView: {
			__alphaQuestionReloadNonce: options.nonce,
			performance: { now: () => painted * 16 },
			requestAnimationFrame: (callback: () => void) => paints.push(callback),
		},
		querySelector: (selector: string): unknown =>
			selector === "[data-testid=chat-transcript-scroller]" ? (options.missing ? null : viewport) : target,
		querySelectorAll: (selector: string) => (selector === "[data-testid=user-input-receipt]" ? [{}] : []),
	}
	const viewport = {
		isConnected: !options.detached,
		ownerDocument: document,
		get scrollTop() {
			reads++
			return 40
		},
		getBoundingClientRect: () => ({ top: 10, left: 0, width: 300, height: 100, bottom: 110, right: 300 }),
	}
	const target = {
		isConnected: true,
		ownerDocument: document,
		closest: () => viewport,
		scrollIntoView: () => undefined,
		getBoundingClientRect: () => {
			targetReads++
			return { top: 20, bottom: 50, height: 30 }
		},
	}
	return {
		document,
		viewport,
		target,
		reads: () => reads,
		targetReads: () => targetReads,
		paint: () => {
			painted++
			for (const callback of paints.splice(0)) callback()
		},
	}
}

class ControlledQuestionRenderer implements Pick<CdpConnection, "request"> {
	readonly frame: { isConnected: boolean; contentDocument: ReturnType<typeof documentFixture>["document"] }
	activeFrame: ControlledQuestionRenderer["frame"]
	readonly context
	onEvaluate?: () => void
	constructor(fixture = documentFixture()) {
		this.frame = { isConnected: true, contentDocument: fixture.document }
		this.activeFrame = this.frame
		this.context = createContext({ document: { getElementById: () => this.activeFrame } })
	}
	async request<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
		assert.equal(method, "Runtime.evaluate")
		assert.equal(sessionId, "question-renderer")
		assert.equal(params.returnByValue, true)
		assert.equal(params.awaitPromise, true)
		try {
			const operation: unknown = runInContext(String(params.expression), this.context)
			this.onEvaluate?.()
			return { result: { value: JSON.parse(JSON.stringify(await operation)) } } as T
		} catch (error) {
			return {
				result: {},
				exceptionDetails: { text: error instanceof Error ? error.message : String(error) },
			} as T
		}
	}
}

test("question capture waits through old document, loading replacement, and missing viewport", async () => {
	const old = documentFixture({ nonce })
	const renderer = new ControlledQuestionRenderer(old)
	assert.deepEqual(await sampleQuestionViewport(renderer, "question-renderer", "viewport.scrollTop", nonce), {
		ready: false,
	})
	assert.equal(old.reads(), 0, "An old receipt must not authorize geometry reads")
	for (const transition of [documentFixture({ loading: true }), documentFixture({ missing: true })]) {
		renderer.frame.contentDocument = transition.document
		assert.deepEqual(await sampleQuestionViewport(renderer, "question-renderer", "viewport.scrollTop", nonce), {
			ready: false,
		})
		assert.equal(transition.reads(), 0)
	}
	const current = documentFixture()
	renderer.frame.contentDocument = current.document
	assert.deepEqual(await sampleQuestionViewport(renderer, "question-renderer", "viewport.scrollTop", nonce), {
		ready: true,
		value: 40,
	})
	assert.equal(current.reads(), 1)
})

test("missing viewport at the actual scroll read returns not-ready instead of throwing", async () => {
	const renderer = new ControlledQuestionRenderer(documentFixture({ missing: true }))
	assert.deepEqual(await sampleQuestionViewport(renderer, "question-renderer", "viewport.scrollTop"), {
		ready: false,
	})
})

test("viewport detached between a prior readiness sample and capture is rejected atomically", async () => {
	const fixture = documentFixture()
	const renderer = new ControlledQuestionRenderer(fixture)
	assert.equal((await sampleQuestionViewport(renderer, "question-renderer", "viewport.scrollTop")).ready, true)
	fixture.viewport.isConnected = false
	assert.deepEqual(await sampleQuestionViewport(renderer, "question-renderer", "viewport.scrollTop"), {
		ready: false,
	})
	assert.equal(fixture.reads(), 1)
})

test("a disconnected frame cannot supply a current question capture", async () => {
	const fixture = documentFixture()
	const renderer = new ControlledQuestionRenderer(fixture)
	renderer.frame.isConnected = false
	assert.deepEqual(await sampleQuestionViewport(renderer, "question-renderer", "viewport.scrollTop"), {
		ready: false,
	})
	assert.equal(fixture.reads(), 0)
})

test("a viewport from another document is not current capture evidence", async () => {
	const fixture = documentFixture()
	const renderer = new ControlledQuestionRenderer(fixture)
	fixture.viewport.ownerDocument = documentFixture().document
	assert.deepEqual(await sampleQuestionViewport(renderer, "question-renderer", "viewport.scrollTop"), {
		ready: false,
	})
	assert.equal(fixture.reads(), 0)
})

test("an asynchronous capture cannot settle with an old document after reload", async () => {
	const fixture = documentFixture()
	const renderer = new ControlledQuestionRenderer(fixture)
	let observed!: () => void
	const started = new Promise<void>((resolve) => {
		observed = resolve
	})
	renderer.onEvaluate = observed
	const operation = sampleQuestionViewport(
		renderer,
		"question-renderer",
		"new Promise(resolve=>{globalThis.releaseCapture=resolve})",
	)
	await started
	renderer.frame.contentDocument = documentFixture().document
	runInContext("globalThis.releaseCapture({scrollTop:40})", renderer.context)
	assert.deepEqual(await operation, { ready: false })
})

test("question capture preserves connected geometry and fails unexpected renderer errors", async () => {
	const renderer = new ControlledQuestionRenderer()
	assert.deepEqual(
		await sampleQuestionViewport(
			renderer,
			"question-renderer",
			"({top:viewport.getBoundingClientRect().top,scrollTop:viewport.scrollTop})",
		),
		{ ready: true, value: { top: 10, scrollTop: 40 } },
	)
	await assert.rejects(
		sampleQuestionViewport(renderer, "question-renderer", "(()=>{throw new Error('unexpected renderer error')})()"),
		assert.AssertionError,
	)
})

for (const replacement of ["active-frame", "viewport"] as const) {
	test(`a still-connected old ${replacement} is rejected after an awaited capture`, async () => {
		const fixture = documentFixture()
		const renderer = new ControlledQuestionRenderer(fixture)
		let observed!: () => void
		const started = new Promise<void>((resolve) => {
			observed = resolve
		})
		renderer.onEvaluate = observed
		const operation = sampleQuestionViewport(
			renderer,
			"question-renderer",
			"new Promise(resolve=>{globalThis.releaseCapture=resolve})",
		)
		await started
		if (replacement === "active-frame") renderer.activeFrame = new ControlledQuestionRenderer().frame
		else {
			const newer = documentFixture().viewport
			newer.ownerDocument = fixture.document
			fixture.document.querySelector = () => newer
		}
		runInContext("globalThis.releaseCapture({scrollTop:40})", renderer.context)
		assert.deepEqual(await operation, { ready: false })
	})
}

test("alignment stops before reading a replaced receipt's detached geometry", async () => {
	const fixture = documentFixture()
	const renderer = new ControlledQuestionRenderer(fixture)
	let observed!: () => void
	const started = new Promise<void>((resolve) => {
		observed = resolve
	})
	renderer.onEvaluate = observed
	const selector = "[data-testid=user-input-receipt]"
	const operation = sampleQuestionViewport(
		renderer,
		"question-renderer",
		questionAlignmentExpression(selector, "start"),
		undefined,
		selector,
	)
	await started
	fixture.target.isConnected = false
	fixture.document.querySelector = (query) => (query === selector ? null : fixture.viewport)
	for (let paint = 0; paint < 4; paint++) fixture.paint()
	assert.deepEqual(await operation, { ready: false })
	assert.equal(fixture.targetReads(), 0, "A detached receipt must not produce screenshot geometry")
})

test("alignment treats a missing current receipt as not-ready rather than a completed null sample", async () => {
	const fixture = documentFixture()
	const renderer = new ControlledQuestionRenderer(fixture)
	const selector = "[data-testid=user-input-receipt]"
	fixture.document.querySelector = (query) => (query === selector ? null : fixture.viewport)
	assert.deepEqual(
		await sampleQuestionViewport(
			renderer,
			"question-renderer",
			questionAlignmentExpression(selector, "start"),
			undefined,
			selector,
		),
		{ ready: false },
	)
})
