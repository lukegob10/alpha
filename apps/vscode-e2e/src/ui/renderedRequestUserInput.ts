import { javascriptLiteral } from "./javascriptLiteral"
import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { RequestUserInputAnswerMap, RequestUserInputQuestion } from "@alpha-code/types"
import type { CdpConnection } from "./cdp"
import { waitUntil } from "../evidence/sharedStorageProtocol"
import { writeJsonAtomically } from "../suite/preflightEvidence"

interface InputStage {
	nonce: string
	version: string
	questions: RequestUserInputQuestion[]
	expectedAnswers: RequestUserInputAnswerMap
	customAnswer: string
}

interface CaptureBounds {
	top: number
	bottom: number
	height: number
	viewportTop: number
	viewportBottom: number
	viewportHeight: number
	scrollTop: number
	settled: boolean
	observations: Array<Omit<CaptureBounds, "settled" | "observations">>
}

interface WheelCapturePoint {
	x: number
	y: number
	scrollTop: number
	focus: string
	geometry: unknown
}

type QuestionViewportSample<T> = { ready: false } | { ready: true; value: T }

/** Sample the owned renderer rather than retaining a document across CDP requests. */
export async function sampleQuestionViewport<T>(
	cdp: Pick<CdpConnection, "request">,
	sessionId: string,
	expression: string,
	reloadNonce?: string,
	targetSelector?: string,
): Promise<QuestionViewportSample<T>> {
	const result = await cdp.request<{ result: { value: QuestionViewportSample<T> }; exceptionDetails?: unknown }>(
		"Runtime.evaluate",
		{
			expression: `(async()=>{const frame=document.getElementById('active-frame'),d=frame?.contentDocument;
				const viewport=d?.querySelector('[data-testid=chat-transcript-scroller]');
				const reloadNonce=${reloadNonce === undefined ? "undefined" : javascriptLiteral(reloadNonce)};
				const targetSelector=${targetSelector === undefined ? "undefined" : javascriptLiteral(targetSelector)};
				const target=targetSelector===undefined?undefined:d?.querySelector(targetSelector);
				const isCurrentQuestionViewport=()=>document.getElementById('active-frame')===frame&&
					!!frame?.isConnected&&frame.contentDocument===d&&d?.readyState==='complete'&&
					d.querySelector('[data-testid=chat-transcript-scroller]')===viewport&&
					!!viewport?.isConnected&&viewport.ownerDocument===d&&
					(reloadNonce===undefined||d.defaultView?.__alphaQuestionReloadNonce!==reloadNonce)&&
					(targetSelector===undefined||!!target?.isConnected&&target.ownerDocument===d&&
						d.querySelector(targetSelector)===target&&target.closest('[data-testid=chat-transcript-scroller]')===viewport);
				if(!isCurrentQuestionViewport())return {ready:false};
				const value=await (${expression});
				return isCurrentQuestionViewport()?{ready:true,value}:{ready:false}})()`,
			returnByValue: true,
			awaitPromise: true,
		},
		sessionId,
	)
	assert.equal(result.exceptionDetails, undefined)
	return result.result.value
}

/** Read the same screenshot geometry across controlled paint frames. */
export function questionAlignmentExpression(selector: string, block: "start" | "end"): string {
	return `new Promise(resolve=>{const e=d.querySelector(${javascriptLiteral(selector)});
		if(!e||e.closest('[data-testid=chat-transcript-scroller]')!==viewport){resolve(null);return}
		e.scrollIntoView({block:${javascriptLiteral(block)},behavior:'instant'});
		const observations=[],deadline=d.defaultView.performance.now()+2000;
		let previous='',stableFrames=0;
		const observe=()=>{
			if(!isCurrentQuestionViewport()){resolve(null);return}
			const r=e.getBoundingClientRect(),v=viewport.getBoundingClientRect();
			const current={top:r.top,bottom:r.bottom,height:r.height,viewportTop:v.top,
				viewportBottom:v.bottom,viewportHeight:v.height,scrollTop:viewport.scrollTop};
			observations.push(current);
			const signature=JSON.stringify(current);
			stableFrames=signature===previous?stableFrames+1:0;previous=signature;
			if(stableFrames>=2||d.defaultView.performance.now()>=deadline){
				resolve({...current,settled:stableFrames>=2,observations});return
			}
			d.defaultView.requestAnimationFrame(observe)
		};d.defaultView.requestAnimationFrame(observe)})`
}

