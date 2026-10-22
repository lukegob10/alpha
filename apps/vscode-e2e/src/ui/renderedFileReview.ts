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
	const enter = async () => {
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
				sessionId,
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
	const fileToggle = (fileName: string) =>
		`[...d.querySelectorAll('button[aria-expanded]')].find(e=>e.textContent?.includes(${javascriptLiteral(fileName)}))`

	await check("!!d.querySelector('[data-activity-trace-id][aria-expanded=false]')")
	await check("d.body.innerText.includes('Files edited: 3')")
	assert.equal(await evaluate<string>("d.querySelector('[data-testid=total-added]')?.textContent??''"), "+3")
	assert.equal(await evaluate<string>("d.querySelector('[data-testid=total-removed]')?.textContent??''"), "-3")
	await focus("d.querySelector('[data-activity-trace-id]')")
	await enter()
	await check("d.querySelector('[data-activity-trace-id]')?.getAttribute('aria-expanded')==='true'")
	await check(
		"!![...d.querySelectorAll('[data-chat-message-index]')].find(e=>!e.hidden&&e.textContent?.includes('alpha-file-review-'))",
	)
	await focus("d.querySelector('button[aria-label=Review]')")
	await enter()
	await acknowledge("file-review")
	const reviewScreenshot = await cdp.request<{ data: string }>(
		"Page.captureScreenshot",
		{ format: "png" },
		workbenchSession,
	)
	await fs.writeFile(path.join(directory, "ui-file-review-native.png"), Buffer.from(reviewScreenshot.data, "base64"))

	// The host verifies every native Review resource and closes that editor before authorizing the next action.
	const fileStage = await readStage("file-review-file")
	assert.ok("fileName" in fileStage && fileStage.fileName === fileNames[1])
	for (const [index, fileName] of fileNames.entries()) {
		await check(`(${fileToggle(fileName)})?.getAttribute('aria-expanded')==='${index === 2}'`)
	}
	await focus(fileToggle(fileNames[2]!))
	await enter()
	for (const fileName of fileNames) {
		await check(`(${fileToggle(fileName)})?.getAttribute('aria-expanded')==='false'`)
	}
	await focus(fileToggle(fileNames[0]!))
	await enter()
	await check(`(${fileToggle(fileNames[0]!)})?.getAttribute('aria-expanded')==='true'`)
	await focus(fileToggle(fileNames[0]!))
	await enter()
	await focus(fileToggle(fileNames[2]!))
	await enter()
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
		"review-bottom-file-open",
		"review-all-files-closed",
		"review-native-file-diff",
	]
}
