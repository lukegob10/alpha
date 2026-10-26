import * as assert from "node:assert/strict"
import { test } from "node:test"
import { runInNewContext } from "node:vm"
import {
	dismissRenderedDialogAndRestoreFocus,
	dialogKeyTraceExpression,
	verifyRenderedDialogFocus,
	type RenderedDialogFocusDriver,
} from "./renderedDialogFocus"

function fixture(
	mutation?: "name" | "role" | "modal" | "entry" | "trap" | "restore",
	requestAnimationFrame = (callback: () => void) => callback(),
) {
	let open = true
	const opener = {}
	let active: unknown = opener
	const controls = Array.from({ length: 2 }, () => {
		const control = {
			tabIndex: 0,
			disabled: false,
			getAttribute: () => null,
			getClientRects: () => [{}],
			focus() {
				active = control
			},
		}
		return control
	})
	if (mutation !== "entry") active = controls[0]
	const attributes: Record<string, string> = {
		role: mutation === "role" ? "region" : "dialog",
		"aria-modal": mutation === "modal" ? "false" : "true",
		"aria-labelledby": "title",
	}
	const dialog = {
		getAttribute: (name: string) => attributes[name] ?? null,
		contains: (element: unknown) => controls.includes(element as (typeof controls)[number]),
		querySelectorAll: () => controls,
	}
	const document = {
		get activeElement() {
			return active
		},
		opener,
		querySelector: () => (open ? dialog : null),
		getElementById: () => ({ textContent: mutation === "name" ? "" : "Preview" }),
		defaultView: { getComputedStyle: () => ({ visibility: "visible", display: "block" }), requestAnimationFrame },
	}
	const driver: RenderedDialogFocusDriver = {
		async evaluate<T>(expression: string) {
			return runInNewContext(expression, { d: document }, { timeout: 100 }) as T
		},
		async check(expression) {
			assert.equal(await driver.evaluate(expression), true, `Renderer check failed: ${expression}`)
		},
		async key(key, shift) {
			if (key === "Escape") {
				open = false
				active = mutation === "restore" ? undefined : opener
			} else if (mutation === "trap") active = opener
			else active = controls[shift ? controls.length - 1 : 0]
		},
	}
	return driver
}

test("dialog oracle checks accessible semantics, entry, both tab boundaries, Escape and its opener", async () => {
	const driver = fixture()
	await verifyRenderedDialogFocus(driver, "[role=dialog]", "Preview")
	await dismissRenderedDialogAndRestoreFocus(driver, "[role=dialog]", "d.opener")
})

test("observed autofocus does not dispatch input before two renderer paint opportunities", async () => {
	const frames: Array<() => void> = []
	let frameScheduled!: () => void
	const firstFrame = new Promise<void>((resolve) => (frameScheduled = resolve))
	const driver = fixture(undefined, (callback) => {
		frames.push(callback)
		frameScheduled()
	})
	const keys: string[] = []
	const key = driver.key
	driver.key = async (...args) => {
		keys.push(args[0])
		await key(...args)
	}
	const verification = verifyRenderedDialogFocus(driver, "[role=dialog]", "Preview")
	await firstFrame
	assert.equal(keys.length, 0)
	frames.shift()!()
	await Promise.resolve()
	assert.equal(keys.length, 0, "One frame must not release keyboard input during registration propagation")
	frames.shift()!()
	await verification
	assert.deepEqual(keys, ["Tab", "Tab"])
})

for (const mutation of ["name", "role", "modal", "entry", "trap"] as const) {
	test(`dialog oracle rejects a missing ${mutation} invariant`, async () => {
		await assert.rejects(verifyRenderedDialogFocus(fixture(mutation), "[role=dialog]", "Preview"))
	})
}

test("Escape dismissal alone cannot pass when return focus is lost", async () => {
	await assert.rejects(dismissRenderedDialogAndRestoreFocus(fixture("restore"), "[role=dialog]", "d.opener"))
})

test("key diagnostics retain only requested delivery phases and visible layer metadata, then dispose", () => {
	type Listener = (event: object) => void
	const target = () => {
		const listeners = new Map<string, Listener>()
		return {
			listeners,
			addEventListener: (type: string, listener: Listener, capture: boolean) =>
				listeners.set(`${type}:${capture}`, listener),
			removeEventListener: (type: string, _listener: Listener, capture: boolean) =>
				listeners.delete(`${type}:${capture}`),
		}
	}
	const window = {
		...target(),
		performance: { now: () => 10 },
		getComputedStyle: () => ({ display: "block", visibility: "visible" }),
	}
	const element = (role: string) => ({
		tagName: "DIV",
		id: role,
		textContent: role,
		getAttribute: (name: string) => (name === "role" ? role : name === "data-state" ? "open" : null),
	})
	const dialog = element("alertdialog")
	const tooltip = element("tooltip")
	const document = {
		...target(),
		defaultView: window,
		hasFocus: () => true,
		activeElement: dialog,
		querySelectorAll: () => [dialog, tooltip],
	}
	const context = { d: document, document }
	runInNewContext(dialogKeyTraceExpression("Escape", "install"), context)
	const event = { key: "Escape", type: "keydown", isTrusted: true, defaultPrevented: false, target: dialog }
	for (const node of [window, document]) {
		for (const listener of node.listeners.values()) listener({ ...event, key: "private-other-key" })
	}
	window.listeners.get("keydown:true")!(event)
	document.listeners.get("keydown:true")!({ ...event, defaultPrevented: true })
	document.listeners.get("keydown:false")!({ ...event, defaultPrevented: true })
	window.listeners.get("keydown:false")!({ ...event, defaultPrevented: true })
	const result = runInNewContext(dialogKeyTraceExpression("Escape", "collect"), context)
	assert.equal(result.events.length, 4)
	assert.deepEqual(
		Array.from(result.events, (entry: { point: string }) => entry.point),
		["window-capture", "document-capture", "document-bubble", "window-bubble"],
	)
	assert.equal(result.events[0].defaultPrevented, false)
	assert.equal(result.events[1].defaultPrevented, true)
	assert.equal(result.before.layers[1].role, "tooltip")
	assert.equal(window.listeners.size + document.listeners.size, 0)
	assert.equal(runInNewContext(dialogKeyTraceExpression("Escape", "collect"), context).missing, true)
})
