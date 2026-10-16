import { javascriptLiteral } from "./javascriptLiteral"
import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { CdpConnection } from "./cdp"
import { waitUntil } from "../evidence/sharedStorageProtocol"

const RENDERED_CONTROL_TIMEOUT_MS = 15_000

interface RenderedControlPosition {
	x: number
	y: number
	width: number
	height: number
}

export function createRenderedAcceptanceControls(
	cdp: Pick<CdpConnection, "request">,
	sessionId: string,
	signal?: AbortSignal,
) {
	const ensureActive = (deadline: number) => {
		signal?.throwIfAborted()
		if (Date.now() >= deadline) throw new Error("rendered_control_timeout")
	}
	const settle = async <T>(operation: () => Promise<T>, deadline: number): Promise<T> => {
		ensureActive(deadline)
		let timer: ReturnType<typeof setTimeout> | undefined
		let aborted: (() => void) | undefined
		try {
			const interrupted = new Promise<never>((_, reject) => {
				aborted = () => reject(signal?.reason)
				signal?.addEventListener("abort", aborted, { once: true })
				timer = setTimeout(() => reject(new Error("rendered_control_timeout")), deadline - Date.now())
			})
			// Attach both race handlers before dispatch; a late transport rejection remains handled after interruption.
			const pending = Promise.resolve().then(() => {
				ensureActive(deadline)
				return operation()
			})
			const value = await Promise.race([pending, interrupted])
			ensureActive(deadline)
			return value
		} catch (error) {
			ensureActive(deadline)
			throw error
		} finally {
			if (timer !== undefined) clearTimeout(timer)
			if (aborted) signal?.removeEventListener("abort", aborted)
		}
	}
	const evaluate = async <T>(expression: string, deadline = Date.now() + RENDERED_CONTROL_TIMEOUT_MS): Promise<T> => {
		const value = await settle(
			() =>
				cdp.request<{ result: { value: T }; exceptionDetails?: unknown }>(
					"Runtime.evaluate",
					{
						expression: `(()=>{const d=document.getElementById('active-frame').contentDocument;return (${expression})})()`,
						returnByValue: true,
						awaitPromise: true,
					},
					sessionId,
				),
			deadline,
		)
		ensureActive(deadline)
		assert.equal(value.exceptionDetails, undefined)
		return value.result.value
	}
	const check = (expression: string, deadline = Date.now() + RENDERED_CONTROL_TIMEOUT_MS) =>
		settle(
			() => waitUntil(() => evaluate<boolean>(expression, deadline), deadline, "rendered_control_timeout"),
			deadline,
		)
	const click = async (element: string, deadline = Date.now() + RENDERED_CONTROL_TIMEOUT_MS) => {
		ensureActive(deadline)
		await evaluate(
			`(()=>{const e=${element};e?.scrollIntoView({block:'center',behavior:'instant'});return true})()`,
			deadline,
		)
		const samePosition = (left: RenderedControlPosition, right: RenderedControlPosition) =>
			left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
		const waitForPosition = async (): Promise<RenderedControlPosition> => {
			let previous: RenderedControlPosition | undefined
			while (true) {
				ensureActive(deadline)
				// Resolve the current node on each rendering frame; portals can change geometry or document ownership.
				const current = await evaluate<RenderedControlPosition | null>(
					`new Promise(resolve=>d.defaultView.requestAnimationFrame(()=>{
						const frame=document.getElementById('active-frame');
						if(!frame||frame.contentDocument!==d){resolve(null);return}
						const e=${element},w=d.defaultView;
						if(!e?.isConnected||e.disabled||e.getAttribute('aria-disabled')==='true'){resolve(null);return}
						for(let node=e;node;node=node.parentElement){
							const style=w.getComputedStyle(node);
							if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0){resolve(null);return}
							if((node.getAnimations?.()??[]).some(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming().endTime))){resolve(null);return}
						}
						const r=e.getBoundingClientRect(),f=frame.getBoundingClientRect();
						const localX=r.x+r.width/2,localY=r.y+r.height/2,x=f.x+localX,y=f.y+localY;
						if(r.width<=0||r.height<=0||![x,y,r.width,r.height].every(Number.isFinite)||!e.contains(d.elementFromPoint(localX,localY))||document.elementFromPoint(x,y)!==frame){resolve(null);return}
						resolve({x,y,width:r.width,height:r.height});
					}))`,
					deadline,
				)
				ensureActive(deadline)
				if (current && previous && samePosition(current, previous)) return current
				previous = current ?? undefined
			}
		}
		let position = await waitForPosition()
		while (true) {
			ensureActive(deadline)
			await settle(
				() =>
					cdp.request(
						"Input.dispatchMouseEvent",
						{ type: "mouseMoved", x: position.x, y: position.y },
						sessionId,
					),
				deadline,
			)
			const afterMove = await waitForPosition()
			if (samePosition(position, afterMove)) break
			position = afterMove
		}
		ensureActive(deadline)
		let pressAttempted = false
		try {
			await settle(() => {
				pressAttempted = true
				return cdp.request(
					"Input.dispatchMouseEvent",
					{
						type: "mousePressed",
						x: position.x,
						y: position.y,
						button: "left",
						buttons: 1,
						clickCount: 1,
					},
					sessionId,
				)
			}, deadline)
			ensureActive(deadline)
		} finally {
			// A release alone can activate a Radix option when cancellation prevented the press.
			if (pressAttempted) {
				await cdp.request(
					"Input.dispatchMouseEvent",
					{ type: "mouseReleased", x: position.x, y: position.y, button: "left", buttons: 0, clickCount: 1 },
					sessionId,
				)
			}
		}
		ensureActive(deadline)
	}
	return { evaluate, check, click }
}

