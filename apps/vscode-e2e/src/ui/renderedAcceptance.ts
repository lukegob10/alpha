import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { CdpConnection } from "./cdp"
import { waitUntil } from "../evidence/sharedStorageProtocol"

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
	const evaluate = async <T>(expression: string): Promise<T> => {
		signal?.throwIfAborted()
		const value = await cdp.request<{ result: { value: T }; exceptionDetails?: unknown }>(
			"Runtime.evaluate",
			{
				expression: `(()=>{const d=document.getElementById('active-frame').contentDocument;return (${expression})})()`,
				returnByValue: true,
			},
			sessionId,
		)
		assert.equal(value.exceptionDetails, undefined)
		return value.result.value
	}
	const check = async (expression: string) => {
		try {
			await waitUntil(() => evaluate<boolean>(expression), Date.now() + 15000, "rendered_control_timeout")
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
	const key = async (key: string, code: string, keyCode: number, modifiers = 0, target = workbenchSession) => {
		await cdp.request(
			"Input.dispatchKeyEvent",
			{ type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, modifiers },
			target,
		)
		await cdp.request(
			"Input.dispatchKeyEvent",
			{ type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, modifiers },
			target,
		)
	}
	const click = async (element: string) => {
		const position = await evaluate<{ x: number; y: number }>(
			`(()=>{const e=${element};e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();const f=document.getElementById('active-frame').getBoundingClientRect();return {x:f.x+r.x+r.width/2,y:f.y+r.y+r.height/2}})()`,
		)
		await cdp.request("Input.dispatchMouseEvent", { type: "mouseMoved", ...position }, sessionId)
		await cdp.request(
			"Input.dispatchMouseEvent",
			{ type: "mousePressed", ...position, button: "left", buttons: 1, clickCount: 1 },
			sessionId,
		)
		await cdp.request(
			"Input.dispatchMouseEvent",
			{ type: "mouseReleased", ...position, button: "left", buttons: 0, clickCount: 1 },
			sessionId,
		)
	}
	const activate = async (selector: string, label?: string, prefix = false) => {
		const find = `[...d.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getBoundingClientRect().width>0&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'${label === undefined ? "" : `&&(e.getAttribute('aria-label')??e.textContent).trim().${prefix ? "startsWith" : "includes"}(${JSON.stringify(label)})`})`
		await check(`!!(${find})`)
		await click(find)
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
			await activate("button", "Agents")
			await check("d.querySelector('#max-concurrent-subagents-input')?.value==='3'")
			await click("d.querySelector('#max-concurrent-subagents-input')")
			await key("a", "KeyA", 65, 2)
			await cdp.request("Input.insertText", { text: "4" }, workbenchSession)
			await check("d.querySelector('#max-concurrent-subagents-input')?.value==='4'")
			await evaluate(
				"(()=>{const w=d.defaultView;w.__alphaUiRefreshSequences=[];w.__alphaUiRefreshObserver=e=>{const seq=e.data?.state?.taskStateSeq;if(e.data?.type==='state'&&Number.isInteger(seq)&&!w.__alphaUiRefreshSequences.includes(seq)&&w.__alphaUiRefreshSequences.length<8)w.__alphaUiRefreshSequences.push(seq)};w.addEventListener('message',w.__alphaUiRefreshObserver);return true})()",
			)
		} else if (stage === "settings-refresh-discard") {
			await check("d.defaultView.__alphaUiRefreshSequences.length>=2")
			await check("d.querySelector('#max-concurrent-subagents-input')?.value==='4'")
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
				"!d.querySelector('[role=alertdialog]')&&d.querySelector('#max-concurrent-subagents-input')?.value==='4'",
			)
			await activate("button", "Done")
			await activate('[role="alertdialog"] button', "Discard changes")
			await check("!d.querySelector('#max-concurrent-subagents-input')")
		} else if (stage.endsWith("-apply") || stage === "discard-discard") {
			assert.ok(detail?.nickname)
			const action = `[...d.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(`Actions for ${detail.nickname}`)})`
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
