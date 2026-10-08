import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { CdpConnection } from "./cdp"
import { waitUntil } from "../evidence/sharedStorageProtocol"

/** Verify native textarea scrolling in the reference Chromium renderer with no model requests. */
export async function exerciseRenderedComposer(
	cdp: CdpConnection,
	sessionId: string,
	workbenchSession: string,
	directory: string,
	_nonce: string,
	signal?: AbortSignal,
): Promise<string[]> {
	await cdp.request("Page.bringToFront", {}, workbenchSession)
	const evaluate = async <T>(expression: string): Promise<T> => {
		signal?.throwIfAborted()
		const result = await cdp.request<{ result: { value: T }; exceptionDetails?: unknown }>(
			"Runtime.evaluate",
			{
				expression: `(()=>{const d=document.getElementById('active-frame')?.contentDocument??document;return (${expression})})()`,
				returnByValue: true,
			},
			sessionId,
		)
		assert.equal(result.exceptionDetails, undefined)
		return result.result.value
	}
	await waitUntil(
		() => evaluate<boolean>("!!d.querySelector('.new-task-composer textarea')"),
		Date.now() + 15_000,
		"composer_render_timeout",
	)
	assert.equal(
		await evaluate<boolean>(
			"(()=>{const e=d.querySelector('.new-task-composer textarea');e.focus();return d.activeElement===e})()",
		),
		true,
	)
	const text = Array.from({ length: 45 }, (_, i) => `@/fixture-${i}.ts line ${i}`).join("\n")
	await cdp.request("Input.insertText", { text }, sessionId)
	await waitUntil(
		() => evaluate<boolean>(`d.querySelector('.new-task-composer textarea').value===${JSON.stringify(text)}`),
		Date.now() + 10_000,
		"composer_input_timeout",
	)
	const observations: unknown[] = []
	for (const fraction of [1, 0.5, 0, 1]) {
		const metrics = await evaluate<{
			scrollTop: number
			highlightScrollTop: number
			clientHeight: number
			highlightClientHeight: number
			scrollHeight: number
			radii: string[]
		}>(
			`(()=>{const e=d.querySelector('.new-task-composer textarea');const h=d.querySelector('[data-testid=highlight-layer]');e.scrollTop=(e.scrollHeight-e.clientHeight)*${fraction};e.dispatchEvent(new Event('scroll'));return {scrollTop:e.scrollTop,highlightScrollTop:h.scrollTop,clientHeight:e.clientHeight,highlightClientHeight:h.clientHeight,scrollHeight:e.scrollHeight,radii:[e,h,e.parentElement].map(x=>d.defaultView.getComputedStyle(x).borderBottomLeftRadius)}})()`,
		)
		observations.push(metrics)
		await fs.writeFile(path.join(directory, "ui-composer-metrics.json"), JSON.stringify(observations, null, 2))
		const screenshot = await cdp.request<{ data: string }>(
			"Page.captureScreenshot",
			{ format: "png" },
			workbenchSession,
		)
		await fs.writeFile(
			path.join(directory, `ui-composer-scroll-${fraction}.png`),
			Buffer.from(screenshot.data, "base64"),
		)
		assert.ok(metrics.scrollHeight > metrics.clientHeight, "fixture must exercise native overflow")
		assert.deepEqual(metrics.radii, ["0px", "0px", "0px"], "inner text viewport must not clip rounded corners")
		assert.ok(Math.abs(metrics.scrollTop - metrics.highlightScrollTop) <= 1, "highlight scroll must match text")
		assert.equal(metrics.highlightClientHeight, metrics.clientHeight)
	}
	// Route native wheel input through the workbench using the observed webview frame bounds.
	const { frameTree } = await cdp.request<{ frameTree: { frame: { id: string } } }>(
		"Page.getFrameTree",
		{},
		sessionId,
	)
	const { backendNodeId } = await cdp.request<{ backendNodeId: number }>(
		"DOM.getFrameOwner",
		{ frameId: frameTree.frame.id },
		workbenchSession,
	)
	const { model } = await cdp.request<{ model: { content: number[] } }>(
		"DOM.getBoxModel",
		{ backendNodeId },
		workbenchSession,
	)
	const point = await evaluate<{ x: number; y: number; scrollTop: number }>(
		"(()=>{const e=d.querySelector('.new-task-composer textarea');const r=e.getBoundingClientRect();const f=document.getElementById('active-frame')?.getBoundingClientRect();return {x:r.left+r.width/2+(f?.left??0),y:r.top+r.height/2+(f?.top??0),scrollTop:e.scrollTop}})()",
	)
	const [originX, originY] = model.content
	assert.ok(typeof originX === "number" && typeof originY === "number")
	const x = originX + point.x
	const y = originY + point.y
	assert.ok(Number.isFinite(x) && Number.isFinite(y))
	await fs.writeFile(
		path.join(directory, "ui-composer-wheel.json"),
		JSON.stringify({ x, y, before: point.scrollTop }),
	)
	await cdp.request("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, workbenchSession)
	await cdp.request(
		"Input.dispatchMouseEvent",
		{ type: "mouseWheel", x, y, deltaX: 0, deltaY: -180 },
		workbenchSession,
	)
	await waitUntil(
		() =>
			evaluate<boolean>(
				`(()=>{const e=d.querySelector('.new-task-composer textarea');const h=d.querySelector('[data-testid=highlight-layer]');return e.scrollTop<${point.scrollTop}&&Math.abs(e.scrollTop-h.scrollTop)<=1})()`,
			),
		Date.now() + 5000,
		"composer_wheel_scroll_timeout",
	)
	await fs.writeFile(
		path.join(directory, "ui-composer-wheel.json"),
		JSON.stringify({
			x,
			y,
			before: point.scrollTop,
			after: await evaluate<number>("d.querySelector('.new-task-composer textarea').scrollTop"),
		}),
	)
	return [
		"composer-overflow",
		"composer-scroll-alignment",
		"composer-square-viewport",
		"composer-native-wheel-scroll",
	]
}
