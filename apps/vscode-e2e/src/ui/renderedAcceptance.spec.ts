import * as assert from "node:assert/strict"
import { getEventListeners } from "node:events"
import { test } from "node:test"
import { isPromise } from "node:util/types"
import { createContext, runInContext } from "node:vm"

import { type CdpConnection } from "./cdp"
import { createRenderedAcceptanceControls } from "./renderedAcceptance"

const sessionId = "owned-renderer"
const optionExpression = "d.querySelector('[role=option]')"
type Scenario =
	| "moving"
	| "covered"
	| "replaced"
	| "replaced-document"
	| "finite-animation"
	| "infinite-animation"
	| "hover-moves"

function rectangle(x: number, y: number, width: number, height: number) {
	return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height }
}

/** Executes the actual probe expressions with CDP promise semantics and explicitly advanced browser paint frames. */
class ControlledRenderer implements Pick<CdpConnection, "request"> {
	frame = 0
	selected = false
	mouseButtonHeld = false
	readonly requests: string[] = []
	readonly input: Record<string, unknown>[] = []
	readonly inputFrames: number[] = []
	onPaint?: (frame: number) => void
	onInput?: (input: Record<string, unknown>) => void
	onRelease?: () => Promise<void>
	private scrolled = false
	private pressed = false
	private hovered = false
	private readonly frames: FrameRequestCallback[] = []
	private readonly frameWaiters: (() => void)[] = []
	private readonly context

	constructor(private readonly scenario: Scenario = "moving") {
		const moving = scenario === "moving" || scenario === "replaced"
		const optionRectangle = (original: boolean) =>
			rectangle(
				24,
				(scenario === "replaced-document" && original) || (scenario === "hover-moves" && !this.hovered)
					? 200
					: moving && this.frame < 3
						? 280 - 60 * this.frame
						: 100,
				120,
				24,
			)
		const coveringElement = {}
		const animation = {
			playState: "running",
			effect: {
				getComputedTiming: () => ({ endTime: scenario === "infinite-animation" ? Infinity : 64 }),
				getTiming: () => ({ iterations: scenario === "infinite-animation" ? Infinity : 1 }),
			},
		}
		const animations = () =>
			scenario === "infinite-animation" || (scenario === "finite-animation" && this.frame < 4) ? [animation] : []
		const portal = { parentElement: null, getAnimations: animations }
		const createOption = (original: boolean) => {
			const label = { parentElement: undefined as unknown }
			const isConnected = () => !(original && scenario === "replaced" && this.frame >= 2)
			const option = {
				get isConnected() {
					return isConnected()
				},
				disabled: false,
				textContent: "Large (20KB)",
				parentElement: portal,
				getAttribute: () => null,
				getBoundingClientRect: () => (option.isConnected ? optionRectangle(original) : rectangle(0, 0, 0, 0)),
				contains: (element: unknown): boolean => element === option || element === label,
				getAnimations: () => [],
				scrollIntoView: () => {
					this.scrolled = true
				},
			}
			label.parentElement = option
			return { option, label }
		}
		const original = createOption(true)
		const replacement = createOption(false)
		const current = () =>
			["replaced", "replaced-document"].includes(scenario) && this.frame >= 2 ? replacement : original
		const scopedHit = (target: typeof original, x: number, y: number) => {
			const r = target.option.getBoundingClientRect()
			if (scenario === "covered" && this.frame < 3) return coveringElement
			return this.scrolled && x >= r.left && x < r.right && y >= r.top && y < r.bottom ? target.label : null
		}
		const hit = (x: number, y: number) => scopedHit(current(), x, y)
		const viewport = {
			innerWidth: 320,
			innerHeight: 600,
			performance: { now: () => this.frame * 16 },
			getComputedStyle: () => ({ display: "block", visibility: "visible", pointerEvents: "auto" }),
			requestAnimationFrame: (callback: FrameRequestCallback) => {
				this.frames.push(callback)
				for (const resolve of this.frameWaiters.splice(0)) resolve()
				return this.frames.length
			},
		}
		const contentDocument = {
			defaultView: viewport,
			documentElement: { clientWidth: 320, clientHeight: 600 },
			querySelector: () => current().option,
			querySelectorAll: () => [current().option],
			elementFromPoint: hit,
			getAnimations: animations,
		}
		const originalDocument = {
			...contentDocument,
			querySelector: () => original.option,
			querySelectorAll: () => [original.option],
			elementFromPoint: (x: number, y: number) => scopedHit(original, x, y),
		}
		const replacementDocument = {
			...contentDocument,
			querySelector: () => replacement.option,
			querySelectorAll: () => [replacement.option],
			elementFromPoint: (x: number, y: number) => scopedHit(replacement, x, y),
		}
		const activeDocument = () =>
			scenario === "replaced-document"
				? this.frame >= 2
					? replacementDocument
					: originalDocument
				: contentDocument
		const frame = {
			get contentDocument() {
				return activeDocument()
			},
			getBoundingClientRect: () => rectangle(400, 60, 320, 600),
		}
		this.context = createContext({
			document: { getElementById: () => frame, elementFromPoint: () => frame },
		})
		this.mouseHit = (x, y) => current().option.contains(hit(x - 400, y - 60))
	}

