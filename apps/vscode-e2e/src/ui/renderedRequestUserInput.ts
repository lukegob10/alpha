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
	const ready = async (stage: string): Promise<InputStage> => {
		let detail: InputStage | undefined
		await waitUntil(
			async () => {
				signal?.throwIfAborted()
				try {
					detail = JSON.parse(await fs.readFile(path.join(directory, `ui-stage-${stage}.json`), "utf8"))
					assert.equal(detail!.nonce, nonce)
					assert.equal(detail!.version, "1.125.0")
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
		`[...d.querySelectorAll('${form} button')].find(e=>e.textContent.trim()===${JSON.stringify(label)})`
	const activate = async (label: string) => {
		await focus(button(label))
		await key("Enter", "Enter", 13)
	}
	const choose = async (label: string) => {
		const selector = `${form} input[type=radio][value=${JSON.stringify(label)}]`
		await focus(`d.querySelector(${JSON.stringify(selector)})`)
		await key(" ", "Space", 32)
		await check(`d.querySelector(${JSON.stringify(selector)})?.checked===true`)
	}
	const capture = async (stage: string, selector?: string) => {
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
			const point = await evaluate<{ x: number; y: number; scrollTop: number; focus: string }>(
				`(()=>{const viewport=d.querySelector('[data-testid=chat-transcript-scroller]');
				const r=viewport.getBoundingClientRect(),f=document.getElementById('active-frame')?.getBoundingClientRect();
				d.defaultView.__alphaQuestionCaptureWheel=undefined;
				viewport.addEventListener('wheel',event=>{d.defaultView.__alphaQuestionCaptureWheel={
					isTrusted:event.isTrusted,deltaY:event.deltaY}}, {once:true});
				return {x:r.left+r.width/2+(f?.left??0),y:r.top+r.height/2+(f?.top??0),
					scrollTop:viewport.scrollTop,focus:d.activeElement?.outerHTML??''}})()`,
			)
			const [originX, originY] = model.content
			assert.ok(typeof originX === "number" && typeof originY === "number")
			const x = originX + point.x
			const y = originY + point.y
			assert.ok(Number.isFinite(x) && Number.isFinite(y))
			await cdp.request("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, workbenchSession)
			await cdp.request(
				"Input.dispatchMouseEvent",
				{ type: "mouseWheel", x, y, deltaX: 0, deltaY: -80 },
				workbenchSession,
			)
			await check(
				"d.defaultView.__alphaQuestionCaptureWheel?.isTrusted===true&&d.defaultView.__alphaQuestionCaptureWheel.deltaY<0",
			)
			if (point.scrollTop > 0) {
				await check(
					`d.querySelector('[data-testid=chat-transcript-scroller]').scrollTop<=${Math.max(0, point.scrollTop - 80) + 1}`,
				)
			}
			const after = await evaluate<{ scrollTop: number; focus: string }>(
				"({scrollTop:d.querySelector('[data-testid=chat-transcript-scroller]').scrollTop,focus:d.activeElement?.outerHTML??''})",
			)
			await fs.writeFile(
				path.join(directory, `ui-${stage}-scroll.json`),
				JSON.stringify({ x, y, deltaY: -80, before: point, after, trustedWheel: true }, null, 2),
			)
			assert.equal(after.focus, point.focus, "Native browsing must preserve the current keyboard focus")
		}
		const align = async (block: "start" | "end"): Promise<CaptureBounds> => {
			const bounds = await evaluate<CaptureBounds | null>(
				`new Promise(resolve=>{const e=d.querySelector(${JSON.stringify(selector)});
				const viewport=e?.closest('[data-testid=chat-transcript-scroller]');
				if(!e||!viewport){resolve(null);return}
				e.scrollIntoView({block:${JSON.stringify(block)},behavior:'instant'});
				const observations=[],deadline=d.defaultView.performance.now()+2000;
				let previous='',stableFrames=0;
				const observe=()=>{
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
				};d.defaultView.requestAnimationFrame(observe)})`,
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
							receipt:d.querySelector('${receipt}')?.outerHTML})`)),
						captureBounds: bounds,
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
			`(()=>{const e=d.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return {
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
			`d.querySelector('${form} h3')?.textContent===${JSON.stringify(fixture.questions[index]!.question)}&&d.querySelectorAll('${form} fieldset').length===1`,
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
			await evaluate(`d.documentElement.style.width=${JSON.stringify(originalWidth)}`)
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
				`d.querySelector('${form} textarea')?.value===${JSON.stringify(typed)}&&d.activeElement===d.querySelector('${form} textarea')`,
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
		await focus(`d.querySelector(${JSON.stringify(editSelector)})`)
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
			}
			await check(`d.querySelectorAll('${receipt}').length===1&&d.querySelectorAll('${form}').length===0`)
			await check(
				`d.body.classList.contains(${JSON.stringify(stage === "input-receipt-dark" ? "vscode-dark" : "vscode-light")})`,
			)
			const closedSummary =
				"[...d.querySelectorAll('details > summary')].find(e=>e.textContent.trim()==='Question request closed')"
			const closedRequest = `(${closedSummary})?.closest('details')`
			await check(`!!${closedRequest}&&${closedRequest}.open===false`)
			await focus(closedSummary)
			await key(" ", "Space", 32)
			await check(`${closedRequest}.open===true`)
			for (const expected of fixture.questions) {
				await check(`${closedRequest}.innerText.includes(${JSON.stringify(expected.question)})`)
				for (const option of expected.options) {
					await check(`${closedRequest}.innerText.includes(${JSON.stringify(option.label)})`)
					await check(`${closedRequest}.innerText.includes(${JSON.stringify(option.description)})`)
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
			for (const expected of fixture.questions) {
				await check(`d.querySelector('${receipt}').innerText.includes(${JSON.stringify(expected.question)})`)
				for (const answer of fixture.expectedAnswers[expected.id]!.answers) {
					await check(`d.querySelector('${receipt}').innerText.includes(${JSON.stringify(answer)})`)
				}
			}
			await assertFits(receipt)
			await capture(stage, receipt)
			if (stage === "input-receipt-dark") await captureNarrow("input-receipt-narrow", receipt)
			await acknowledge(stage)
		}
	} catch (error) {
		await capture("input-failed").catch(() => undefined)
		throw error
	} finally {
		await evaluate(`d.documentElement.style.width=${JSON.stringify(originalWidth)}`).catch(() => undefined)
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
