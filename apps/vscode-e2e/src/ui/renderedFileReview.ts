import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { CdpConnection } from "./cdp"
import { waitUntil } from "../evidence/sharedStorageProtocol"
import { writeJsonAtomically } from "../suite/preflightEvidence"

/** Exercise the built webview with keyboard input while the host checks the resulting VS Code diff tab. */
export async function exerciseRenderedFileReview(
	cdp: CdpConnection,
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

	await check("!!d.querySelector('[data-activity-trace-id][aria-expanded=false]')")
	await check("d.body.innerText.includes('Files edited: 1')")
	assert.equal(await evaluate<string>("d.querySelector('[data-testid=total-added]')?.textContent??''"), "+1")
	assert.equal(await evaluate<string>("d.querySelector('[data-testid=total-removed]')?.textContent??''"), "-1")
	await focus("d.querySelector('[data-activity-trace-id]')")
	await enter()
	await check("d.querySelector('[data-activity-trace-id]')?.getAttribute('aria-expanded')==='true'")
	await check(
		"!![...d.querySelectorAll('[data-chat-message-index]')].find(e=>!e.hidden&&e.textContent?.includes('alpha-file-review-'))",
	)
	await focus("[...d.querySelectorAll('button')].find(e=>e.textContent?.includes('Files edited: 1'))")
	await enter()
	await check("!!d.querySelector('button[aria-label^=\"Show diff:\"]')")
	const screenshot = await cdp.request<{ data: string }>(
		"Page.captureScreenshot",
		{ format: "png" },
		workbenchSession,
	)
	await fs.writeFile(path.join(directory, "ui-file-review.png"), Buffer.from(screenshot.data, "base64"))
	await fs.writeFile(path.join(directory, "ui-file-review.txt"), await evaluate<string>("d.body.innerText"))
	await focus("d.querySelector('button[aria-label^=\"Show diff:\"]')")
	await enter()
	await writeJsonAtomically(
		path.join(directory, "ui-done-file-review.json"),
		{ nonce, stage: "file-review", status: "passed" },
		{ rename: fs.link },
	)
	return ["file-review"]
}
