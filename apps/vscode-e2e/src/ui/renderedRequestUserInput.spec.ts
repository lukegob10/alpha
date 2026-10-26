import * as assert from "node:assert/strict"
import { test } from "node:test"
import { createContext, runInContext } from "node:vm"
import type { CdpConnection } from "./cdp"
import {
	questionAlignmentExpression,
	questionHistoryStateExpression,
	questionReceiptOutsideWorkExpression,
	questionViewportDiagnosticsExpression,
	questionWheelAfterExpression,
	questionWheelCaptureExpression,
	questionWheelCleanupExpression,
	questionWheelProgressExpression,
	sampleQuestionViewport,
} from "./renderedRequestUserInput"

const nonce = "question-renderer-reload"

function documentFixture(options: { nonce?: string; loading?: boolean; missing?: boolean; detached?: boolean } = {}) {
	let reads = 0
	let targetReads = 0
	let painted = 0
	let scrollTop = 40
	let wheelListener: ((event: object) => void) | undefined
	let wheelRegistration:
		| { target: "document" | "viewport"; painted: number; options: { capture?: boolean; passive?: boolean } }
		| undefined
	let registrations = 0
	const paints: Array<() => void> = []
	const focusedElement = {
		tagName: "H3",
		outerHTML: "<h3>Review your answers</h3>",
		isConnected: true,
		ownerDocument: undefined as unknown,
	}
	const registerWheel = (
		target: "document" | "viewport",
		name: string,
		listener: (event: object) => void,
		options: { capture?: boolean; passive?: boolean } = {},
	) => {
		assert.equal(name, "wheel")
		wheelListener = listener
		wheelRegistration = { target, painted, options }
		registrations++
	}
	const document = {
		readyState: options.loading ? "loading" : "complete",
		activeElement: focusedElement,
		elementFromPoint: (): unknown => target,
		addEventListener: (name: string, listener: (event: object) => void, options?: object) =>
			registerWheel("document", name, listener, options),
		removeEventListener: (name: string, listener: (event: object) => void) => {
			assert.equal(name, "wheel")
			if (wheelListener === listener) wheelListener = undefined
		},
		defaultView: {
			__alphaQuestionReloadNonce: options.nonce,
			__alphaQuestionCaptureWheel: undefined as unknown,
			performance: { now: () => painted * 16 },
			requestAnimationFrame: (callback: () => void) => paints.push(callback),
			getComputedStyle: (element: { tagName: string }) => ({
				overflowY: element.tagName === "DIV" || element.tagName === "TEXTAREA" ? "auto" : "visible",
			}),
		},
		querySelector: (selector: string): unknown =>
			selector === "[data-testid=chat-transcript-scroller]" ? (options.missing ? null : viewport) : target,
		querySelectorAll: (selector: string) => (selector === "[data-testid=user-input-receipt]" ? [{}] : []),
	}
	focusedElement.ownerDocument = document
	const viewport = {
		tagName: "DIV",
		parentElement: null,
		isConnected: !options.detached,
		ownerDocument: document,
		scrollHeight: 400,
		clientHeight: 100,
		get scrollTop() {
			reads++
			return scrollTop
		},
		set scrollTop(value: number) {
			scrollTop = value
		},
		addEventListener: (name: string, listener: (event: object) => void, options?: object) =>
			registerWheel("viewport", name, listener, options),
		getBoundingClientRect: () => ({ top: 10, left: 0, width: 300, height: 100, bottom: 110, right: 300 }),
	}
	const target = {
		tagName: "H3",
		parentElement: viewport,
		scrollTop: 0,
		scrollHeight: 0,
		clientHeight: 0,
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
		registrations: () => registrations,
		wheelRegistration: () => wheelRegistration,
		hasWheelListener: () => wheelListener !== undefined,
		wheel: (event: object, nativeScroll?: () => void) => {
			assert.ok(wheelListener)
			// Model Chromium's committed blocking region; otherwise its compositor may scroll before JS delivery.
			const blocking =
				wheelRegistration?.target === "document" &&
				wheelRegistration.options.capture === true &&
				wheelRegistration.options.passive === false &&
				painted >= wheelRegistration.painted + 2
			if (!blocking) nativeScroll?.()
			wheelListener({
				cancelable: blocking,
				eventPhase: wheelRegistration?.options.capture ? 1 : 3,
				timeStamp: painted * 16,
				...event,
			})
			if (blocking) nativeScroll?.()
			return blocking ? "listener-first" : "compositor-first"
		},
		paint: () => {
			painted++
			for (const callback of paints.splice(0)) callback()
		},
	}
}

