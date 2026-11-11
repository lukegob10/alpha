import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test, type TestContext } from "node:test"
import { runInNewContext } from "node:vm"
import type { CdpConnection } from "./cdp"
import { dismissRenderedReleaseAnnouncement } from "./renderedReleaseAnnouncement"

async function fixture(
	t: TestContext,
	options: {
		title?: string
		missing?: boolean
		alert?: boolean
		missingClose?: boolean
		blockedFocus?: boolean
		remainsOpen?: boolean
		delayedMount?: boolean
		innerFrame?: boolean
		afterEvaluate?: (value: unknown, keyEvents: number) => void
	} = {},
) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-release-fixture-"))
	t.after(() => fs.rm(directory, { recursive: true, force: true }))
	let open = !options.missing && !options.delayedMount
	let paints = 0
	let active: unknown
	const keys: Array<{ sessionId?: string; params: Record<string, unknown> }> = []
	const close = {
		textContent: "Close",
		focus: () => {
			if (!options.blockedFocus) active = close
		},
	}
	const dialog = {
		querySelector: () => ({ textContent: options.title ?? "Welcome to Alpha v3.2.24" }),
		querySelectorAll: () => (options.missingClose ? [] : [close]),
	}
	const document = {
		get activeElement() {
			return active
		},
		getElementById: () => undefined,
		querySelectorAll: () => (open && !options.alert ? [dialog] : []),
		querySelector: () => (open ? dialog : null),
		defaultView: {
			requestAnimationFrame: (callback: () => void) => {
				paints++
				if (options.delayedMount && paints === 2) open = true
				callback()
			},
		},
	}
	const outerDocument = options.innerFrame ? { getElementById: () => ({ contentDocument: document }) } : document
	const cdp: Pick<CdpConnection, "request"> = {
		async request<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
			if (method === "Runtime.evaluate") {
				assert.equal(sessionId, "webview")
				assert.equal(params.awaitPromise, true)
				const value: unknown = await runInNewContext(
					String(params.expression),
					{ document: outerDocument },
					{ timeout: 100 },
				)
				options.afterEvaluate?.(value, keys.length)
				return { result: { value } } as T
			}
			if (method === "Page.captureScreenshot") {
				assert.equal(sessionId, "workbench")
				assert.equal(open, true, "Evidence must capture the release dialog before dismissal")
				return { data: Buffer.from("release screenshot").toString("base64") } as T
			}
			assert.equal(method, "Input.dispatchKeyEvent")
			assert.equal(active, close, "Native input must target the observed Close button")
			assert.equal(
				await fs.readFile(path.join(directory, "ui-chat-release-announcement.png"), "utf8"),
				"release screenshot",
			)
			keys.push({ sessionId, params })
			if (params.type === "keyUp" && !options.remainsOpen) open = false
			return {} as T
		},
	}
	return {
		directory,
		keys,
		get paints() {
			return paints
		},
		run: (signal?: AbortSignal) =>
			dismissRenderedReleaseAnnouncement(cdp, "webview", "workbench", directory, "chat", signal),
	}
}

for (const innerFrame of [false, true]) {
	test(`release setup uses native Close input and retains evidence (${innerFrame ? "inner" : "direct"} document)`, async (t) => {
		const driver = await fixture(t, { innerFrame })
		await driver.run()
		assert.equal(driver.paints, 2)
		assert.deepEqual(driver.keys, [
			{
				sessionId: "webview",
				params: { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
			},
			{
				sessionId: "webview",
				params: { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
			},
		])
	})
}

test("release setup allows the chat navigation effect to mount its announcement", async (t) => {
	const driver = await fixture(t, { delayedMount: true })
	await driver.run()
	assert.equal(driver.keys.length, 2)
})

test("release setup sends no input or screenshot when there is no dialog", async (t) => {
	const driver = await fixture(t, { missing: true })
	await driver.run()
	assert.deepEqual(driver.keys, [])
	assert.deepEqual(await fs.readdir(driver.directory), [])
})

for (const options of [{ title: "Welcome to Alpha" }, { title: "Apply Worker changes?" }, { alert: true }]) {
	test(`release setup leaves unexpected ${JSON.stringify(options)} dialogs fail-visible`, async (t) => {
		const driver = await fixture(t, options)
		await assert.rejects(driver.run(), /unexpected chat setup dialog/)
		assert.deepEqual(driver.keys, [])
	})
}

for (const options of [{ missingClose: true }, { blockedFocus: true }]) {
	test(`release setup rejects ${JSON.stringify(options)} before native input`, async (t) => {
		const driver = await fixture(t, options)
		await assert.rejects(driver.run(), /release announcement Close must own keyboard focus/)
		assert.deepEqual(driver.keys, [])
	})
}

test("release setup requires observed disappearance after native input", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1000 })
	const driver = await fixture(t, {
		remainsOpen: true,
		afterEvaluate: (value, keyEvents) => {
			if (keyEvents === 2 && value === false) t.mock.timers.tick(5001)
		},
	})
	await assert.rejects(driver.run(), /chat_announcement_dismiss_timeout/)
	assert.equal(driver.keys.length, 2)
})

test("release setup honors cancellation before renderer work", async (t) => {
	const driver = await fixture(t)
	await assert.rejects(driver.run(AbortSignal.abort()), { name: "AbortError" })
	assert.equal(driver.paints, 0)
	assert.deepEqual(driver.keys, [])
})