/** Keep failure evidence readable even while the renderer or its viewport is being replaced. */
export function questionViewportDiagnosticsExpression(): string {
	return `(()=>{const frame=document.getElementById('active-frame'),v=d.querySelector('[data-testid=chat-transcript-scroller]');
		const state={documentReadyState:d.readyState,frameConnected:!!frame?.isConnected,
			viewportConnected:!!v?.isConnected,ownerDocumentMatches:v?.ownerDocument===d,
			reloadNonce:d.defaultView?.__alphaQuestionReloadNonce??null};
		if(!v)return {...state,viewport:null};
		const r=v.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
		const describe=e=>({tag:e?.tagName??null,id:e?.id||null,testId:e?.getAttribute?.('data-testid')??null});
		const hit=d.elementFromPoint(x,y),ancestors=[];
		for(let e=hit;e&&ancestors.length<8;e=e.parentElement){
			const style=d.defaultView.getComputedStyle(e);
			ancestors.push({...describe(e),overflowY:style.overflowY,scrollTop:e.scrollTop,
				scrollHeight:e.scrollHeight,clientHeight:e.clientHeight})
		}
		return {...state,viewport:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height},
			scrollTop:v.scrollTop,scrollHeight:v.scrollHeight,clientHeight:v.clientHeight,
			center:{x,y,hit:describe(hit),ancestors}}})()`
}

function questionFocusDescriptionExpression(): string {
	return `(()=>{const e=d.activeElement;return JSON.stringify({tag:e?.tagName?.slice(0,40)??null,
		id:e?.id?.slice(0,120)??null,label:e?.getAttribute?.('aria-label')?.slice(0,120)??null,
		testId:e?.getAttribute?.('data-testid')?.slice(0,120)??null})})()`
}

/**
 * Keep Chromium's blocking input region installed between captures, and let its registration paint before input.
 * https://developer.chrome.com/blog/scrolling-intervention-2/ (verified 2026-10-26).
 */
export function questionWheelCaptureExpression(): string {
	return `new Promise(resolve=>{
		const describe=e=>({tag:e?.tagName??null,id:e?.id||null,testId:e?.getAttribute?.('data-testid')??null});
		if(!d.__alphaQuestionCaptureWheelObserver){
			const observer=event=>{const viewport=d.querySelector('[data-testid=chat-transcript-scroller]');
				if(document.getElementById('active-frame')?.contentDocument!==d||!viewport?.isConnected||viewport.ownerDocument!==d)return;
				const path=event.composedPath(),evidence={isTrusted:event.isTrusted,deltaY:event.deltaY,
					cancelable:event.cancelable,eventPhase:event.eventPhase,timeStamp:event.timeStamp,
					observedAt:d.defaultView.performance.now(),defaultPreventedAtViewport:event.defaultPrevented,
					target:describe(event.target),path:path.filter(e=>typeof e?.tagName==='string').slice(0,8).map(describe),
					geometry:(${questionViewportDiagnosticsExpression()})};
				viewport.__alphaQuestionCaptureWheel=path.includes(viewport)?evidence:undefined;
				d.defaultView.__alphaQuestionCaptureWheel=evidence};
			d.__alphaQuestionCaptureWheelObserver=observer;
			d.addEventListener('wheel',observer,{capture:true,passive:false})
		}
		d.defaultView.__alphaQuestionCaptureWheel=undefined;
		viewport.__alphaQuestionCaptureWheel=undefined;
		delete viewport.__alphaQuestionCaptureFocus;
		let frames=2;
		const sample=()=>{if(!isCurrentQuestionViewport()){resolve(null);return}
			if(--frames>0){d.defaultView.requestAnimationFrame(sample);return}
			const r=viewport.getBoundingClientRect(),f=document.getElementById('active-frame')?.getBoundingClientRect();
			viewport.__alphaQuestionCaptureFocus=d.activeElement;
			resolve({x:r.left+r.width/2+(f?.left??0),y:r.top+r.height/2+(f?.top??0),
				scrollTop:viewport.scrollTop,focus:(${questionFocusDescriptionExpression()}),geometry:(${questionViewportDiagnosticsExpression()})})
		};d.defaultView.requestAnimationFrame(sample)})`
}