	private readonly mouseHit: (x: number, y: number) => boolean

	async request<T>(method: string, params: Record<string, unknown> = {}, targetSession?: string): Promise<T> {
		assert.equal(targetSession, sessionId)
		this.requests.push(method)
		if (method === "Runtime.evaluate") {
			const evaluated: unknown = runInContext(String(params.expression), this.context)
			// An unawaited remote Promise does not contain its resolved by-value result.
			if (isPromise(evaluated) && params.awaitPromise !== true) {
				return { result: { type: "object", subtype: "promise" } } as T
			}
			const value = await evaluated
			return { result: { value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) } } as T
		}
		assert.equal(method, "Input.dispatchMouseEvent")
		this.input.push({ ...params })
		this.inputFrames.push(this.frame)
		// A real renderer may paint the portal between measuring it and the first trusted input event.
		if (params.type === "mouseMoved" && ["moving", "replaced"].includes(this.scenario) && this.frame < 3)
			this.frame = 3
		if (params.type === "mouseMoved" && this.scenario === "hover-moves") this.hovered = true
		if (params.type === "mousePressed") {
			this.mouseButtonHeld = true
			this.pressed = this.mouseHit(Number(params.x), Number(params.y))
		}
		if (params.type === "mouseReleased") {
			this.selected = this.pressed && this.mouseHit(Number(params.x), Number(params.y))
			this.pressed = false
			this.mouseButtonHeld = false
		}
		this.onInput?.(params)
		if (params.type === "mouseReleased") await this.onRelease?.()
		return {} as T
	}

	async paintUntilComplete<T>(operation: Promise<T>): Promise<T> {
		const complete = operation.then((value) => ({ kind: "complete" as const, value }))
		for (let attempt = 0; attempt < 64; attempt++) {
			const paint = new Promise<{ kind: "paint" }>((resolve) => {
				if (this.frames.length > 0) resolve({ kind: "paint" })
				else this.frameWaiters.push(() => resolve({ kind: "paint" }))
			})
			const event = await Promise.race([complete, paint])
			if (event.kind === "complete") return event.value
			this.paintFrame()
		}
		throw new Error("Control did not settle within the controlled paint sequence")
	}

	paintFrame(): void {
		this.frame++
		this.onPaint?.(this.frame)
		for (const callback of this.frames.splice(0)) callback(this.frame * 16)
	}

	async waitForFrame(): Promise<void> {
		if (this.frames.length > 0) return
		await new Promise<void>((resolve) => this.frameWaiters.push(resolve))
	}
}

/** Matches the CDP command's independent transport timeout without advancing the renderer's pending frame. */
class BoundedTransport implements Pick<CdpConnection, "request"> {
	readonly pending = new Set<object>()

	constructor(readonly renderer = new ControlledRenderer()) {}

	request<T>(method: string, params: Record<string, unknown> = {}, targetSession?: string): Promise<T> {
		const request = {}
		this.pending.add(request)
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(request)
				reject(new Error("CDP command timeout"))
			}, 5_000)
			this.renderer.request<T>(method, params, targetSession).then(
				(value) => {
					clearTimeout(timer)
					this.pending.delete(request)
					resolve(value)
				},
				(error) => {
					clearTimeout(timer)
					this.pending.delete(request)
					reject(error)
				},
			)
		})
	}
}

