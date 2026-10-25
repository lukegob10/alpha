import * as assert from "node:assert/strict"
import { javascriptLiteral } from "./javascriptLiteral"
import type { CdpConnection } from "./cdp"

/** Bounded test-driver diagnostics; never records keys other than the requested Tab or Escape. */
export function dialogKeyTraceExpression(key: "Tab" | "Escape", action: "install" | "collect"): string {
	return `(()=>{const w=d.defaultView,slot='__alphaDialogKeyTrace';
		if(${javascriptLiteral(action)}==='install'){
			w[slot]?.dispose();
			const describe=e=>e?{tag:e.tagName,id:e.id,role:e.getAttribute?.('role'),label:e.getAttribute?.('aria-label'),text:(e.textContent??'').trim().slice(0,100)}:null;
			const snapshot=()=>({at:w.performance.now(),focused:d.hasFocus(),active:describe(d.activeElement),outerActive:describe(document.activeElement),
				layers:Array.from(d.querySelectorAll('[role=dialog],[role=alertdialog],[role=listbox],[role=menu],[role=tooltip]')).slice(-16).map(e=>{
					const s=w.getComputedStyle(e);return {...describe(e),state:e.getAttribute('data-state'),hidden:e.getAttribute('aria-hidden'),display:s.display,visibility:s.visibility};})});
			const dispose=[],state={key:${javascriptLiteral(key)},events:[],before:snapshot(),snapshot,dispose:()=>dispose.forEach(remove=>remove())};
			for(const [node,point,capture] of [[w,'window-capture',true],[d,'document-capture',true],[d,'document-bubble',false],[w,'window-bubble',false]]){
				const listener=event=>{if(event.key!==state.key||state.events.length>=16)return;state.events.push({point,type:event.type,key:event.key,isTrusted:event.isTrusted,
					defaultPrevented:event.defaultPrevented,cancelable:event.cancelable,phase:event.eventPhase,target:describe(event.target),active:describe(d.activeElement)});};
				for(const type of ['keydown','keyup']){node.addEventListener(type,listener,capture);dispose.push(()=>node.removeEventListener(type,listener,capture));}
			}
			w[slot]=state;return state.before;
		}
		const state=w[slot];if(!state)return {missing:true};state.dispose();delete w[slot];return {key:state.key,before:state.before,after:state.snapshot(),events:state.events};
	})()`
}

export async function dispatchRenderedDialogKey(
	connection: Pick<CdpConnection, "request">,
	sessionId: string,
	key: "Tab" | "Escape",
	shift = false,
): Promise<void> {
	for (const type of ["keyDown", "keyUp"]) {
		await connection.request(
			"Input.dispatchKeyEvent",
			{ type, key, code: key, windowsVirtualKeyCode: key === "Tab" ? 9 : 27, modifiers: shift ? 8 : 0 },
			sessionId,
		)
	}
}

export interface RenderedDialogFocusDriver {
	evaluate<T>(expression: string): Promise<T>
	check(expression: string): Promise<void>
	key(key: "Tab" | "Escape", shift?: boolean): Promise<void>
}

/** Observe entry before moving focus; keyboard traversal must be handled by the actual renderer. */
export async function verifyRenderedDialogFocus(
	driver: RenderedDialogFocusDriver,
	selector: string,
	expectedName: string,
): Promise<void> {
	const dialog = `d.querySelector(${javascriptLiteral(selector)})`
	await driver.check(`!!${dialog}&&${dialog}.contains(d.activeElement)`)
	// Autofocus can precede Radix's registration-triggered render and passive Escape callback refresh.
	// Give the renderer two paint opportunities before input; the CDP request deadline bounds this wait.
	await driver.evaluate(
		"new Promise(resolve=>d.defaultView.requestAnimationFrame(()=>d.defaultView.requestAnimationFrame(()=>resolve(true))))",
	)
	const semantics = await driver.evaluate<{ role: string | null; modal: string | null; name: string }>(
		`(()=>{const e=${dialog};return {role:e.getAttribute('role'),modal:e.getAttribute('aria-modal'),
		name:(e.getAttribute('aria-label')??(e.getAttribute('aria-labelledby')??'').split(/\\s+/).map(id=>d.getElementById(id)?.textContent??'').join(' ')).trim()}})()`,
	)
	assert.ok(semantics.role === "dialog" || semantics.role === "alertdialog", "The modal must expose its dialog role")
	// Radix isolates background content with aria-hidden instead of emitting aria-modal.
	if (semantics.modal !== null)
		assert.equal(semantics.modal, "true", "Explicit modal semantics must agree with focus isolation")
	assert.equal(semantics.name, expectedName, "The dialog must have the expected accessible name")
	const controls = `Array.from(${dialog}.querySelectorAll('button,a[href],input:not([type=hidden]),select,textarea,[tabindex]')).filter(e=>{
		const s=d.defaultView.getComputedStyle(e);return e.tabIndex>=0&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&s.visibility!=='hidden'&&s.display!=='none'&&e.getClientRects().length>0})`
	assert.ok(await driver.evaluate<number>(`${controls}.length`), "The fixture must contain a tabbable dialog control")
	await driver.evaluate(`${controls}[0].focus()`)
	await driver.key("Tab", true)
	await driver.check(`d.activeElement===${controls}.at(-1)`)
	await driver.key("Tab")
	await driver.check(`d.activeElement===${controls}[0]`)
}

export async function dismissRenderedDialogAndRestoreFocus(
	driver: RenderedDialogFocusDriver,
	selector: string,
	openerExpression: string,
): Promise<void> {
	await driver.key("Escape")
	await driver.check(`!d.querySelector(${javascriptLiteral(selector)})`)
	await driver.check(`!!(${openerExpression})&&d.activeElement===(${openerExpression})`)
}