export function questionWheelCleanupExpression(): string {
	return `(()=>{const observer=d.__alphaQuestionCaptureWheelObserver;
		if(observer)d.removeEventListener('wheel',observer,true);
		delete d.__alphaQuestionCaptureWheelObserver;delete d.defaultView.__alphaQuestionCaptureWheel;
		const viewport=d.querySelector('[data-testid=chat-transcript-scroller]');
		if(viewport){delete viewport.__alphaQuestionCaptureWheel;delete viewport.__alphaQuestionCaptureFocus}return true})()`
}

/** Layout and focus can move the viewport between sampling the mouse point and native wheel delivery. */
export function questionWheelProgressExpression(): string {
	return `(()=>{const wheel=viewport.__alphaQuestionCaptureWheel,before=wheel?.geometry?.scrollTop;
		return wheel?.isTrusted===true&&wheel.deltaY===-80&&wheel.cancelable===true&&wheel.eventPhase===1&&Number.isFinite(before)&&
			viewport.scrollTop<=Math.max(0,before-80)+1})()`
}

/** Browsing may update descendants of BODY without changing which DOM node owns keyboard focus. */
export function questionWheelAfterExpression(): string {
	return `(()=>{const before=viewport.__alphaQuestionCaptureFocus;
		return {scrollTop:viewport.scrollTop,focus:(${questionFocusDescriptionExpression()}),
			focusPreserved:!!before&&before===d.activeElement&&before.isConnected&&before.ownerDocument===d,
			wheel:d.defaultView.__alphaQuestionCaptureWheel}})()`
}

export function questionReceiptOutsideWorkExpression(parentToggle: string): string {
	return `(()=>{const e=d.querySelector('[data-testid=user-input-receipt]'),parent=${parentToggle};
		if(!e||!parent||e.closest('[hidden]'))return false;
		const r=e.getBoundingClientRect(),ids=(parent.getAttribute('aria-controls')??'').trim().split(/\\s+/).filter(Boolean);
		return r.width>0&&r.height>0&&ids.length>0&&ids.every(id=>{const row=d.getElementById(id);return !!row&&!row.contains(e)})})()`
}

export function questionHistoryStateExpression(summary: string, parentToggle: string): string {
	return `(()=>{const e=(${summary});if(!e)return 'absent';
		const r=e.getBoundingClientRect(),visible=!e.closest('[hidden]')&&r.width>0&&r.height>0&&
			d.defaultView.getComputedStyle(e).visibility==='visible';
		if(!visible)return 'hidden';
		const parent=${parentToggle},ids=(parent.getAttribute('aria-controls')??'').trim().split(/\\s+/).filter(Boolean);
		if(parent.getAttribute('aria-expanded')==='false'&&ids.some(id=>d.getElementById(id)?.contains(e)))
			throw new Error('Collapsed work must hide its controlled question history');
		return 'visible'})()`
}