function observe(operation: Promise<unknown>) {
	const outcome = {
		settled: false,
		error: undefined as unknown,
		completion: Promise.resolve(),
	}
	outcome.completion = operation.then(
		() => {
			outcome.settled = true
		},
		(error: unknown) => {
			outcome.settled = true
			outcome.error = error
		},
	)
	return outcome
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

/** One event-loop boundary lets queued promise continuations finish without advancing fake time. */
const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve))

for (const interruption of ["deadline", "abort"] as const) {
	for (const lateOutcome of ["transport-timeout", "paint-completed"] as const) {
		test(`an undelivered paint frame obeys ${interruption} and handles late ${lateOutcome}`, async (context) => {
			context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 14_900 })
			const scheduled = context.mock.method(globalThis, "setTimeout")
			const cleared = context.mock.method(globalThis, "clearTimeout")
			const lateRejections: unknown[] = []
			const onUnhandled = (error: unknown) => lateRejections.push(error)
			process.on("unhandledRejection", onUnhandled)
			context.after(() => process.off("unhandledRejection", onUnhandled))
			const transport = new BoundedTransport()
			const controller = new AbortController()
			const reason = new Error("Cancelled while the renderer never paints")
			const { click } = createRenderedAcceptanceControls(transport, sessionId, controller.signal)
			const outcome = observe(click(optionExpression, 15_000))
			try {
				await transport.renderer.waitForFrame()
				context.mock.timers.tick(99)
				await flushMicrotasks()
				assert.equal(outcome.settled, false)
				if (interruption === "deadline") context.mock.timers.tick(1)
				else controller.abort(reason)
				await flushMicrotasks()
				assert.equal(
					outcome.settled,
					true,
					"The control must finish without painting or waiting for the transport",
				)
				if (interruption === "deadline") assert.match(String(outcome.error), /rendered_control_timeout/)
				else assert.equal(outcome.error, reason)
				assert.equal(transport.pending.size, 1, "The independent CDP request has not settled yet")
				assert.equal(transport.renderer.frame, 0)
				assert.deepEqual(transport.renderer.input, [])
				assert.equal(getEventListeners(controller.signal, "abort").length, 0)
				for (const timer of scheduled.mock.calls.filter((call) => call.arguments[1] !== 5_000)) {
					assert.ok(cleared.mock.calls.some((call) => call.arguments[0] === timer.result))
				}
				const finalError = outcome.error
				const finalRequestCount = transport.renderer.requests.length
				if (lateOutcome === "transport-timeout") context.mock.timers.tick(5_000)
				else transport.renderer.paintFrame()
				await flushMicrotasks()
				assert.equal(transport.pending.size, 0)
				assert.deepEqual(lateRejections, [])
				assert.deepEqual(transport.renderer.input, [])
				assert.equal(outcome.error, finalError)
				assert.equal(transport.renderer.requests.length, finalRequestCount)
			} finally {
				context.mock.timers.tick(5_000)
				await flushMicrotasks()
				await outcome.completion
			}
		})
	}
}

for (const interruption of ["deadline", "abort"] as const) {
	test(`a pending presence poll obeys ${interruption} without sending later requests`, async (context) => {
		context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 14_900 })
		const transport = new BoundedTransport()
		const controller = new AbortController()
		const reason = new Error("Cancelled during the presence poll")
		const { check } = createRenderedAcceptanceControls(transport, sessionId, controller.signal)
		const outcome = observe(check("false", 15_000))
		try {
			await flushMicrotasks()
			assert.equal(transport.renderer.requests.length, 1)
			context.mock.timers.tick(99)
			await flushMicrotasks()
			assert.equal(outcome.settled, false)
			if (interruption === "deadline") context.mock.timers.tick(1)
			else controller.abort(reason)
			await flushMicrotasks()
			assert.equal(outcome.settled, true)
			if (interruption === "deadline") assert.match(String(outcome.error), /rendered_control_timeout/)
			else assert.equal(outcome.error, reason)
			assert.equal(getEventListeners(controller.signal, "abort").length, 0)
			const finalRequestCount = transport.renderer.requests.length
			context.mock.timers.tick(5_000)
			await flushMicrotasks()
			assert.equal(transport.renderer.requests.length, finalRequestCount)
			assert.deepEqual(transport.renderer.input, [])
		} finally {
			context.mock.timers.tick(5_000)
			await flushMicrotasks()
			await outcome.completion
		}
	})
}

