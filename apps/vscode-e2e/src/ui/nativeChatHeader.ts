import * as assert from "node:assert/strict"

import { waitUntil } from "../evidence/sharedStorageProtocol"
import type { CdpConnection } from "./cdp"

/** Both merged view titles and individual pane headers are supported by the reference workbench. */
export const nativeChatHeaderExpression = `(()=>{const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility==='visible'};return [...document.querySelectorAll('.part > .title,.pane-header')].find(e=>visible(e)&&[e.querySelector('.title-label h2,.title-label,.title')?.textContent,e.getAttribute('aria-label'),e.innerText].some(t=>t?.trim().toUpperCase()==='ALPHA'))})()`

interface Bounds {
	left: number
	top: number
	width: number
	height: number
}

export interface NativeChatHeader {
	bounds: Bounds
	sidebarBounds: Bounds
	actions: Array<{ label: string; className: string; bounds: Bounds }>
}

export type NativeChatHeaderAction = "new-chat" | "settings" | "tickets" | "more"

function actionMatches(action: NativeChatHeader["actions"][number], name: NativeChatHeaderAction) {
	switch (name) {
		case "new-chat":
			return /^new chat(?:\s*\(|$)/i.test(action.label)
		case "settings":
			return /^settings(?:\s*\(|$)/i.test(action.label)
		case "tickets":
			return /^(?:alpha:\s*)?tickets(?:\s*\(|$)/i.test(action.label)
		case "more":
			return /more actions/i.test(action.label) || /codicon-(?:toolbar-)?more\b/.test(action.className)
	}
}

export async function readNativeChatHeader(cdp: CdpConnection, workbenchSession: string) {
	const result = await cdp.request<{ result: { value: NativeChatHeader | null }; exceptionDetails?: unknown }>(
		"Runtime.evaluate",
		{
			expression: `(()=>{const h=${nativeChatHeaderExpression};if(!h)return null;const bounds=e=>{const r=e.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height}};return {bounds:bounds(h),sidebarBounds:bounds(h.closest('.part')??h.closest('.pane')??h),actions:[...h.querySelectorAll('.action-label')].filter(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility==='visible'}).map(e=>({label:e.getAttribute('aria-label')||e.getAttribute('title')||e.textContent||'',className:String(e.className),bounds:bounds(e)}))}})()`,
			returnByValue: true,
		},
		workbenchSession,
	)
	assert.equal(result.exceptionDetails, undefined)
	return result.result.value
}

export async function requireNativeChatHeader(cdp: CdpConnection, workbenchSession: string) {
	let observed: NativeChatHeader | null = null
	await waitUntil(
		async () => {
			const next = await readNativeChatHeader(cdp, workbenchSession)
			observed = next
			return (
				!!next &&
				(["new-chat", "settings", "tickets", "more"] as const).every((name) =>
					next.actions.some((action) => actionMatches(action, name)),
				)
			)
		},
		Date.now() + 15_000,
		"native_alpha_header_timeout",
	)
	assert.ok(observed)
	const header: NativeChatHeader = observed
	for (const name of ["new-chat", "settings", "tickets", "more"] as const) {
		const action = header.actions.find((entry) => actionMatches(entry, name))
		assert.ok(action, `Native ALPHA header must contain ${name}`)
		const center = action.bounds.top + action.bounds.height / 2
		assert.ok(
			center >= header.bounds.top && center <= header.bounds.top + header.bounds.height,
			`${name} must sit inside the native ALPHA header row`,
		)
	}
	return header
}

export async function activateNativeChatHeader(
	cdp: CdpConnection,
	workbenchSession: string,
	name: NativeChatHeaderAction,
) {
	const header = await requireNativeChatHeader(cdp, workbenchSession)
	const action = header.actions.find((entry) => actionMatches(entry, name))
	assert.ok(action)
	const x = action.bounds.left + action.bounds.width / 2
	const y = action.bounds.top + action.bounds.height / 2
	for (const type of ["mouseMoved", "mousePressed", "mouseReleased"] as const) {
		await cdp.request(
			"Input.dispatchMouseEvent",
			{ type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1 },
			workbenchSession,
		)
	}
	return header
}
