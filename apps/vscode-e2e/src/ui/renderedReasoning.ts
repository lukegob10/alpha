import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { CdpConnection } from "./cdp"
import { waitUntil } from "../evidence/sharedStorageProtocol"
import { writeJsonAtomically } from "../suite/preflightEvidence"

/** Trusted keyboard input into the built webview; the host fixture independently checks actual HTTP payloads. */
export async function exerciseRenderedReasoning(
	cdp: CdpConnection,
	initialSession: string,
	workbenchSession: string,
	directory: string,
	nonce: string,
	signal?: AbortSignal,
) {
	let sessionId = initialSession
	const initialTargets = await cdp.request<{ targetInfos: Array<{ targetId: string }> }>("Target.getTargets")
	const initialTargetIds = new Set(initialTargets.targetInfos.map((target) => target.targetId))
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
		waitUntil(() => evaluate<boolean>(expression), Date.now() + 15_000, `reasoning_render_timeout: ${expression}`)
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
	const focus = async (selector: string) => {
		await check(
			`(()=>{const e=d.querySelector(${JSON.stringify(selector)});return !!e&&!e.disabled&&e.getBoundingClientRect().width>0})()`,
		)
		assert.equal(
			await evaluate(
				`(()=>{const e=d.querySelector(${JSON.stringify(selector)});e.focus();return d.activeElement===e})()`,
			),
			true,
			`Could not focus ${selector}`,
		)
	}
	const capture = async (stage: string) => {
		await check("!d.getAnimations().some(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity)")
		const screenshot = await cdp.request<{ data: string }>(
			"Page.captureScreenshot",
			{ format: "png" },
			workbenchSession,
		)
		await fs.writeFile(path.join(directory, `ui-${stage}.png`), Buffer.from(screenshot.data, "base64"))
		await fs.writeFile(path.join(directory, `ui-${stage}.txt`), await evaluate<string>("d.body.innerText"))
		await fs.writeFile(
			path.join(directory, `ui-${stage}-focus.json`),
			JSON.stringify(
				await evaluate(
					"({active:d.activeElement?.outerHTML,dialogs:d.querySelectorAll('[role=dialog]').length})",
				),
			),
		)
	}
	const stages = ["reasoning-high", "reasoning-reload", "reasoning-fallback", "reasoning-editor"]
	try {
		for (const stage of stages) {
			await waitUntil(
				async () => {
					try {
						const value = JSON.parse(
							await fs.readFile(path.join(directory, `ui-stage-${stage}.json`), "utf8"),
						)
						assert.equal(value.nonce, nonce)
						return true
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
						throw error
					}
				},
				Date.now() + 60_000,
				`reasoning_${stage}_timeout`,
			)
			if (stage === "reasoning-editor") {
				// Opening an editor panel creates another webview target. Attach only to this owned host.
				await waitUntil(
					async () => {
						const targets = await cdp.request<{ targetInfos: Array<{ targetId: string; url: string }> }>(
							"Target.getTargets",
						)
						for (const target of [...targets.targetInfos]
							.reverse()
							.filter(
								(target) =>
									!initialTargetIds.has(target.targetId) &&
									target.url.includes("extensionId=AlphaInc.alpha"),
							)) {
							const attached = await cdp.request<{ sessionId: string }>("Target.attachToTarget", {
								targetId: target.targetId,
								flatten: true,
							})
							sessionId = attached.sessionId
							if (await evaluate<boolean>("!!d.querySelector('[data-testid=reasoning-trigger]')"))
								return true
						}
						return false
					},
					Date.now() + 15_000,
					"reasoning_editor_timeout",
				)
				await check("d.body.innerText.includes('Continue with the selected reasoning.')")
			}
			await focus("[data-testid=reasoning-trigger]")
			if (stage === "reasoning-high") {
				await key("Enter", "Enter", 13)
				await check("!!d.querySelector('[role=slider][aria-label=Reasoning]')")
				await evaluate("d.querySelector('[role=slider][aria-label=Reasoning]').focus()")
				await key("End", "End", 35)
				await check(
					"d.querySelector('[data-testid=reasoning-trigger]')?.getAttribute('aria-label')==='Reasoning: High'",
				)
				await capture(stage)
				await focus("textarea")
				await cdp.request(
					"Input.insertText",
					{ text: "Continue with the selected reasoning." },
					workbenchSession,
				)
				await key("Enter", "Enter", 13)
			} else {
				const expected = stage === "reasoning-fallback" ? "Unavailable" : "High"
				await check(
					`d.querySelector('[data-testid=reasoning-trigger]')?.getAttribute('aria-label')===${JSON.stringify(`Reasoning: ${expected}`)}`,
				)
				await key("Enter", "Enter", 13)
				await check("!!d.querySelector('[role=dialog]')")
				if (stage === "reasoning-fallback") {
					assert.equal(await evaluate("!!d.querySelector('[role=slider][aria-label=Reasoning]')"), false)
					assert.equal(await evaluate("d.body.innerText.includes('Requested High; using Off.')"), true)
				}
				await capture(stage)
				await key("Escape", "Escape", 27)
				await check("d.activeElement===d.querySelector('[data-testid=reasoning-trigger]')")
			}
			assert.equal(
				await evaluate(
					"(()=>{const r=d.querySelector('[data-testid=reasoning-trigger]').getBoundingClientRect();return r.left>=0&&r.right<=d.defaultView.innerWidth&&r.width>0})()",
				),
				true,
			)
			await writeJsonAtomically(
				path.join(directory, `ui-done-${stage}.json`),
				{ nonce, stage, status: "passed" },
				{ rename: fs.link },
			)
		}
	} catch (error) {
		await capture("reasoning-failure").catch(() => undefined)
		throw error
	}
	return stages
}