for (const interruption of ["deadline", "abort"] as const) {
	test(`mouse release retains its transport bound after the press ${interruption}`, async (context) => {
		context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 14_900 })
		const transport = new BoundedTransport()
		const controller = new AbortController()
		const released = deferred<void>()
		const releaseResponse = deferred<void>()
		const reason = new Error("Cancelled after the trusted press")
		transport.renderer.onInput = (input) => {
			if (input.type !== "mousePressed") return
			if (interruption === "deadline") context.mock.timers.tick(100)
			else controller.abort(reason)
		}
		transport.renderer.onRelease = () => {
			released.resolve()
			return releaseResponse.promise
		}
		const { click } = createRenderedAcceptanceControls(transport, sessionId, controller.signal)
		const outcome = observe(transport.renderer.paintUntilComplete(click(optionExpression, 15_000)))
		try {
			await released.promise
			await flushMicrotasks()
			assert.equal(outcome.settled, false, "The mandatory release must await its independent transport response")
			assert.equal(getEventListeners(controller.signal, "abort").length, 0)
			assert.equal(transport.renderer.mouseButtonHeld, false)
			assert.equal(transport.renderer.input.filter((input) => input.type === "mouseReleased").length, 1)
			context.mock.timers.tick(4_999)
			await flushMicrotasks()
			assert.equal(outcome.settled, false)
			context.mock.timers.tick(1)
			await flushMicrotasks()
			assert.equal(outcome.settled, true)
			assert.match(String(outcome.error), /CDP command timeout/)
		} finally {
			releaseResponse.resolve()
			context.mock.timers.tick(5_000)
			await flushMicrotasks()
			await outcome.completion
		}
	})
}

for (const interruption of ["deadline", "abort"] as const) {
	test(`${interruption} before press dispatch cannot send an unpaired mouse release`, async (context) => {
		context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 14_900 })
		let unsentPresses = 0
		// Explore adjacent promise-continuation phases after the final controlled paint, observing only CDP inputs.
		for (let phase = 0; phase <= 32; phase++) {
			const renderer = new ControlledRenderer()
			const controller = new AbortController()
			const reason = new Error("Cancelled before dispatching the press")
			const interruptAfter = (remaining: number) =>
				queueMicrotask(() => {
					if (remaining > 0) interruptAfter(remaining - 1)
					else if (interruption === "deadline") context.mock.timers.tick(100)
					else controller.abort(reason)
				})
			renderer.onPaint = (frame) => {
				if (frame === 6) interruptAfter(phase)
			}
			const { click } = createRenderedAcceptanceControls(renderer, sessionId, controller.signal)
			const outcome = observe(renderer.paintUntilComplete(click(optionExpression, Date.now() + 100)))
			await outcome.completion
			await flushMicrotasks()
			const presses = renderer.input.filter((input) => input.type === "mousePressed").length
			const releases = renderer.input.filter((input) => input.type === "mouseReleased").length
			assert.ok(presses <= 1)
			assert.equal(releases, presses, `Continuation phase ${phase} must release exactly the attempted press`)
			if (presses === 0) {
				unsentPresses++
				if (interruption === "deadline") assert.match(String(outcome.error), /rendered_control_timeout/)
				else assert.equal(outcome.error, reason)
			}
			assert.equal(renderer.mouseButtonHeld, false)
			assert.equal(getEventListeners(controller.signal, "abort").length, 0)
		}
		assert.ok(unsentPresses > 0, "The controlled phases must include interruption before press dispatch")
	})
}

