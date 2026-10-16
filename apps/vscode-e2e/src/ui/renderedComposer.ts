import { javascriptLiteral } from "./javascriptLiteral"
import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { CdpConnection } from "./cdp"
import { requireNativeChatHeader } from "./nativeChatHeader"
import { waitUntil } from "../evidence/sharedStorageProtocol"

interface ComposerSendState {
	disabled: boolean
	opacity: number
	display: string
	visibility: string
	cursor: string
	sameButton: boolean
	bounds: { left: number; top: number; width: number; height: number }
	corner: { right: number; bottom: number }
}

/** Verify native textarea scrolling in the reference Chromium renderer with no model requests. */
export async function exerciseRenderedComposer(
	cdp: CdpConnection,
	sessionId: string,
	workbenchSession: string,
	directory: string,
	nonce: string,
	signal?: AbortSignal,
): Promise<string[]> {
	await cdp.request("Page.bringToFront", {}, workbenchSession)
	const evaluate = async <T>(expression: string, targetSession = sessionId): Promise<T> => {
		signal?.throwIfAborted()
		const result = await cdp.request<{ result: { value: T }; exceptionDetails?: unknown }>(
			"Runtime.evaluate",
			{
				expression: `(()=>{const d=document.getElementById('active-frame')?.contentDocument??document;return (${expression})})()`,
				returnByValue: true,
			},
			targetSession,
		)
		assert.equal(result.exceptionDetails, undefined)
		return result.result.value
	}
	await waitUntil(
		() => evaluate<boolean>("!!d.querySelector('.new-task-composer textarea')"),
		Date.now() + 15_000,
		"composer_render_timeout",
	)
	const nativeHeader = await requireNativeChatHeader(cdp, workbenchSession)
	const webviewToolbarCount = await evaluate<number>("d.querySelectorAll('.chat-toolbar').length")
	assert.equal(webviewToolbarCount, 0, "empty sidebar must not reserve a duplicate webview toolbar row")
	const toolbar = { placement: "native-sidebar", nativeHeader, webviewToolbarCount }
	const referenceKey = javascriptLiteral(`alpha-composer-send-${nonce}`)
	const readSend = (remember = false) =>
		evaluate<ComposerSendState | null>(
			`(()=>{const c=d.querySelector('.new-task-composer');const e=[...c.querySelectorAll('button[aria-label]')].find(b=>/^Press .+ to send$/.test(b.getAttribute('aria-label')));if(!e)return null;const w=d.defaultView;if(${remember})w[${referenceKey}]=e;const s=w.getComputedStyle(e),r=e.getBoundingClientRect(),p=c.getBoundingClientRect();return {disabled:e.disabled,opacity:Number(s.opacity),display:s.display,visibility:s.visibility,cursor:s.cursor,sameButton:w[${referenceKey}]===e,bounds:{left:r.left,top:r.top,width:r.width,height:r.height},corner:{right:p.right-r.right,bottom:p.bottom-r.bottom}}})()`,
		)
	let emptySend = await readSend(true)
	assert.ok(emptySend, "empty composer must render Send")
	await waitUntil(
		async () => {
			const next = await readSend()
			assert.ok(next, "empty composer must retain Send")
			const stable = JSON.stringify(next.bounds) === JSON.stringify(emptySend?.bounds)
			emptySend = next
			return stable && next.bounds.width > 0 && next.bounds.height > 0
		},
		Date.now() + 5000,
		"composer_empty_send_geometry_timeout",
	)
	assert.ok(emptySend.disabled, "empty Send must be natively disabled")
	assert.ok(emptySend.opacity > 0 && emptySend.opacity < 1, "empty Send must remain visible and muted")
	assert.notEqual(emptySend.display, "none")
	assert.equal(emptySend.visibility, "visible")
	assert.equal(emptySend.cursor, "default", "empty Send must use the normal cursor")
	const emptyScreenshot = await cdp.request<{ data: string }>(
		"Page.captureScreenshot",
		{ format: "png" },
		workbenchSession,
	)
	await fs.writeFile(path.join(directory, "ui-composer-empty-send.png"), Buffer.from(emptyScreenshot.data, "base64"))
	assert.equal(
		await evaluate<boolean>(
			"(()=>{const e=d.querySelector('.new-task-composer textarea');e.focus();return d.activeElement===e})()",
		),
		true,
	)
	const text = Array.from({ length: 45 }, (_, i) => `@/fixture-${i}.ts line ${i}`).join("\n")
	await cdp.request("Input.insertText", { text }, sessionId)
	await waitUntil(
		() => evaluate<boolean>(`d.querySelector('.new-task-composer textarea').value===${javascriptLiteral(text)}`),
		Date.now() + 10_000,
		"composer_input_timeout",
	)
	await waitUntil(
		async () => {
			const state = await readSend()
			return !!state && !state.disabled && state.opacity >= 0.99
		},
		Date.now() + 5000,
		"composer_ready_send_timeout",
	)
	const readySend = await readSend()
	await evaluate(`delete d.defaultView[${referenceKey}]`)
	assert.ok(readySend)
	assert.equal(readySend.disabled, false, "typed content must enable Send")
	assert.equal(readySend.cursor, "pointer", "ready Send must use the action cursor")
	assert.equal(readySend.sameButton, true, "typing must retain the same Send button")
	assert.ok(readySend.opacity > emptySend.opacity, "ready Send must be brighter than empty Send")
	for (const key of ["width", "height"] as const) {
		assert.ok(Math.abs(readySend.bounds[key] - emptySend.bounds[key]) <= 1, "Send size must remain stable")
	}
	// Multiline input grows the textarea; Send retains its position relative to the composer's bottom-right corner.
	for (const key of ["right", "bottom"] as const) {
		assert.ok(
			Math.abs(readySend.corner[key] - emptySend.corner[key]) <= 1,
			"Send corner position must remain stable",
		)
	}
	await fs.writeFile(
		path.join(directory, "ui-composer-send-state.json"),
		JSON.stringify({ toolbar, emptySend, readySend }, null, 2),
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
	const { targetInfos: priorTargets } = await cdp.request<{
		targetInfos: Array<{ targetId: string; url: string }>
	}>("Target.getTargets")
	const priorTargetIds = new Set(priorTargets.map((target) => target.targetId))
	await fs.writeFile(path.join(directory, "ui-composer-sidebar-done.json"), JSON.stringify({ nonce }), { flag: "wx" })
	await waitUntil(
		async () => {
			signal?.throwIfAborted()
			try {
				const receipt = JSON.parse(
					await fs.readFile(path.join(directory, "ui-composer-editor-ready.json"), "utf8"),
				)
				assert.equal(receipt.nonce, nonce)
				assert.equal(receipt.version, "1.125.0")
				return true
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
				throw error
			}
		},
		Date.now() + 20_000,
		"composer_editor_ready_timeout",
	)
	let editorSession: string | undefined
	await waitUntil(
		async () => {
			signal?.throwIfAborted()
			const { targetInfos } = await cdp.request<{ targetInfos: Array<{ targetId: string; url: string }> }>(
				"Target.getTargets",
			)
			for (const target of targetInfos.filter(
				(entry) => !priorTargetIds.has(entry.targetId) && entry.url.includes("extensionId=AlphaInc.alpha"),
			)) {
				const attached = await cdp.request<{ sessionId: string }>("Target.attachToTarget", {
					targetId: target.targetId,
					flatten: true,
				})
				if (
					await evaluate<boolean>(
						"!!d.querySelector('.chat-toolbar button[aria-label=\"New chat\"]')",
						attached.sessionId,
					)
				) {
					editorSession = attached.sessionId
					return true
				}
			}
			return false
		},
		Date.now() + 15_000,
		"composer_editor_toolbar_timeout",
	)
	assert.ok(editorSession)
	const editorToolbar = await evaluate<{ count: number; labels: string[]; iconSizes: number[] }>(
		"(()=>{const bars=[...d.querySelectorAll('.chat-toolbar')];return {count:bars.length,labels:bars.flatMap(t=>[...t.querySelectorAll('button')].map(b=>b.getAttribute('aria-label'))),iconSizes:bars.flatMap(t=>[...t.querySelectorAll('button > svg')].map(s=>s.getBoundingClientRect().width))}})()",
		editorSession,
	)
	assert.equal(editorToolbar.count, 1, "editor must retain exactly one fallback action toolbar")
	assert.deepEqual(editorToolbar.labels, ["New chat", "Settings", "Alpha Tickets", "More actions"])
	assert.ok(editorToolbar.iconSizes.length >= 3 && editorToolbar.iconSizes.every((size) => size === 17))
	const editorTitleActions = await cdp.request<{ result: { value: string[] }; exceptionDetails?: unknown }>(
		"Runtime.evaluate",
		{
			expression:
				"[...document.querySelectorAll('.part.editor .title-actions .action-label')].map(e=>e.getAttribute('aria-label')||e.getAttribute('title')||'').filter(s=>/^(?:New Chat|Settings|(?:Alpha:\\s*)?Tickets)(?:\\s*\\(|$)/i.test(s))",
			returnByValue: true,
		},
		workbenchSession,
	)
	assert.equal(editorTitleActions.exceptionDetails, undefined)
	assert.deepEqual(editorTitleActions.result.value, [], "native editor title must not duplicate fallback actions")
	await fs.writeFile(
		path.join(directory, "ui-composer-editor-toolbar.json"),
		JSON.stringify({ editorToolbar, nativeEditorTitleDuplicates: editorTitleActions.result.value }, null, 2),
	)
	const editorScreenshot = await cdp.request<{ data: string }>(
		"Page.captureScreenshot",
		{ format: "png" },
		workbenchSession,
	)
	await fs.writeFile(
		path.join(directory, "ui-composer-editor-toolbar.png"),
		Buffer.from(editorScreenshot.data, "base64"),
	)
	return [
		"composer-persistent-send",
		"composer-native-sidebar-header",
		"composer-editor-toolbar-fallback",
		"composer-overflow",
		"composer-scroll-alignment",
		"composer-square-viewport",
		"composer-native-wheel-scroll",
	]
}
