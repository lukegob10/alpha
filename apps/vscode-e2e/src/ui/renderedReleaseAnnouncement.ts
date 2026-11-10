import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { CdpConnection } from "./cdp"
import { waitUntil } from "../evidence/sharedStorageProtocol"

/** Prepare unobstructed chat fixtures without dismissing an unexpected product dialog. */
export async function dismissRenderedReleaseAnnouncement(
	cdp: Pick<CdpConnection, "request">,
	sessionId: string,
	workbenchSession: string,
	directory: string,
	stage: string,
	signal?: AbortSignal,
): Promise<void> {
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
	// Chat navigation can mount the queued announcement after its first commit.
	await evaluate(
		"new Promise(resolve=>d.defaultView.requestAnimationFrame(()=>d.defaultView.requestAnimationFrame(()=>resolve(true))))",
	)
	const announcement = `([...d.querySelectorAll('[role=dialog]')].find(e=>
		/^Welcome to Alpha v[0-9]/.test(e.querySelector('[data-slot=dialog-title]')?.textContent.trim()??'')))`
	if (await evaluate<boolean>(`!!(${announcement})`)) {
		const screenshot = await cdp.request<{ data: string }>(
			"Page.captureScreenshot",
			{ format: "png" },
			workbenchSession,
		)
		await fs.writeFile(
			path.join(directory, `ui-${stage}-release-announcement.png`),
			Buffer.from(screenshot.data, "base64"),
		)
		const close = `([...(${announcement}).querySelectorAll('button')].find(e=>e.textContent.trim()==='Close'))`
		assert.equal(
			await evaluate<boolean>(
				`(()=>{const e=${close};if(!e)return false;e.focus();return d.activeElement===e})()`,
			),
			true,
			"release announcement Close must own keyboard focus",
		)
		signal?.throwIfAborted()
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
		await waitUntil(
			() => evaluate<boolean>(`!(${announcement})`),
			Date.now() + 5000,
			`${stage}_announcement_dismiss_timeout`,
		)
	}
	assert.equal(
		await evaluate<boolean>("!!d.querySelector('[role=dialog],[role=alertdialog]')"),
		false,
		`unexpected ${stage} setup dialog`,
	)
}
