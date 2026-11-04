import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { CdpConnection } from "./cdp"
import { waitUntil } from "../evidence/sharedStorageProtocol"
import { writeJsonAtomically } from "../suite/preflightEvidence"
import { javascriptLiteral } from "./javascriptLiteral"

/** Exercise the built webview with keyboard input while the host checks the resulting VS Code diff tab. */
export async function exerciseRenderedFileReview(
	cdp: Pick<CdpConnection, "request">,
	sessionId: string,
	workbenchSession: string,
	directory: string,
	nonce: string,
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
	const check = (expression: string) =>
		waitUntil(() => evaluate<boolean>(expression), Date.now() + 15_000, `file_review_render_timeout: ${expression}`)
	const focus = async (expression: string) => {
		await check(`(()=>{const e=${expression};return !!e&&!e.disabled&&e.getBoundingClientRect().width>0})()`)
		assert.equal(
			await evaluate<boolean>(`(()=>{const e=${expression};e.focus();return d.activeElement===e})()`),
			true,
		)
	}
	const enter = async (targetSession = sessionId) => {
		for (const type of ["keyDown", "keyUp"]) {
			await cdp.request(
				"Input.dispatchKeyEvent",
				{
					type,
					key: "Enter",
					code: "Enter",
					windowsVirtualKeyCode: 13,
					...(type === "keyDown" ? { text: "\r" } : {}),
				},
				targetSession,
			)
		}
	}
	const readStage = async (stage: string): Promise<object> => {
		let detail: object | undefined
		await waitUntil(
			async () => {
				signal?.throwIfAborted()
				try {
					const receipt: unknown = JSON.parse(
						await fs.readFile(path.join(directory, `ui-stage-${stage}.json`), "utf8"),
					)
					assert.ok(receipt && typeof receipt === "object")
					assert.ok("nonce" in receipt && receipt.nonce === nonce)
					assert.ok("stage" in receipt && receipt.stage === stage)
					detail = receipt
					return true
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
					throw error
				}
			},
			Date.now() + 30_000,
			`file_review_host_timeout: ${stage}`,
		)
		assert.ok(detail)
		return detail
	}
	const acknowledge = (stage: string) =>
		writeJsonAtomically(
			path.join(directory, `ui-done-${stage}.json`),
			{ nonce, stage, status: "passed" },
			{ rename: fs.link },
		)
	const stage = await readStage("file-review")
	assert.ok("fileNames" in stage && Array.isArray(stage.fileNames))
	assert.ok(stage.fileNames.every((fileName: unknown) => typeof fileName === "string"))
	const fileNames = stage.fileNames
	assert.equal(fileNames.length, 3)

	await check("!!d.querySelector('[data-activity-trace-id][aria-expanded=false]')")
	await check("d.body.innerText.includes('Files edited: 3')")
	assert.equal(await evaluate<string>("d.querySelector('[data-testid=total-added]')?.textContent??''"), "+3")
	assert.equal(await evaluate<string>("d.querySelector('[data-testid=total-removed]')?.textContent??''"), "-3")
	await focus("d.querySelector('[data-activity-trace-id]')")
	await enter()
	await check("d.querySelector('[data-activity-trace-id]')?.getAttribute('aria-expanded')==='true'")
	await focus("d.querySelector('button[aria-label=Review]')")
	await enter()
	await acknowledge("file-review")
	await readStage("file-review-controls")
	const nativeEvaluate = async (expression: string): Promise<boolean> => {
		const result = await cdp.request<{ result: { value: boolean }; exceptionDetails?: unknown }>(
			"Runtime.evaluate",
			{ expression, returnByValue: true },
			workbenchSession,
		)
		assert.equal(result.exceptionDetails, undefined)
		return result.result.value
	}
	const nativeCheck = async (expression: string) => {
		try {
			await waitUntil(
				() => nativeEvaluate(expression),
				Date.now() + 15_000,
				`native_review_timeout: ${expression}`,
			)
		} catch (error) {
			const state = await cdp.request(
				"Runtime.evaluate",
				{
					expression:
						"({text:document.body.innerText,labels:[...document.querySelectorAll('[aria-label]')].map(e=>e.getAttribute('aria-label')),editors:[...document.querySelectorAll('.multiDiffEntry .editorContainer')].map(e=>e.style.display)})",
					returnByValue: true,
				},
				workbenchSession,
			)
			await fs.writeFile(path.join(directory, "ui-native-review-failure.json"), JSON.stringify(state))
			const screenshot = await cdp.request<{ data: string }>(
				"Page.captureScreenshot",
				{ format: "png" },
				workbenchSession,
			)
			await fs.writeFile(
				path.join(directory, "ui-native-review-failure.png"),
				Buffer.from(screenshot.data, "base64"),
			)
			throw error
		}
	}
	const visibleAction = (label: string) =>
		`(()=>{const e=[...document.querySelectorAll('[aria-label]')].find(e=>e.getAttribute('aria-label')?.startsWith(${javascriptLiteral(label)})&&e.getBoundingClientRect().width>0);return !!e})()`
	const foldedState = (collapsed: boolean) =>
		`(()=>{const editors=[...document.querySelectorAll('.multiDiffEntry .editorContainer')];return editors.length>0&&editors.every(e=>(e.style.display==='none')===${collapsed})})()`
	const runAction = async (label: string) => {
		await nativeCheck(visibleAction("Review Actions"))
		assert.equal(
			await nativeEvaluate(
				"(()=>{const e=[...document.querySelectorAll('[aria-label]')].find(e=>e.getAttribute('aria-label')?.startsWith('Review Actions')&&e.getBoundingClientRect().width>0);e.focus();return document.activeElement===e})()",
			),
			true,
		)
		await enter(workbenchSession)
		await nativeCheck("!!document.querySelector('.quick-input-widget input')?.getBoundingClientRect().width")
		await cdp.request("Input.insertText", { text: label }, workbenchSession)
		await nativeCheck(
			`document.querySelector('.quick-input-widget')?.textContent?.includes(${javascriptLiteral(label)})===true`,
		)
		await enter(workbenchSession)
		await nativeCheck("!document.querySelector('.quick-input-widget')?.getBoundingClientRect().width")
	}
	await nativeCheck("document.querySelectorAll('.multiDiffEntry .status.renamed').length===0")
	await runAction("Collapse all files")
	await nativeCheck(foldedState(true))
	await runAction("Expand all files")
	await nativeCheck(foldedState(false))
	await runAction("Inline view")
	await runAction("Side-by-side view")
	await nativeCheck(
		"(()=>{const editors=[...document.querySelectorAll('.multiDiffEntry .monaco-diff-editor')];return editors.length>0&&editors.every(e=>e.classList.contains('side-by-side'))})()",
	)
	await runAction("Next change")
	await runAction("Previous change")
	for (const [digit, collapsed] of [
		["0", true],
		["9", false],
	] as const) {
		assert.equal(
			await nativeEvaluate(
				"(()=>{const e=[...document.querySelectorAll('[aria-label]')].find(e=>e.getAttribute('aria-label')?.startsWith('Review Actions')&&e.getBoundingClientRect().width>0);e.focus();return document.activeElement===e})()",
			),
			true,
		)
		for (const type of ["keyDown", "keyUp"]) {
			await cdp.request(
				"Input.dispatchKeyEvent",
				{ type, key: digit, code: `Digit${digit}`, windowsVirtualKeyCode: digit.charCodeAt(0), modifiers: 3 },
				workbenchSession,
			)
		}
		await nativeCheck(foldedState(collapsed))
	}
	const reviewScreenshot = await cdp.request<{ data: string }>(
		"Page.captureScreenshot",
		{ format: "png" },
		workbenchSession,
	)
	await fs.writeFile(path.join(directory, "ui-file-review-native.png"), Buffer.from(reviewScreenshot.data, "base64"))
	await acknowledge("file-review-controls")

	// The host verifies every native Review resource and closes that editor before authorizing the next action.
	const fileStage = await readStage("file-review-file")
	assert.ok("fileName" in fileStage && fileStage.fileName === fileNames[1])
	const panelTrigger =
		"[...d.querySelectorAll('button[aria-expanded]')].find(e=>e.textContent?.includes('Files edited: 3'))"
	await check(`(${panelTrigger})?.getAttribute('aria-expanded')==='false'`)
	await focus(panelTrigger)
	await enter()
	await check(`(${panelTrigger})?.getAttribute('aria-expanded')==='true'`)
	// File rows are editor actions, with no inline disclosure or second icon button.
	for (const fileName of fileNames) {
		await check(
			`(()=>{const row=[...d.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')===${javascriptLiteral("Show diff: ")}+${javascriptLiteral(fileName)});return !!row&&!row.hasAttribute('aria-expanded')&&!row.querySelector('button,svg')})()`,
		)
	}

	const screenshot = await cdp.request<{ data: string }>(
		"Page.captureScreenshot",
		{ format: "png" },
		workbenchSession,
	)
	await fs.writeFile(path.join(directory, "ui-file-review.png"), Buffer.from(screenshot.data, "base64"))
	await fs.writeFile(path.join(directory, "ui-file-review.txt"), await evaluate<string>("d.body.innerText"))
	await focus(
		`[...d.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')===${javascriptLiteral(`Show diff: ${fileStage.fileName}`)})`,
	)
	await enter()
	await acknowledge("file-review-file")
	return [
		"file-review",
		"review-native-multi-diff",
		"review-collapse-expand-navigation",
		"review-side-by-side-layout",
		"review-chat-stays-collapsed",
		"review-full-row-actions",
		"review-native-file-diff",
	]
}
