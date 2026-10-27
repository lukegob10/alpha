import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import type { CdpConnection } from "./cdp"
import { javascriptLiteral } from "./javascriptLiteral"
import { waitUntil } from "../evidence/sharedStorageProtocol"

export const UNATTENDED_TRANSCRIPT_CASES = [
	{ mode: "visible", selection: false },
	{ mode: "hidden", selection: false },
	{ mode: "held-frames", selection: false },
	{ mode: "visible", selection: true },
	{ mode: "hidden", selection: true },
	{ mode: "held-frames", selection: true },
] as const

export const unattendedStage = (phase: "start" | "complete" | "returned", round: number): string =>
	`unattended-${phase}-${String.fromCharCode(97 + round)}`

interface UnattendedSample {
	documentRetained: boolean
	visibility: string
	nativeInputs: number
	frameTicks: number
	pendingFrames: number
	heldFrameRequests: number
	selected: boolean
	toolbarVisible: boolean
	composerVisible: boolean
	composerDisabled: boolean
	renderedRows: number
	finalResponsePresent: boolean
}

interface UnattendedDriver {
	evaluate<T>(expression: string): Promise<T>
	ready(stage: string): Promise<unknown>
	acknowledge(stage: string): Promise<unknown>
}

/** Complete actual task turns while the user is absent, including delayed application frame callbacks. */
export async function exerciseUnattendedLifecycle(
	cdp: CdpConnection,
	workbenchSession: string,
	directory: string,
	nonce: string,
	driver: UnattendedDriver,
): Promise<string[]> {
	const { evaluate, ready, acknowledge } = driver
	const observations: unknown[] = []
	const read = (round: number, measureGeometry = false) =>
		evaluate<UnattendedSample>(`(()=>{const s=d.defaultView.__alphaUnattended;
			const visible=e=>!!e&&(!${measureGeometry}||(e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0));
			const composer=d.querySelector('[data-testid=chat-bottom-dock] textarea');
			return {documentRetained:s?.nonce===${javascriptLiteral(nonce)},visibility:d.visibilityState,
				nativeInputs:s?.nativeInputs??-1,frameTicks:s?.frameTicks??-1,pendingFrames:s?.pending.size??-1,
				heldFrameRequests:s?.heldFrameRequests??-1,
				selected:!!d.getSelection()?.rangeCount&&!d.getSelection().isCollapsed,
				toolbarVisible:visible(d.querySelector('.chat-toolbar')),composerVisible:visible(composer),
				composerDisabled:!!composer?.disabled,
				renderedRows:Number(d.querySelector('[data-testid=chat-transcript-content]')?.getAttribute('data-rendered-count')??-1),
				finalResponsePresent:!!d.querySelector('[data-testid=chat-transcript-content]')?.textContent.includes(${javascriptLiteral(`UNATTENDED_FINAL_${round}`)})}})()`)
	try {
		for (const [round, testCase] of UNATTENDED_TRANSCRIPT_CASES.entries()) {
			await ready(unattendedStage("start", round))
			await evaluate(`(()=>{d.defaultView.__alphaUnattended?.dispose();
				const w=d.defaultView;const originalRequest=w.requestAnimationFrame;const originalCancel=w.cancelAnimationFrame;
				const s={nonce:${javascriptLiteral(nonce)},nativeInputs:0,frameTicks:0,heldFrameRequests:0,held:${testCase.mode === "held-frames"},pending:new Map()};
				let nextId=1000000000;
				w.requestAnimationFrame=callback=>{if(!s.held)return originalRequest.call(w,callback);
					const id=nextId++;s.heldFrameRequests++;s.pending.set(id,{callback});return id};
				w.cancelAnimationFrame=id=>{const pending=s.pending.get(id);if(!pending)return originalCancel.call(w,id);
					if(pending.nativeId!==undefined)originalCancel.call(w,pending.nativeId);s.pending.delete(id)};
				s.resumeFrames=()=>{s.held=false;for(const [id,pending]of s.pending){if(pending.nativeId!==undefined)continue;
					pending.nativeId=originalRequest.call(w,time=>{s.pending.delete(id);pending.callback(time)})}};
				const input=e=>{if(e.isTrusted)s.nativeInputs++};
				for(const type of ['pointerdown','pointerup','keydown','wheel'])d.addEventListener(type,input,true);
				let frame=0;const tick=()=>{s.frameTicks++;frame=d.defaultView.requestAnimationFrame(tick)};
				frame=d.defaultView.requestAnimationFrame(tick);
				s.dispose=()=>{d.defaultView.cancelAnimationFrame(frame);
					for(const type of ['pointerdown','pointerup','keydown','wheel'])d.removeEventListener(type,input,true);
					s.resumeFrames();w.requestAnimationFrame=originalRequest;w.cancelAnimationFrame=originalCancel;
					d.getSelection()?.removeAllRanges();delete d.defaultView.__alphaUnattended};
				d.defaultView.__alphaUnattended=s;d.getSelection()?.removeAllRanges();
				if(${testCase.selection}){const element=d.querySelector('[data-chat-message-index] p');
					if(!element)throw new Error('Unattended fixture needs row text');const range=d.createRange();
					range.selectNodeContents(element);d.getSelection().addRange(range)}return true})()`)
			const before = await read(round)
			assert.equal(before.selected, testCase.selection, "Unattended selection setup must match its case")
			const owner = await cdp.request<{ result: { value: boolean } }>(
				"Runtime.evaluate",
				{
					expression: `(()=>{const f=[...document.querySelectorAll('iframe')].find(e=>e.src.includes('extensionId=AlphaInc.alpha'));
						if(!f)throw new Error('Alpha frame owner missing');for(let e=f;e;e=e.parentElement){const s=getComputedStyle(e);
							if(s.display==='none'||s.visibility==='hidden')return false}const r=f.getBoundingClientRect();return r.width>0&&r.height>0})()`,
					returnByValue: true,
				},
				workbenchSession,
			)
			assert.equal(
				owner.result.value,
				testCase.mode !== "hidden",
				"The owned Alpha webview must match host visibility",
			)
			await acknowledge(unattendedStage("start", round))
			// Only the host's file barrier is polled while the task completes; no synthetic UI input is sent.
			await ready(unattendedStage("complete", round))
			const completed = await read(round)
			assert.ok(completed.documentRetained, "The original renderer document must survive unattended work")
			assert.equal(completed.nativeInputs, 0, "Unattended turns must not depend on user input")
			if (testCase.mode === "held-frames") {
				assert.equal(
					completed.frameTicks,
					before.frameTicks,
					"The controlled scheduler must hold frame callbacks",
				)
				// Completion snapshots can flush partial updates and cancel their queued callbacks.
				// Scheduling still proves application work was held, even if the queue has since shrunk.
				assert.ok(
					completed.heldFrameRequests > before.heldFrameRequests,
					"Actual application frame work must be queued",
				)
				await evaluate("d.defaultView.__alphaUnattended.resumeFrames()")
			}
			await acknowledge(unattendedStage("complete", round))
			await ready(unattendedStage("returned", round))
			await waitUntil(
				async () => {
					const current = await read(round, true)
					return (
						current.toolbarVisible &&
						current.composerVisible &&
						!current.composerDisabled &&
						current.finalResponsePresent
					)
				},
				Date.now() + 20_000,
				"unattended_return_paint_timeout",
			)
			await evaluate(
				"new Promise(resolve=>d.defaultView.requestAnimationFrame(()=>d.defaultView.requestAnimationFrame(resolve)))",
			)
			const returned = await read(round, true)
			assert.ok(returned.documentRetained && returned.toolbarVisible && returned.composerVisible)
			assert.equal(returned.composerDisabled, false)
			assert.equal(returned.nativeInputs, 0)
			assert.equal(returned.finalResponsePresent, true)
			assert.ok(
				returned.renderedRows <= 80,
				"Returning from unattended completion must keep the transcript bounded",
			)
			observations.push({
				round,
				...testCase,
				ownerVisibleAtStart: owner.result.value,
				before,
				completed,
				returned,
			})
			await fs.writeFile(
				path.join(directory, "ui-unattended-lifecycle.json"),
				JSON.stringify({ nonce, observations }, null, 2),
			)
			await acknowledge(unattendedStage("returned", round))
		}
	} finally {
		await evaluate("d.defaultView.__alphaUnattended?.dispose()")
	}
	return ["unattended-visible-completion", "unattended-hidden-completion", "unattended-held-frame-completion"]
}