/** Drives rendered controls only; the existing EH fixture verifies authoritative settings, files and task state. */
export async function exerciseRenderedAcceptance(
	cdp: CdpConnection,
	sessionId: string,
	workbenchSession: string,
	directory: string,
	nonce: string,
	signal?: AbortSignal,
) {
	await cdp.request("Page.bringToFront", {}, workbenchSession)
	const controls = createRenderedAcceptanceControls(cdp, sessionId, signal)
	const { evaluate } = controls
	const retainFailure = async (expression: string, operation: () => Promise<void>) => {
		try {
			await operation()
		} catch (error) {
			const screenshot = await cdp.request<{ data: string }>(
				"Page.captureScreenshot",
				{ format: "png" },
				workbenchSession,
			)
			await fs.writeFile(path.join(directory, "ui-failed-control.png"), Buffer.from(screenshot.data, "base64"))
			await fs.writeFile(
				path.join(directory, "ui-failed-control.json"),
				JSON.stringify(
					{
						expression,
						rendered: await evaluate(
							"({text:d.body.innerText.slice(0,12000),buttons:[...d.querySelectorAll('button,[role=menuitem]')].map(e=>({text:e.textContent,aria:e.getAttribute('aria-label'),role:e.getAttribute('role')}))})",
						),
					},
					null,
					2,
				),
			)
			throw error
		}
	}
	const check = (expression: string, deadline = Date.now() + RENDERED_CONTROL_TIMEOUT_MS) =>
		retainFailure(expression, () => controls.check(expression, deadline))
	const click = (element: string, deadline = Date.now() + RENDERED_CONTROL_TIMEOUT_MS) =>
		retainFailure(element, () => controls.click(element, deadline))
	const outputPreview =
		"d.querySelector('[data-testid=settings-content] [data-testid=terminal-output-preview-size-dropdown]')"
	const activate = async (selector: string, label?: string, prefix = false) => {
		const find = `[...d.querySelectorAll(${javascriptLiteral(selector)})].find(e=>e.getBoundingClientRect().width>0&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'${label === undefined ? "" : `&&(e.getAttribute('aria-label')??e.textContent).trim().${prefix ? "startsWith" : "includes"}(${javascriptLiteral(label)})`})`
		const deadline = Date.now() + RENDERED_CONTROL_TIMEOUT_MS
		await check(`!!(${find})`, deadline)
		await click(find, deadline)
	}
	const completed: string[] = []
	const capture = async (name: string) => {
		const screenshot = await cdp.request<{ data: string }>(
			"Page.captureScreenshot",
			{ format: "png" },
			workbenchSession,
		)
		await fs.writeFile(path.join(directory, `ui-${name}.png`), Buffer.from(screenshot.data, "base64"))
	}
	const stages = [
		"settings-edit",
		"settings-refresh-discard",
		"live-navigate-nested",
		"live-navigate-outer",
		"live-navigate-root",
		"nested-apply",
		"discard-discard",
		"outer-apply",
		"navigate-nested",
		"navigate-outer",
		"navigate-root",
		"complete",
	]
	for (const stage of stages) {
		let detail: { nonce: string; stage: string; nickname?: string } | undefined
		await waitUntil(
			async () => {
				signal?.throwIfAborted()
				try {
					detail = JSON.parse(await fs.readFile(path.join(directory, `ui-stage-${stage}.json`), "utf8"))
					return true
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
					throw error
				}
			},
			Date.now() + 90000,
			`ui_${stage}_missing`,
		)
		assert.equal(detail?.nonce, nonce)
		assert.equal(detail?.stage, stage)
		if (stage === "settings-edit") {
			await check(
				"!!d.querySelector('[data-testid=settings-tab-list] [role=tab][aria-selected=true]')&&!!d.querySelector('[data-testid=save-button]')",
			)
			const originalTab = await evaluate<string>(
				"d.querySelector('[data-testid=settings-tab-list] [role=tab][aria-selected=true]').getAttribute('data-testid')",
			)
			const originalSaveDisabled = await evaluate<boolean>(
				"d.querySelector('[data-testid=save-button]').disabled",
			)
			try {
				await activate('[data-testid="settings-tab-list"] [data-testid="tab-agents"]')
				const basicControls = [
					["agents-concurrency", "input", "Maximum concurrent managed agents"],
					["agents-delegation-policy", "select", "Delegation policy"],
					["agents-default-profile", "select", "Default child model/API profile"],
				]
				await check(
					`(${javascriptLiteral(basicControls)}).every(([id,tag,label])=>{const e=d.querySelector('[data-testid=settings-content] '+tag+'[id="'+id+'"]');return e?.getBoundingClientRect().width>0&&[...e.labels].some(l=>l.textContent.trim()===label)})`,
				)
				await capture("settings-agents-basic")
				await activate(
					'[data-testid="settings-content"] details[data-agents-advanced] > summary',
					"Advanced agent settings",
				)
				await check(
					"!!d.querySelector('[data-testid=settings-content] details[data-agents-advanced][open] input[id=agents-depth]')&&[...d.querySelector('[data-testid=settings-content] input[id=agents-timeout-review]').labels].some(l=>l.textContent.trim()==='Review timeout per run (seconds)')",
				)
				await evaluate(
					"(()=>{d.querySelector('[data-testid=settings-content] input[id=agents-depth]').scrollIntoView({block:'center'});return true})()",
				)
				await capture("settings-agents-advanced")
			} finally {
				await activate(`[data-testid="settings-tab-list"] [data-testid=${javascriptLiteral(originalTab)}]`)
			}
			await check(
				`d.querySelector('[data-testid=settings-tab-list] [role=tab][aria-selected=true]')?.getAttribute('data-testid')===${javascriptLiteral(originalTab)}&&d.querySelector('[data-testid=save-button]').disabled===${originalSaveDisabled}`,
			)
			await activate('[data-testid="tab-terminal"]')
			await check(`${outputPreview}?.textContent?.includes('Medium (10KB)')`)
			await click(outputPreview)
			await activate('[role="option"]', "Large (20KB)")
			await check(`${outputPreview}?.textContent?.includes('Large (20KB)')`)
			await evaluate(
				"(()=>{const w=d.defaultView;w.__alphaUiRefreshSequences=[];w.__alphaUiRefreshObserver=e=>{const seq=e.data?.state?.taskStateSeq;if(e.data?.type==='state'&&Number.isInteger(seq)&&!w.__alphaUiRefreshSequences.includes(seq)&&w.__alphaUiRefreshSequences.length<8)w.__alphaUiRefreshSequences.push(seq)};w.addEventListener('message',w.__alphaUiRefreshObserver);return true})()",
			)
		} else if (stage === "settings-refresh-discard") {
			await check("d.defaultView.__alphaUiRefreshSequences.length>=2")
			await check(`${outputPreview}?.textContent?.includes('Large (20KB)')`)
			const sequences = await evaluate<number[]>("d.defaultView.__alphaUiRefreshSequences")
			await fs.writeFile(
				path.join(directory, "ui-settings-refresh-count.json"),
				JSON.stringify({ nonce, received: sequences.length, sequences }),
			)
			await evaluate(
				"(()=>{const w=d.defaultView;w.removeEventListener('message',w.__alphaUiRefreshObserver);delete w.__alphaUiRefreshObserver;delete w.__alphaUiRefreshSequences;return true})()",
			)
			await activate("button", "Done")
			await check("d.body.innerText.includes('Unsaved Changes')")
			await activate('[role="alertdialog"] button', "Cancel")
			await check(
				`!d.querySelector('[role=alertdialog]')&&${outputPreview}?.textContent?.includes('Large (20KB)')`,
			)
			await activate("button", "Done")
			await activate('[role="alertdialog"] button', "Discard changes")
			await check(`!(${outputPreview})`)
		} else if (stage.endsWith("-apply") || stage === "discard-discard") {
			assert.ok(detail?.nickname)
			const action = `[...d.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')===${javascriptLiteral(`Actions for ${detail.nickname}`)})`
			await check(`!!(${action})`)
			if (await evaluate<boolean>(`!!(${action}).closest('[hidden]')`)) {
				await click(
					`[...d.querySelectorAll('button[aria-controls]')].find(e=>e.getAttribute('aria-controls')===(${action}).closest('[hidden]').id)`,
				)
			}
			await activate("button", `Actions for ${detail.nickname}`)
			await check(
				"[...d.querySelectorAll('[role=menuitem]')].some(e=>e.textContent.includes('Open task'))&&[...d.querySelectorAll('[role=menuitem]')].some(e=>e.textContent.includes('Open diff'))",
			)
			// Let the portal paint before measuring the next control.
			await evaluate(
				"new Promise(resolve=>d.defaultView.requestAnimationFrame(()=>d.defaultView.requestAnimationFrame(()=>resolve(true))))",
			)
			await capture(`${stage}-menu`)
			const apply = stage.endsWith("-apply")
			await activate('[role="menuitem"]', apply ? "Apply changes" : "Discard")
			await check("!!d.querySelector('[role=dialog],[role=alertdialog]')")
			await capture(`${stage}-confirmation`)
			await activate(
				'[role="dialog"] button,[role="alertdialog"] button',
				apply ? "Confirm apply" : "Confirm discard",
			)
		} else if (stage === "navigate-nested" || stage === "live-navigate-nested") {
			assert.ok(detail?.nickname)
			await activate('section[aria-label="Sub-agent tasks"] button', `Open ${detail.nickname}`, true)
		} else if (
			stage === "navigate-outer" ||
			stage === "navigate-root" ||
			stage === "live-navigate-outer" ||
			stage === "live-navigate-root"
		) {
			await activate("button", "Return to parent")
		}
		await capture(stage)
		await fs.writeFile(
			path.join(directory, `ui-done-${stage}.json`),
			JSON.stringify({ nonce, stage, status: "passed" }),
			{ flag: "wx" },
		)
		completed.push(stage)
	}
	return completed
}
