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
	let editorSession: string | undefined
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
	const key = async (key: string, code: string, keyCode: number, modifiers = 0) => {
		for (const type of ["keyDown", "keyUp"]) {
			await cdp.request(
				"Input.dispatchKeyEvent",
				{
					type,
					key,
					code,
					modifiers,
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
	const stages = [
		"reasoning-high",
		"reasoning-model-switch",
		"reasoning-reload",
		"reasoning-fallback",
		"reasoning-editor",
		...(process.platform === "win32"
			? [
					"hotkeys-queue",
					"hotkeys-steer",
					"hotkeys-previous",
					"hotkeys-next",
					"hotkeys-attention",
					"hotkeys-new",
					"hotkeys-editor-next",
					"hotkeys-editor-previous",
				]
			: []),
	]
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
			if (stage.startsWith("hotkeys-")) {
				if (stage.startsWith("hotkeys-editor-")) {
					assert.ok(editorSession)
					sessionId = editorSession
				} else {
					sessionId = initialSession
				}
				await focus("textarea")
				if (stage === "hotkeys-queue" || stage === "hotkeys-steer") {
					await cdp.request(
						"Input.insertText",
						{
							text:
								stage === "hotkeys-queue"
									? "Windows queue instruction."
									: "Windows steering instruction.",
						},
						workbenchSession,
					)
					if (stage === "hotkeys-queue") {
						await focus(
							'button[aria-label="Add message to queue (will be sent after current task completes)"]',
						)
						await key(" ", "Space", 32)
					} else await key("Enter", "Enter", 13)
					await check("d.querySelector('textarea').value===''")
				} else if (stage.endsWith("previous") || stage.endsWith("next")) {
					const previous = stage.endsWith("previous")
					await key(previous ? "PageUp" : "PageDown", previous ? "PageUp" : "PageDown", previous ? 33 : 34, 3)
					const prompt = previous ? "Complete the first fixture turn." : "Windows steering fixture"
					await check(
						`d.querySelector('[data-testid=chat-view]')?.innerText.includes(${JSON.stringify(prompt)})`,
					)
				} else if (stage === "hotkeys-attention") {
					await key("Home", "Home", 36, 3)
					await check(
						"d.querySelector('[data-testid=chat-view]')?.innerText.includes('Windows approval fixture')",
					)
				} else {
					await key("n", "KeyN", 78, 3)
					await check("!!d.querySelector('[data-testid=alpha-home-brand]')")
				}
				await capture(stage)
				await writeJsonAtomically(
					path.join(directory, `ui-done-${stage}.json`),
					{ nonce, stage, status: "passed" },
					{ rename: fs.link },
				)
				continue
			}
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
				editorSession = sessionId
			}
			await focus("[data-testid=reasoning-trigger]")
			if (stage === "reasoning-high") {
				if (process.platform === "win32") {
					await focus("textarea")
					await key(".", "Period", 190, 1)
					await check(
						"d.querySelector('[data-testid=reasoning-trigger]')?.getAttribute('aria-label')==='Reasoning: High'",
					)
					await key(",", "Comma", 188, 1)
					await check(
						"d.querySelector('[data-testid=reasoning-trigger]')?.getAttribute('aria-label')==='Reasoning: Low'",
					)
					await key(".", "Period", 190, 1)
					await check(
						"d.querySelector('[data-testid=reasoning-trigger]')?.getAttribute('aria-label')==='Reasoning: High'",
					)
					assert.equal(await evaluate("d.querySelector('textarea').value"), "")
				}
				await focus("[data-testid=reasoning-trigger]")
				await key("Enter", "Enter", 13)
				await check("!!d.querySelector('[role=slider][aria-label=Reasoning]')")
				await evaluate("d.querySelector('[role=slider][aria-label=Reasoning]').focus()")
				await key("End", "End", 35)
				await check(
					"d.querySelector('[data-testid=reasoning-trigger]')?.getAttribute('aria-label')==='Reasoning: High'",
				)
				await capture(stage)
			} else if (stage === "reasoning-model-switch") {
				const startedAt = Date.now()
				await focus("[data-testid=dropdown-trigger]")
				await key("Enter", "Enter", 13)
				await check("d.body.innerText.includes('GPT 5.6 Luna')")
				const profileFocused = await evaluate<boolean>(
					"(()=>{const e=[...d.querySelectorAll('button')].find(b=>b.textContent?.includes('GPT 5.6 Luna'));if(!e)return false;e.focus();return d.activeElement===e})()",
				)
				assert.equal(profileFocused, true, "The GPT 5.6 Luna profile was not focusable")
				await key("Enter", "Enter", 13)
				await check(
					"(()=>{const config=d.querySelector('[data-testid=dropdown-trigger]');const reasoning=d.querySelector('[data-testid=reasoning-trigger]');return config?.textContent?.includes('GPT 5.6 Luna')&&reasoning&&!reasoning.disabled&&reasoning.getAttribute('aria-busy')==='false'&&reasoning.getAttribute('aria-label')==='Reasoning: High'})()",
				)
				const durationMs = Date.now() - startedAt
				assert.ok(
					durationMs <= 5000,
					`GPT 5.6 Luna and reasoning controls took ${durationMs}ms to become ready`,
				)
				await fs.writeFile(
					path.join(directory, "ui-model-switch-timing.json"),
					JSON.stringify({
						from: "GPT 6 Luna",
						fromModelId: "gpt-6-luna",
						to: "GPT 5.6 Luna",
						modelId: "gpt-5.6-luna",
						reasoning: "high",
						durationMs,
						maxDurationMs: 5000,
						status: "passed",
					}),
				)
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
				if (stage === "reasoning-editor" && process.platform === "win32") {
					await focus("textarea")
					await key(",", "Comma", 188, 1)
					await check(
						"d.querySelector('[data-testid=reasoning-trigger]')?.getAttribute('aria-label')==='Reasoning: Low'",
					)
					await key(".", "Period", 190, 1)
					await check(
						"d.querySelector('[data-testid=reasoning-trigger]')?.getAttribute('aria-label')==='Reasoning: High'",
					)
				}
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