/** Real native input into the built webview; the host independently verifies pending asks and tool history. */
export async function exerciseRenderedRequestUserInput(
	cdp: CdpConnection,
	initialSession: string,
	workbenchSession: string,
	directory: string,
	nonce: string,
	signal?: AbortSignal,
): Promise<string[]> {
	let sessionId = initialSession
	let requiredReloadNonce: string | undefined
	const form = "[data-testid=request-user-input-form]"
	const receipt = "[data-testid=user-input-receipt]"
	await cdp.request("Page.bringToFront", {}, workbenchSession)
	const evaluate = async <T>(expression: string): Promise<T> => {
		signal?.throwIfAborted()
		const result = await cdp.request<{ result: { value: T }; exceptionDetails?: unknown }>(
			"Runtime.evaluate",
			{
				expression: `(()=>{const d=document.getElementById('active-frame')?.contentDocument??document;return (${expression})})()`,
				returnByValue: true,
				awaitPromise: true,
			},
			sessionId,
		)
		assert.equal(result.exceptionDetails, undefined)
		return result.result.value
	}
	const check = (expression: string) =>
		waitUntil(() => evaluate<boolean>(expression), Date.now() + 15_000, `input_render_timeout: ${expression}`)
	let lastViewportRead: { phase: string; sample?: QuestionViewportSample<unknown> } | undefined
	let lastWheelBrowse: { stage: string; x: number; y: number; before: WheelCapturePoint } | undefined
	const readViewport = async <T>(
		phase: string,
		expression: string,
		deadline: number,
		accept: (value: T) => boolean = () => true,
		targetSelector?: string,
	): Promise<T> => {
		let value!: T
		lastViewportRead = { phase }
		await waitUntil(
			async () => {
				signal?.throwIfAborted()
				const sample = await sampleQuestionViewport<T>(
					cdp,
					sessionId,
					expression,
					requiredReloadNonce,
					targetSelector,
				)
				lastViewportRead = { phase, sample }
				if (!sample.ready || !accept(sample.value)) return false
				value = sample.value
				return true
			},
			deadline,
			`input_current_viewport_timeout: ${phase}`,
		)
		return value
	}
	const ready = async (stage: string): Promise<InputStage> => {
		let detail: InputStage | undefined
		await waitUntil(
			async () => {
				signal?.throwIfAborted()
				try {
					detail = JSON.parse(await fs.readFile(path.join(directory, `ui-stage-${stage}.json`), "utf8"))
					assert.equal(detail!.nonce, nonce)
					assert.equal(detail!.version, "1.138.0")
					return true
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
					throw error
				}
			},
			Date.now() + 60_000,
			`input_${stage}_timeout`,
		)
		return detail!
	}
	const acknowledge = (stage: string) =>
		writeJsonAtomically(
			path.join(directory, `ui-done-${stage}.json`),
			{ nonce, stage, status: "passed" },
			{ rename: fs.link },
		)
	const key = async (key: string, code: string, keyCode: number) => {
		for (const type of ["keyDown", "keyUp"]) {
			await cdp.request(
				"Input.dispatchKeyEvent",
				{
					type,
					key,
					code,
					windowsVirtualKeyCode: keyCode,
					...(type === "keyDown" && (key === "Enter" || key === " ")
						? { text: key === "Enter" ? "\r" : " " }
						: {}),
				},
				sessionId,
			)
		}
	}
	const focus = async (expression: string) => {
		await check(`(()=>{const e=${expression};return !!e&&!e.disabled&&e.getBoundingClientRect().width>0})()`)
		assert.equal(await evaluate(`(()=>{const e=${expression};e.focus();return d.activeElement===e})()`), true)
	}
	const button = (label: string) =>
		`[...d.querySelectorAll('${form} button')].find(e=>e.textContent.trim()===${javascriptLiteral(label)})`
	const activate = async (label: string) => {
		await focus(button(label))
		await key("Enter", "Enter", 13)
	}
	const choose = async (label: string) => {
		const selector = `${form} input[type=radio][value=${javascriptLiteral(label)}]`
		await focus(`d.querySelector(${javascriptLiteral(selector)})`)
		await key(" ", "Space", 32)
		await check(`d.querySelector(${javascriptLiteral(selector)})?.checked===true`)
	}
	const capture = async (stage: string, selector?: string) => {
		const deadline = Date.now() + 15_000
		const read = <T>(phase: string, expression: string) =>
			readViewport<T>(`${stage}:${phase}`, expression, deadline)
		const browse = async () => {
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
			const point = await read<WheelCapturePoint>("wheel-point", questionWheelCaptureExpression())
			const [originX, originY] = model.content
			assert.ok(typeof originX === "number" && typeof originY === "number")
			const x = originX + point.x
			const y = originY + point.y
			assert.ok(Number.isFinite(x) && Number.isFinite(y))
			lastWheelBrowse = { stage, x, y, before: point }
			await cdp.request("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, workbenchSession)
			await cdp.request(
				"Input.dispatchMouseEvent",
				{ type: "mouseWheel", x, y, deltaX: 0, deltaY: -80 },
				workbenchSession,
			)
			await readViewport<boolean>(
				`${stage}:wheel-receipt`,
				"viewport.__alphaQuestionCaptureWheel?.isTrusted===true&&viewport.__alphaQuestionCaptureWheel.deltaY===-80&&viewport.__alphaQuestionCaptureWheel.cancelable===true&&viewport.__alphaQuestionCaptureWheel.eventPhase===1",
				deadline,
				(value) => value,
			)
			await readViewport<boolean>(
				`${stage}:wheel-displacement`,
				questionWheelProgressExpression(),
				deadline,
				(value) => value,
			)
			const after = await read<{ scrollTop: number; focus: string; focusPreserved: boolean; wheel: unknown }>(
				"wheel-after",
				questionWheelAfterExpression(),
			)
			await fs.writeFile(
				path.join(directory, `ui-${stage}-scroll.json`),
				JSON.stringify({ x, y, deltaY: -80, before: point, after, trustedWheel: true }, null, 2),
			)
			assert.equal(after.focusPreserved, true, "Native browsing must preserve the current keyboard focus")
		}
		const align = async (block: "start" | "end"): Promise<CaptureBounds> => {
			assert.ok(selector)
			const bounds = await readViewport<CaptureBounds | null>(
				`${stage}:align-${block}`,
				questionAlignmentExpression(selector, block),
				deadline,
				(value) => value !== null,
				selector,
			)
			assert.ok(bounds, "Capture target must belong to the real transcript scroll viewport")
			return bounds
		}
		const record = async (name: string, bounds?: CaptureBounds) => {
			const screenshot = await cdp.request<{ data: string }>(
				"Page.captureScreenshot",
				{ format: "png" },
				workbenchSession,
			)
			await fs.writeFile(path.join(directory, `ui-${name}.png`), Buffer.from(screenshot.data, "base64"))
			await fs.writeFile(path.join(directory, `ui-${name}.txt`), await evaluate<string>("d.body.innerText"))
			await fs.writeFile(
				path.join(directory, `ui-${name}-dom.json`),
				JSON.stringify(
					{
						...(await evaluate<object>(`({theme:d.body.className,width:d.documentElement.getBoundingClientRect().width,
							forms:d.querySelectorAll('${form}').length,receipts:d.querySelectorAll('${receipt}').length,
							active:d.activeElement?.outerHTML,form:d.querySelector('${form}')?.outerHTML,
							receipt:d.querySelector('${receipt}')?.outerHTML,
							viewportDiagnostics:(${questionViewportDiagnosticsExpression()}),
							wheel:d.defaultView?.__alphaQuestionCaptureWheel})`)),
						captureBounds: bounds,
						lastViewportRead,
						lastWheelBrowse,
					},
					null,
					2,
				),
			)
		}
		if (!selector) return record(stage)
		// A real upward wheel releases the controller's automatic follow mode before explicit browsing.
		await browse()
		const top = await align("start")
		await fs.writeFile(path.join(directory, `ui-${stage}-alignment.json`), JSON.stringify({ top }, null, 2))
		assert.ok(top.settled, "Screenshot geometry must settle across consecutive rendering frames")
		assert.ok(
			top.top >= top.viewportTop - 1 && top.top < top.viewportBottom,
			"The component header must be visible below the task context panel",
		)
		await record(stage, top)
		if (top.height > top.viewportHeight) {
			const bottom = await align("end")
			await fs.writeFile(
				path.join(directory, `ui-${stage}-alignment.json`),
				JSON.stringify({ top, bottom }, null, 2),
			)
			assert.ok(bottom.settled)
			assert.ok(bottom.bottom <= bottom.viewportBottom + 1 && bottom.bottom > bottom.viewportTop)
			await record(`${stage}-bottom`, bottom)
		}
	}
	const assertFits = async (selector: string) => {
		const metrics = await evaluate<{ width: number; overflow: boolean; scrollWidth: number; clientWidth: number }>(
			`(()=>{const e=d.querySelector(${javascriptLiteral(selector)}),r=e.getBoundingClientRect();return {
				width:r.width,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,
				overflow:[...e.querySelectorAll('h3,label,input,textarea,button,dt,dd')].some(child=>{
					const c=child.getBoundingClientRect();return c.width>0&&(c.left<r.left-1||c.right>r.right+1)
				})}})()`,
		)
		assert.ok(metrics.width > 0)
		assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, "Question content must not scroll horizontally")
		assert.equal(metrics.overflow, false, "Question text and controls must fit the component")
		return metrics
	}
	const fixture = await ready("input-wizard")
	assert.equal(fixture.questions.length, 3)
	assert.equal(typeof fixture.customAnswer, "string")
	const question = async (index: number, focused = false) => {
		await check(
			`d.querySelector('${form} h3')?.textContent===${javascriptLiteral(fixture.questions[index]!.question)}&&d.querySelectorAll('${form} fieldset').length===1`,
		)
		assert.equal(
			await evaluate<number>(`new Set([...d.querySelectorAll('${form} input[type=radio]')].map(e=>e.name)).size`),
			1,
			"Only one question's answer group is active",
		)
		if (focused) await check(`d.activeElement===d.querySelector('${form} h3')`)
	}
	const originalWidth = await evaluate<string>("d.documentElement.style.width")
	const captureNarrow = async (stage: string, selector: string) => {
		try {
			await evaluate("d.documentElement.style.width='320px'")
			const metrics = await assertFits(selector)
			assert.ok(metrics.width <= 320, "The fixture must exercise a 320px or narrower real webview layout")
			await capture(stage, selector)
		} finally {
			await evaluate(`d.documentElement.style.width=${javascriptLiteral(originalWidth)}`)
		}
	}
	try {
		await check("d.body.classList.contains('vscode-dark')")
		await question(0)
		assert.equal(await evaluate<boolean>(`${button("Continue")}.disabled`), true)
		await assertFits(form)
		await capture("input-wizard-dark", form)
		await captureNarrow("input-wizard-narrow", form)
		await choose(fixture.questions[0]!.options[0]!.label)
		await check(`d.activeElement===d.querySelector('${form} input[type=radio]:checked')`)
		let reachedContinue = false
		for (let stops = 0; stops < 6; stops++) {
			await key("Tab", "Tab", 9)
			if (await evaluate<boolean>(`d.activeElement===${button("Continue")}`)) {
				reachedContinue = true
				break
			}
		}
		assert.ok(reachedContinue, "Native Tab must reach Continue from the selected radio")
		await key("Enter", "Enter", 13)
		await question(1, true)
		await focus(`d.querySelector('${form} input[type=radio][value="__alpha_other__"]')`)
		await key(" ", "Space", 32)
		await check(`d.activeElement===d.querySelector('${form} textarea')`)
		let typed = ""
		for (const part of fixture.customAnswer.match(/.{1,8}/g)!) {
			typed += part
			await cdp.request("Input.insertText", { text: part }, sessionId)
			await check(
				`d.querySelector('${form} textarea')?.value===${javascriptLiteral(typed)}&&d.activeElement===d.querySelector('${form} textarea')`,
			)
		}
		await captureNarrow("input-custom-narrow", form)
		await activate("Back")
		await question(0, true)
		assert.equal(
			await evaluate<string>(`d.querySelector('${form} input[type=radio]:checked').value`),
			fixture.questions[0]!.options[0]!.label,
		)
		await activate("Continue")
		await question(1, true)
		assert.equal(await evaluate<string>(`d.querySelector('${form} textarea').value`), fixture.customAnswer)
		await activate("Continue")
		await question(2, true)
		await choose(fixture.questions[2]!.options[0]!.label)
		await activate("Review answers")
		await check(`d.querySelector('${form} h3')?.textContent==='Review your answers'`)
		await check(`d.activeElement===d.querySelector('${form} h3')`)
		const editSelector = `${form} button[aria-label="Edit answer for Oracle"]`
		await focus(`d.querySelector(${javascriptLiteral(editSelector)})`)
		await key("Enter", "Enter", 13)
		await question(1, true)
		assert.equal(await evaluate<string>(`d.querySelector('${form} textarea').value`), fixture.customAnswer)
		await activate("Review answers")
		await check(`d.querySelector('${form} h3')?.textContent==='Review your answers'`)
		await check(`d.activeElement===d.querySelector('${form} h3')`)
		await assertFits(form)
		await capture("input-review", form)
		assert.equal(await evaluate<number>(`d.querySelectorAll('${receipt}').length`), 0)
		await acknowledge("input-wizard")
		await ready("input-send")
		await activate("Send answers")
		await acknowledge("input-send")
		for (const stage of [
			"input-receipt-dark",
			"input-receipt-light",
			"input-receipt-reopened",
			"input-receipt-reloaded",
		]) {
			await ready(stage)
			if (stage === "input-receipt-reloaded") {
				const targets = await cdp.request<{ targetInfos: Array<{ targetId: string; url: string }> }>(
					"Target.getTargets",
				)
				const target = targets.targetInfos.find((entry) => entry.url.includes("extensionId=AlphaInc.alpha"))
				assert.ok(target, "Reloaded Alpha webview target must exist")
				const attached = await cdp.request<{ sessionId: string }>("Target.attachToTarget", {
					targetId: target.targetId,
					flatten: true,
				})
				sessionId = attached.sessionId
				requiredReloadNonce = nonce
				await readViewport<boolean>(
					`${stage}:reload-receipt`,
					`d.querySelectorAll('${receipt}').length===1&&d.querySelectorAll('${form}').length===0`,
					Date.now() + 15_000,
					(value) => value,
				)
			}
			await check(`d.querySelectorAll('${receipt}').length===1&&d.querySelectorAll('${form}').length===0`)
			await check(
				`d.body.classList.contains(${javascriptLiteral(stage === "input-receipt-dark" ? "vscode-dark" : "vscode-light")})`,
			)
			const closedSummary =
				"[...d.querySelectorAll('details > summary')].find(e=>e.textContent.trim()==='Question request closed')"
			const closedRequest = `(${closedSummary})?.closest('details')`
			const parentToggles =
				"[...d.querySelectorAll('button[data-activity-trace-id]')].filter(e=>e.dataset.activityTraceId.startsWith('turn:'))"
			const parentToggle = `(${parentToggles})[0]`
			assert.equal(
				await evaluate<number>(`${parentToggles}.length`),
				1,
				"The fixture has exactly one completed turn",
			)
			const parentExpanded = await evaluate<string>(`${parentToggle}.getAttribute('aria-expanded')`)
			assert.ok(parentExpanded === "true" || parentExpanded === "false")
			const receiptOutsideWork = questionReceiptOutsideWorkExpression(parentToggle)
			await check(receiptOutsideWork)
			const historyState = questionHistoryStateExpression(closedSummary, parentToggle)
			const revealHistory = parentExpanded === "false" && (await evaluate(historyState)) !== "visible"
			// Live answered asks can remain outside work; cold history may be hidden or lazily unmounted.
			if (revealHistory) {
				await capture(`${stage}-folded`, receipt)
				await focus(parentToggle)
				await key("Enter", "Enter", 13)
				await check(`${parentToggle}.getAttribute('aria-expanded')==='true'`)
			}
			await check(`(${historyState})==='visible'`)
			await check(receiptOutsideWork)
			await check(`!!${closedRequest}&&${closedRequest}.open===false`)
			await focus(closedSummary)
			await key(" ", "Space", 32)
			await check(`${closedRequest}.open===true`)
			await check(receiptOutsideWork)
			for (const expected of fixture.questions) {
				await check(`${closedRequest}.innerText.includes(${javascriptLiteral(expected.question)})`)
				for (const option of expected.options) {
					await check(`${closedRequest}.innerText.includes(${javascriptLiteral(option.label)})`)
					await check(`${closedRequest}.innerText.includes(${javascriptLiteral(option.description)})`)
				}
			}
			assert.equal(
				await evaluate<number>(`${closedRequest}.querySelectorAll('form,input,textarea,button').length`),
				0,
				"Historical questions must contain no editable controls or actions",
			)
			if (stage === "input-receipt-dark")
				await capture("input-questions-read-only", "details:has(> summary > [role=status])")
			await key("Enter", "Enter", 13)
			await check(`${closedRequest}.open===false`)
			if (revealHistory) {
				await focus(parentToggle)
				await key("Enter", "Enter", 13)
				await check(`${parentToggle}.getAttribute('aria-expanded')==='false'&&(${historyState})!=='visible'`)
			}
			await check(receiptOutsideWork)
			for (const expected of fixture.questions) {
				await check(`d.querySelector('${receipt}').innerText.includes(${javascriptLiteral(expected.question)})`)
				for (const answer of fixture.expectedAnswers[expected.id]!.answers) {
					await check(`d.querySelector('${receipt}').innerText.includes(${javascriptLiteral(answer)})`)
				}
			}
			await assertFits(receipt)
			await capture(stage, receipt)
			if (stage === "input-receipt-dark") await captureNarrow("input-receipt-narrow", receipt)
			if (stage === "input-receipt-reopened") {
				await evaluate(`(d.defaultView.__alphaQuestionReloadNonce=${javascriptLiteral(nonce)})`)
				await evaluate(questionWheelCleanupExpression())
			}
			await acknowledge(stage)
		}
	} catch (error) {
		await capture("input-failed").catch(() => undefined)
		throw error
	} finally {
		await evaluate(
			`(${questionWheelCleanupExpression()},d.documentElement.style.width=${javascriptLiteral(originalWidth)})`,
		).catch(() => undefined)
	}
	return [
		"one-active-question",
		"narrow-question-layout",
		"native-keyboard-navigation",
		"custom-draft-back-edit",
		"review-before-one-submission",
		"dark-light-receipts",
		"closed-question-history-read-only",
		"cold-task-reopen",
		"webview-renderer-reload",
	]
}
