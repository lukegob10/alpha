import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import type { CdpConnection } from "./cdp"
import { javascriptLiteral } from "./javascriptLiteral"
import { waitUntil } from "../evidence/sharedStorageProtocol"

/** Hold real admission at storage, observe the renderer, then reject without a model request. */
export async function exerciseRenderedFirstPrompt(
	cdp: CdpConnection,
	sessionId: string,
	workbenchSession: string,
	directory: string,
	nonce: string,
	signal?: AbortSignal,
): Promise<void> {
	const prompt = "Inspect the initial prompt delay."
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
	await evaluate("d.querySelector('textarea').focus()")
	await cdp.request("Input.insertText", { text: prompt }, sessionId)
	await waitUntil(
		() => evaluate<boolean>(`d.querySelector('textarea').value===${javascriptLiteral(prompt)}`),
		Date.now() + 10_000,
		"first_prompt_composer_timeout",
	)
	const submittedAt = await evaluate<number>("d.defaultView.performance.now()")
	await cdp.request(
		"Input.dispatchKeyEvent",
		{ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
		sessionId,
	)
	await cdp.request(
		"Input.dispatchKeyEvent",
		{ type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
		sessionId,
	)
	await waitUntil(
		async () => {
			const snapshot = await evaluate<{ visible: boolean; pending: boolean; sendDisabled: boolean }>(
				`(()=>{const transcript=d.querySelector('[data-testid="chat-transcript-viewport"]');const button=[...d.querySelectorAll('button[aria-label]')].find(e=>/^Press .+ to send$/.test(e.getAttribute('aria-label')));return {visible:!!transcript?.textContent.includes(${javascriptLiteral(prompt)}),pending:[...d.querySelectorAll('[role="status"]')].some(e=>e.textContent.includes('Preparing your request')),sendDisabled:button?.disabled===true}})()`,
			)
			return snapshot.visible && snapshot.pending && snapshot.sendDisabled
		},
		Date.now() + 10_000,
		"first_prompt_visible_before_admission_timeout",
	)
	const visibleAt = await evaluate<number>("d.defaultView.performance.now()")
	await waitUntil(
		async () => {
			try {
				return (
					JSON.parse(await fs.readFile(path.join(directory, "ui-first-prompt-blocked.json"), "utf8"))
						.nonce === nonce
				)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
				throw error
			}
		},
		Date.now() + 10_000,
		"first_prompt_storage_barrier_timeout",
	)
	const screenshot = await cdp.request<{ data: string }>(
		"Page.captureScreenshot",
		{ format: "png" },
		workbenchSession,
	)
	await fs.writeFile(path.join(directory, "ui-first-prompt-pending.png"), Buffer.from(screenshot.data, "base64"))
	await fs.writeFile(path.join(directory, "ui-first-prompt-release.json"), JSON.stringify({ nonce }), { flag: "wx" })
	await waitUntil(
		() =>
			evaluate<boolean>(
				`d.querySelector('textarea')?.value===${javascriptLiteral(prompt)} && [...d.querySelectorAll('[role="alert"]')].some(e=>e.textContent.includes('Your draft is still available'))`,
			),
		Date.now() + 10_000,
		"first_prompt_rejected_draft_timeout",
	)
	await fs.writeFile(
		path.join(directory, "ui-first-prompt-admission.json"),
		JSON.stringify(
			{
				schemaVersion: 1,
				hostVersion: "1.138.0",
				visibleBeforeAdmissionCompleted: true,
				rejectedDraftRestored: true,
				observedKeyToVisibleMs: visibleAt - submittedAt,
				boundary:
					"renderer clock before trusted Enter to polling observation; includes CDP/observation overhead",
				workload: "one prompt with saved-profile storage held by a controlled barrier; no provider request",
			},
			null,
			2,
		),
		{ flag: "wx" },
	)
}