test("rendered evaluations return the value after an explicit two-frame paint barrier", async () => {
	const renderer = new ControlledRenderer()
	const { evaluate } = createRenderedAcceptanceControls(renderer, sessionId)
	const result = await renderer.paintUntilComplete(
		evaluate<boolean>(
			"new Promise(resolve=>d.defaultView.requestAnimationFrame(()=>d.defaultView.requestAnimationFrame(()=>resolve(true))))",
		),
	)
	assert.equal(result, true)
	assert.equal(renderer.frame, 2)
})

for (const scenario of [
	"moving",
	"covered",
	"replaced",
	"replaced-document",
	"finite-animation",
	"infinite-animation",
] as const) {
	test(`trusted rendered option clicks wait for the ${scenario} portal to be hittable`, async () => {
		const renderer = new ControlledRenderer(scenario)
		const { click } = createRenderedAcceptanceControls(renderer, sessionId)
		await renderer.paintUntilComplete(click(optionExpression))
		assert.equal(renderer.selected, true, "The requested Large option must receive the trusted press and release")
		const readyFrame = scenario === "finite-animation" ? 4 : scenario === "infinite-animation" ? 0 : 3
		assert.ok(
			renderer.inputFrames.every((frame) => frame >= readyFrame),
			"No trusted input may precede target readiness",
		)
		assert.deepEqual(
			renderer.input.map((input) => input.type),
			["mouseMoved", "mousePressed", "mouseReleased"],
		)
		for (const input of renderer.input) {
			assert.equal(input.x, 484)
			assert.equal(input.y, 172)
		}
	})
}

test("trusted input retargets an option that moves after pointer hover", async () => {
	const renderer = new ControlledRenderer("hover-moves")
	const { click } = createRenderedAcceptanceControls(renderer, sessionId)
	await renderer.paintUntilComplete(click(optionExpression))
	assert.equal(renderer.selected, true)
	const firstInput = renderer.input[0]
	assert.ok(firstInput)
	assert.equal(firstInput.type, "mouseMoved")
	assert.equal(firstInput.y, 272)
	assert.equal(renderer.input.filter((input) => input.type === "mousePressed").length, 1)
	assert.equal(renderer.input.filter((input) => input.type === "mouseReleased").length, 1)
	for (const input of renderer.input.slice(-2)) {
		assert.equal(input.x, 484)
		assert.equal(input.y, 172)
	}
})

test("an expired control deadline fails before scrolling, painting, or sending input", async () => {
	const renderer = new ControlledRenderer()
	const { click } = createRenderedAcceptanceControls(renderer, sessionId)
	await assert.rejects(click(optionExpression, 0), /rendered_control_timeout/)
	assert.deepEqual(renderer.requests, [])
	assert.deepEqual(renderer.input, [])
	assert.equal(renderer.frame, 0)
})

test("aborting during awaited portal paint prevents trusted input", async () => {
	const renderer = new ControlledRenderer()
	const controller = new AbortController()
	const reason = new Error("Cancelled during portal paint")
	renderer.onPaint = (frame) => {
		if (frame === 1) controller.abort(reason)
	}
	const { click } = createRenderedAcceptanceControls(renderer, sessionId, controller.signal)
	await assert.rejects(renderer.paintUntilComplete(click(optionExpression)), (error) => error === reason)
	assert.deepEqual(renderer.input, [])
})

for (const failure of ["cancelled", "transport-failed"] as const) {
	test(`a ${failure} trusted press still releases the renderer mouse button`, async () => {
		const renderer = new ControlledRenderer()
		const controller = new AbortController()
		const reason = new Error(failure)
		renderer.onInput = (input) => {
			if (input.type !== "mousePressed") return
			if (failure === "cancelled") controller.abort(reason)
			else throw reason
		}
		const { click } = createRenderedAcceptanceControls(renderer, sessionId, controller.signal)
		await assert.rejects(renderer.paintUntilComplete(click(optionExpression)), (error) => error === reason)
		assert.equal(renderer.mouseButtonHeld, false)
		assert.equal(renderer.input.filter((input) => input.type === "mouseReleased").length, 1)
		assert.deepEqual(renderer.input.at(-1), {
			type: "mouseReleased",
			x: 484,
			y: 172,
			button: "left",
			buttons: 0,
			clickCount: 1,
		})
	})
}