class ControlledQuestionRenderer implements Pick<CdpConnection, "request"> {
	readonly frame: {
		isConnected: boolean
		contentDocument: ReturnType<typeof documentFixture>["document"]
		getBoundingClientRect: () => { left: number; top: number }
	}
	activeFrame: ControlledQuestionRenderer["frame"]
	readonly context
	onEvaluate?: () => void
	constructor(fixture = documentFixture()) {
		this.frame = {
			isConnected: true,
			contentDocument: fixture.document,
			getBoundingClientRect: () => ({ left: 0, top: 0 }),
		}
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

function captureQuestionWheel(fixture: ReturnType<typeof documentFixture>, renderer: ControlledQuestionRenderer) {
	const operation = sampleQuestionViewport<{ scrollTop: number; focus: string }>(
		renderer,
		"question-renderer",
		questionWheelCaptureExpression(),
	)
	fixture.paint()
	fixture.paint()
	return operation
}

for (const change of ["body descendants", "identical replacement", "control loses focus"] as const) {
	test(`native wheel focus tracks node identity: ${change}`, async () => {
		const fixture = documentFixture()
		if (change === "body descendants") {
			fixture.document.activeElement.tagName = "BODY"
			fixture.document.activeElement.outerHTML = "<body><main>Answers</main></body>"
		}
		const renderer = new ControlledQuestionRenderer(fixture)
		const point = await captureQuestionWheel(fixture, renderer)
		assert.ok(point.ready)
		if (change === "body descendants") {
			fixture.document.activeElement.outerHTML =
				'<body><main>Answers</main><button aria-label="Scroll to bottom of chat"></button></body>'
		} else {
			fixture.document.activeElement = {
				...fixture.document.activeElement,
				...(change === "control loses focus" ? { tagName: "BODY", outerHTML: "<body></body>" } : {}),
			}
		}
		const after = await sampleQuestionViewport<{ focus: string; focusPreserved: boolean }>(
			renderer,
			"question-renderer",
			questionWheelAfterExpression(),
		)
		assert.ok(after.ready)
		assert.equal(after.value.focusPreserved, change === "body descendants")
		assert.ok(after.value.focus.length < 512)
		assert.equal(after.value.focus.includes("<body"), false, "Focus diagnostics must not serialize descendants")
	})
}

test("wheel evidence separates point sampling from trusted delivery after a scroll shift", async () => {
	const fixture = documentFixture()
	const renderer = new ControlledQuestionRenderer(fixture)
	const sampled = await captureQuestionWheel(fixture, renderer)
	assert.equal(sampled.ready && sampled.value.scrollTop, 40)
	assert.equal(fixture.document.defaultView.__alphaQuestionCaptureWheel, undefined)
	fixture.viewport.scrollTop = 200
	fixture.wheel({
		isTrusted: true,
		deltaY: -80,
		defaultPrevented: false,
		target: fixture.target,
		composedPath: () => [fixture.target, fixture.viewport, fixture.document],
	})
	const evidence = await sampleQuestionViewport<{
		isTrusted: boolean
		geometry: { scrollTop: number }
		target: object
	}>(renderer, "question-renderer", "d.defaultView.__alphaQuestionCaptureWheel")
	assert.ok(evidence.ready)
	assert.equal(evidence.value.isTrusted, true)
	assert.equal(evidence.value.geometry.scrollTop, 200, "A later wheel must report its delivery-time baseline")
	assert.deepEqual(evidence.value.target, { tag: "H3", id: null, testId: null })
})

test("wheel diagnostics retain an untrusted nested-scroll target without claiming native progress", async () => {
	const fixture = documentFixture()
	fixture.target.tagName = "TEXTAREA"
	fixture.target.scrollHeight = 100
	fixture.target.clientHeight = 20
	const renderer = new ControlledQuestionRenderer(fixture)
	await captureQuestionWheel(fixture, renderer)
	fixture.wheel({
		isTrusted: false,
		deltaY: -80,
		defaultPrevented: true,
		target: fixture.target,
		composedPath: () => [fixture.target, fixture.viewport, fixture.document],
	})
	const evidence = await sampleQuestionViewport<{
		isTrusted: boolean
		defaultPreventedAtViewport: boolean
		target: { tag: string }
		geometry: { scrollTop: number; center: { ancestors: Array<{ tag: string; overflowY: string }> } }
	}>(renderer, "question-renderer", "d.defaultView.__alphaQuestionCaptureWheel")
	assert.ok(evidence.ready)
	assert.equal(evidence.value.isTrusted, false)
	assert.equal(evidence.value.defaultPreventedAtViewport, true)
	assert.equal(evidence.value.target.tag, "TEXTAREA")
	assert.equal(evidence.value.geometry.scrollTop, 40)
	assert.deepEqual(
		evidence.value.geometry.center.ancestors.map(({ tag, overflowY }) => ({ tag, overflowY })),
		[
			{ tag: "TEXTAREA", overflowY: "auto" },
			{ tag: "DIV", overflowY: "auto" },
		],
	)
	assert.deepEqual(
		await sampleQuestionViewport(
			renderer,
			"question-renderer",
			"d.defaultView.__alphaQuestionCaptureWheel?.isTrusted===true&&d.defaultView.__alphaQuestionCaptureWheel.deltaY<0",
		),
		{ ready: true, value: false },
	)
})

test("failure diagnostics distinguish a loading document with no viewport", () => {
	const fixture = documentFixture({ loading: true, missing: true })
	const renderer = new ControlledQuestionRenderer(fixture)
	const diagnostics: unknown = runInContext(
		`(()=>{const d=document.getElementById('active-frame').contentDocument;return (${questionViewportDiagnosticsExpression()})})()`,
		renderer.context,
	)
	assert.deepEqual(JSON.parse(JSON.stringify(diagnostics)), {
		documentReadyState: "loading",
		frameConnected: true,
		viewportConnected: false,
		ownerDocumentMatches: false,
		reloadNonce: null,
		viewport: null,
	})
})

for (const { name, sampled, delivered, after, isTrusted = true, deltaY = -80, expected } of [
	{ name: "layout moves down before delivery", sampled: 40, delivered: 200, after: 120, expected: true },
	{ name: "layout moves up before delivery", sampled: 200, delivered: 100, after: 20, expected: true },
	{ name: "unchanged delivery baseline", sampled: 200, delivered: 200, after: 120, expected: true },
	{ name: "blocked outer scroll", sampled: 200, delivered: 200, after: 200, expected: false },
	{ name: "insufficient outer progress", sampled: 200, delivered: 200, after: 160, expected: false },
	{ name: "clamped at the top", sampled: 40, delivered: 40, after: 0, expected: true },
	{ name: "already at the top", sampled: 0, delivered: 0, after: 0, expected: true },
	{
		name: "point at top does not excuse later blocked scroll",
		sampled: 0,
		delivered: 200,
		after: 200,
		expected: false,
	},
	{ name: "untrusted wheel", sampled: 200, delivered: 200, after: 120, isTrusted: false, expected: false },
	{ name: "wrong negative delta", sampled: 200, delivered: 200, after: 120, deltaY: -40, expected: false },
	{ name: "wrong wheel direction", sampled: 200, delivered: 200, after: 120, deltaY: 80, expected: false },
]) {
	test(`native wheel progress uses the actual delivery: ${name}`, async () => {
		const fixture = documentFixture()
		fixture.viewport.scrollTop = sampled
		const renderer = new ControlledQuestionRenderer(fixture)
		await captureQuestionWheel(fixture, renderer)
		fixture.viewport.scrollTop = delivered
		fixture.wheel({
			isTrusted,
			deltaY,
			defaultPrevented: false,
			target: fixture.target,
			composedPath: () => [fixture.target, fixture.viewport, fixture.document],
		})
		fixture.viewport.scrollTop = after
		assert.deepEqual(
			await sampleQuestionViewport(renderer, "question-renderer", questionWheelProgressExpression()),
			{ ready: true, value: expected },
		)
	})
}

test("wheel progress requires delivery on the current viewport", async () => {
	const fixture = documentFixture()
	const renderer = new ControlledQuestionRenderer(fixture)
	await captureQuestionWheel(fixture, renderer)
	assert.deepEqual(await sampleQuestionViewport(renderer, "question-renderer", questionWheelProgressExpression()), {
		ready: true,
		value: false,
	})
	fixture.viewport.scrollTop = 200
	fixture.wheel({
		isTrusted: true,
		deltaY: -80,
		defaultPrevented: false,
		target: fixture.target,
		composedPath: () => [fixture.target, fixture.viewport, fixture.document],
	})
	const replacement = documentFixture().viewport
	replacement.ownerDocument = fixture.document
	replacement.scrollTop = 120
	fixture.document.querySelector = () => replacement
	assert.deepEqual(await sampleQuestionViewport(renderer, "question-renderer", questionWheelProgressExpression()), {
		ready: true,
		value: false,
	})
})

test("native scrolling waits for the committed blocking capture observer", async () => {
	const fixture = documentFixture()
	fixture.viewport.scrollTop = 362
	const renderer = new ControlledQuestionRenderer(fixture)
	await captureQuestionWheel(fixture, renderer)
	const order = fixture.wheel(
		{
			isTrusted: true,
			deltaY: -80,
			defaultPrevented: false,
			target: fixture.target,
			composedPath: () => [fixture.target, fixture.viewport, fixture.document],
		},
		() => {
			fixture.viewport.scrollTop -= 80
		},
	)
	assert.equal(order, "listener-first", "A compositor-first receipt would already include the native -80 movement")
	const evidence = await sampleQuestionViewport<{ geometry: { scrollTop: number } }>(
		renderer,
		"question-renderer",
		"d.defaultView.__alphaQuestionCaptureWheel",
	)
	assert.ok(evidence.ready)
	assert.equal(evidence.value.geometry.scrollTop, 362)
	assert.equal(fixture.viewport.scrollTop, 282)
	assert.deepEqual(await sampleQuestionViewport(renderer, "question-renderer", questionWheelProgressExpression()), {
		ready: true,
		value: true,
	})
})

test("wheel point sampling waits for two paints after observer registration", async () => {
	const fixture = documentFixture()
	const renderer = new ControlledQuestionRenderer(fixture)
	const operation = sampleQuestionViewport<{ scrollTop: number }>(
		renderer,
		"question-renderer",
		questionWheelCaptureExpression(),
	)
	assert.deepEqual({ ...fixture.wheelRegistration()?.options }, { capture: true, passive: false })
	let settled = false
	void operation.then(() => {
		settled = true
	})
	fixture.paint()
	await Promise.resolve()
	assert.equal(settled, false)
	fixture.viewport.scrollTop = 200
	fixture.paint()
	const sample = await operation
	assert.ok(sample.ready)
	assert.equal(sample.value.scrollTop, 200)
})

test("one document observer resets stage evidence, rejects other targets, and detaches on cleanup", async () => {
	const fixture = documentFixture()
	const renderer = new ControlledQuestionRenderer(fixture)
	await captureQuestionWheel(fixture, renderer)
	await captureQuestionWheel(fixture, renderer)
	assert.equal(fixture.registrations(), 1)
	fixture.wheel({
		isTrusted: true,
		deltaY: -80,
		defaultPrevented: false,
		target: fixture.target,
		composedPath: () => [fixture.target, fixture.document],
	})
	fixture.viewport.scrollTop = 0
	assert.deepEqual(await sampleQuestionViewport(renderer, "question-renderer", questionWheelProgressExpression()), {
		ready: true,
		value: false,
	})
	await sampleQuestionViewport(renderer, "question-renderer", questionWheelCleanupExpression())
	assert.equal(fixture.hasWheelListener(), false)
	const after = await sampleQuestionViewport<{ focusPreserved: boolean }>(
		renderer,
		"question-renderer",
		questionWheelAfterExpression(),
	)
	assert.ok(after.ready)
	assert.equal(after.value.focusPreserved, false, "Cleanup must release the captured DOM node")
})

for (const { name, absent = false, hidden = false, controlled = false, expected } of [
	{ name: "live history visible outside collapsed work", expected: "visible" },
	{ name: "mounted history hidden inside collapsed work", hidden: true, controlled: true, expected: "hidden" },
	{ name: "cold history unmounted until work opens", absent: true, expected: "absent" },
	{ name: "visible history inside a collapsed controlled row", controlled: true, expected: "invalid" },
]) {
	test(`closed question history visibility: ${name}`, () => {
		const summary = absent
			? null
			: {
					closest: () => (hidden ? {} : null),
					getBoundingClientRect: () => ({ width: 200, height: hidden ? 0 : 18 }),
				}
		const context = createContext({
			summary,
			trace: { getAttribute: (name: string) => (name === "aria-expanded" ? "false" : "work-1 work-2") },
			d: {
				defaultView: { getComputedStyle: () => ({ visibility: "visible" }) },
				getElementById: () => ({ contains: (element: unknown) => controlled && element === summary }),
			},
		})
		const evaluate = () => runInContext(questionHistoryStateExpression("summary", "trace"), context)
		if (expected === "invalid") assert.throws(evaluate, /Collapsed work must hide its controlled question history/)
		else assert.equal(evaluate(), expected)
	})
}

for (const {
	name,
	inside = false,
	hidden = false,
	height = 80,
	missingControl = false,
	missingReceipt = false,
	expected,
} of [
	{ name: "visible receipt outside controlled work", expected: true },
	{ name: "receipt inside a controlled work row", inside: true, expected: false },
	{ name: "receipt under a hidden ancestor", hidden: true, expected: false },
	{ name: "receipt has no layout", height: 0, expected: false },
	{ name: "control points at a missing work row", missingControl: true, expected: false },
	{ name: "receipt is missing", missingReceipt: true, expected: false },
]) {
	test(`terminal question receipt isolation: ${name}`, () => {
		const receipt = {
			closest: () => (hidden ? {} : null),
			getBoundingClientRect: () => ({ width: 200, height }),
		}
		const context = createContext({
			trace: { getAttribute: () => "work-1 work-2" },
			d: {
				querySelector: () => (missingReceipt ? null : receipt),
				getElementById: (id: string) =>
					missingControl && id === "work-2"
						? null
						: { contains: (element: unknown) => inside && element === receipt },
			},
		})
		assert.equal(runInContext(questionReceiptOutsideWorkExpression("trace"), context), expected)
	})
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
