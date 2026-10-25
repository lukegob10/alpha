import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import type { CdpConnection } from "./cdp"
import { javascriptLiteral } from "./javascriptLiteral"
import { exerciseRenderedSelectionLayout } from "./renderedSelectionLayout"
import { exerciseUnattendedLifecycle } from "./renderedUnattendedLifecycle"
import { waitUntil } from "../evidence/sharedStorageProtocol"
import { writeJsonAtomically } from "../suite/preflightEvidence"

interface TranscriptSample {
	totalRows: number
	renderedRows: number
	actualRows: number
	firstIndex: number
	bottomGap: number
	toolbarVisible: boolean
	composerVisible: boolean
	composerDisabled: boolean
	textLength: number
}

export const TURN_DISCLOSURE_THEMES = [
	{ stage: "turn-dark", theme: "Default Dark Modern", className: "vscode-dark" },
	{ stage: "turn-light", theme: "Default Light Modern", className: "vscode-light" },
	{ stage: "turn-contrast", theme: "Default High Contrast", className: "vscode-high-contrast" },
] as const

/** Exercise the built App and real ChatRows in the owned reference Chromium renderer. */
export async function exerciseRenderedTranscriptLifecycle(
	cdp: CdpConnection,
	sessionId: string,
	workbenchSession: string,
	directory: string,
	nonce: string,
	signal?: AbortSignal,
): Promise<string[]> {
	const observations: unknown[] = []
	const violations: string[] = []
	const fatalEvents: Array<{ method: string; text: string }> = []
	let fatalEventCount = 0
	const stopObserving = cdp.observe((event) => {
		if (
			(event.sessionId === sessionId || event.sessionId === undefined) &&
			["Runtime.exceptionThrown", "Inspector.targetCrashed", "Target.targetCrashed"].includes(event.method)
		) {
			fatalEventCount++
			if (fatalEvents.length < 32)
				fatalEvents.push({ method: event.method, text: JSON.stringify(event.params ?? {}).slice(0, 1_000) })
		}
	})
	const persist = () =>
		fs.writeFile(
			path.join(directory, "ui-transcript-lifecycle.json"),
			JSON.stringify(
				{ nonce, hostVersion: "1.138.0", observations, violations, fatalEventCount, fatalEvents },
				null,
				2,
			),
		)
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
		assert.equal(result.exceptionDetails, undefined, "Renderer observation must execute")
		return result.result.value
	}
	const ready = (stage: string) =>
		waitUntil(
			async () => {
				signal?.throwIfAborted()
				try {
					const detail = JSON.parse(await fs.readFile(path.join(directory, `ui-stage-${stage}.json`), "utf8"))
					assert.equal(detail.nonce, nonce)
					assert.equal(detail.version, "1.138.0")
					return true
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
					throw error
				}
			},
			Date.now() + 60_000,
			`transcript_${stage}_timeout`,
		)
	const acknowledge = (stage: string) =>
		writeJsonAtomically(
			path.join(directory, `ui-done-${stage}.json`),
			{ nonce, stage, status: "passed" },
			{ rename: fs.link },
		)
	const enter = async () => {
		for (const type of ["keyDown", "keyUp"])
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
	const activate = async (expression: string) => {
		assert.equal(
			await evaluate<boolean>(
				`(()=>{const e=${expression};if(!e||e.disabled)return false;e.focus();return d.activeElement===e})()`,
			),
			true,
		)
		await enter()
	}
	const readSample = () =>
		evaluate<TranscriptSample>(`(()=>{const c=d.querySelector('[data-testid=chat-transcript-content]');
			const s=d.querySelector('[data-testid=chat-transcript-scroller]');
			const rows=[...d.querySelectorAll('[data-chat-message-index]')];
			const textarea=d.querySelector('[data-testid=chat-bottom-dock] textarea');
			const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0&&d.defaultView.getComputedStyle(e).visibility!=='hidden';
			return {totalRows:Number(c?.getAttribute('data-count')??0),renderedRows:Number(c?.getAttribute('data-rendered-count')??0),
				actualRows:rows.length,firstIndex:Number(rows[0]?.getAttribute('data-chat-message-index')??-1),
				bottomGap:s?s.scrollHeight-s.clientHeight-s.scrollTop:-1,
				toolbarVisible:visible(d.querySelector('.chat-toolbar')),composerVisible:visible(textarea),
				composerDisabled:!!textarea?.disabled,textLength:d.body?.innerText.length??0}})()`)
	const sample = async (stage: string, visible = true, following = true) => {
		await ready(stage)
		if (visible) {
			await waitUntil(
				async () => {
					const state = await readSample()
					return state.toolbarVisible && state.composerVisible && state.totalRows >= 1_200
				},
				Date.now() + 15_000,
				`transcript_${stage}_paint_timeout`,
			)
			await evaluate(
				"new Promise(resolve=>d.defaultView.requestAnimationFrame(()=>d.defaultView.requestAnimationFrame(resolve)))",
			)
		}
		const state = await readSample()
		const dom = await cdp.request<{ documents: number; nodes: number; jsEventListeners: number }>(
			"Memory.getDOMCounters",
			{},
			sessionId,
		)
		const heap = await cdp.request<{ usedSize: number; totalSize: number }>("Runtime.getHeapUsage", {}, sessionId)
		observations.push({ stage, ...state, dom, heap: { usedBytes: heap.usedSize, totalBytes: heap.totalSize } })
		if (visible && following) {
			assert.ok(state.bottomGap <= 8, `${stage} must exercise following at the bottom of the transcript`)
			assert.equal(
				state.actualRows,
				state.renderedRows,
				"Mounted row elements must agree with the transcript window",
			)
			if (state.renderedRows > 80)
				violations.push(`${stage}: following mounted ${state.renderedRows} rows instead of at most 80`)
		}
		await persist()
		return state
	}
	try {
		await cdp.request("Runtime.enable", {}, sessionId)
		await cdp.request("Inspector.enable", {}, sessionId)
		await cdp.request("Page.bringToFront", {}, workbenchSession)
		await ready("transcript-selected")
		await evaluate(`(d.defaultView.__alphaTranscriptBeforeReload=${javascriptLiteral(nonce)})`)
		await acknowledge("transcript-selected")
		await ready("transcript-hydrated")
		await waitUntil(
			() =>
				evaluate<boolean>(
					`!!d.querySelector('[data-testid=chat-transcript-content]')&&d.defaultView.__alphaTranscriptBeforeReload!==${javascriptLiteral(nonce)}`,
				),
			Date.now() + 20_000,
			"transcript_rehydration_timeout",
		)
		const initial = await sample("transcript-hydrated")
		assert.equal(initial.renderedRows, 80, "The restored selected task must mount the newest 80 rows first")
		await acknowledge("transcript-hydrated")
		for (const cycle of ["one", "two", "three"]) {
			await sample(`transcript-growing-${cycle}`)
			await acknowledge(`transcript-growing-${cycle}`)
			await sample(`transcript-compact-${cycle}`)
			if (cycle === "three") {
				await evaluate("d.querySelector('button[aria-label=\"Expand context details\"]').click()")
				const compactButton =
					"[...d.querySelectorAll('button')].find(e=>e.textContent.includes('Intelligently condense context'))"
				try {
					await waitUntil(
						() => evaluate<boolean>(`!!(${compactButton})&&!(${compactButton}).disabled`),
						Date.now() + 10_000,
						"transcript_compact_control_timeout",
					)
				} catch (error) {
					await fs.writeFile(
						path.join(directory, "ui-compaction-controls.json"),
						JSON.stringify(
							await evaluate(
								`([...d.querySelectorAll('button')].map(e=>({label:e.getAttribute('aria-label'),text:e.textContent.slice(0,90),disabled:e.disabled,expanded:e.getAttribute('aria-expanded')})))`,
							),
							null,
							2,
						),
					)
					throw error
				}
				await evaluate(`(${compactButton}).click()`)
			}
			await acknowledge(`transcript-compact-${cycle}`)
			// Opening the context details deliberately releases following before manual compaction.
			await sample(`transcript-busy-${cycle}`, true, cycle !== "three")
			if (cycle === "three") {
				await evaluate(`(d.defaultView.__alphaBeforeBusyReload=${javascriptLiteral(nonce)})`)
			}
			await acknowledge(`transcript-busy-${cycle}`)
			if (cycle === "three") {
				await ready("transcript-reloaded-busy")
				const rehydration: { stage: string; lastObserved?: unknown } = { stage: "reload-bootstrap" }
				observations.push(rehydration)
				await waitUntil(
					async () => {
						const state = await evaluate<{ documentReplaced: boolean; transcriptPresent: boolean }>(
							`({documentReplaced:d.defaultView.__alphaBeforeBusyReload!==${javascriptLiteral(nonce)},
								transcriptPresent:!!d.querySelector('[data-testid=chat-transcript-content]'),
								rootChildren:d.getElementById('root')?.childElementCount??-1,
								toolbarPresent:!!d.querySelector('.chat-toolbar')})`,
						)
						rehydration.lastObserved = state
						return state.documentReplaced && state.transcriptPresent
					},
					Date.now() + 20_000,
					"transcript_busy_rehydration_timeout",
				)
				await sample("transcript-reloaded-busy")
				await acknowledge("transcript-reloaded-busy")
			}
			if (cycle === "two") {
				await sample("transcript-hidden", false)
				await acknowledge("transcript-hidden")
				await sample("transcript-revealed")
				await acknowledge("transcript-revealed")
			}
			const completed = await sample(`transcript-compacted-${cycle}`)
			assert.equal(completed.composerDisabled, false, "Compaction must restore the composer")
			await acknowledge(`transcript-compacted-${cycle}`)
		}
		const unattendedStages = await exerciseUnattendedLifecycle(cdp, workbenchSession, directory, nonce, {
			evaluate,
			ready,
			acknowledge,
		})
		await ready("transcript-browse")
		await activate("d.querySelector('[data-testid=chat-load-older]')")
		const browsing = await sample("transcript-browse", true, false)
		assert.ok(browsing.renderedRows >= 180, "Load older must remain available")
		await acknowledge("transcript-browse")
		const appended = await sample("transcript-browse-appended", true, false)
		assert.equal(
			appended.firstIndex,
			browsing.firstIndex,
			"Appending while browsing must preserve the visible history",
		)
		await acknowledge("transcript-browse-appended")
		const selectionStages = await exerciseRenderedSelectionLayout(
			cdp,
			workbenchSession,
			directory,
			nonce,
			{ evaluate, ready, acknowledge },
			signal,
		)
		await ready("transcript-turn-disclosure")
		const parentToggle =
			"[...d.querySelectorAll('button[data-activity-trace-id]')].find(e=>e.dataset.activityTraceId.startsWith('turn:'))"
		await waitUntil(
			() => evaluate<boolean>(`!!(${parentToggle})&&d.body.innerText.includes('TURN_FINAL_EVIDENCE')`),
			Date.now() + 15_000,
			"transcript_turn_disclosure_timeout",
		)
		assert.equal(await evaluate(`(${parentToggle}).getAttribute('aria-expanded')`), "false")
		assert.equal(await evaluate("d.body.innerText.includes('TURN_OPENING_EVIDENCE')"), true)
		assert.equal(await evaluate("d.body.innerText.includes('TURN_STEERING_EVIDENCE')"), false)
		assert.equal(await evaluate("d.body.innerText.includes('TURN_COMMENTARY_EVIDENCE')"), false)
		await activate(parentToggle)
		await waitUntil(
			() =>
				evaluate<boolean>(
					"d.body.innerText.includes('TURN_STEERING_EVIDENCE')&&d.body.innerText.includes('TURN_COMMENTARY_EVIDENCE')",
				),
			Date.now() + 5_000,
			"transcript_turn_expand_timeout",
		)
		const reasoningToggle =
			"[...d.querySelectorAll('button.activity-row-header')].find(e=>e.textContent.includes('Thinking'))"
		await activate(reasoningToggle)
		await waitUntil(
			() => evaluate<boolean>("d.body.innerText.includes('TURN_REASONING_EVIDENCE')"),
			Date.now() + 5_000,
			"transcript_reasoning_expand_timeout",
		)
		await activate(parentToggle)
		assert.equal(await evaluate("d.body.innerText.includes('TURN_REASONING_EVIDENCE')"), false)
		await activate(parentToggle)
		await waitUntil(
			() => evaluate<boolean>("d.body.innerText.includes('TURN_REASONING_EVIDENCE')"),
			Date.now() + 5_000,
			"transcript_nested_choice_restore_timeout",
		)
		for (const width of [240, 320]) {
			const narrow = await evaluate<{
				overflow: number
				disclosureControls: number
				invalidControls: string[]
			}>(`(()=>{
				const content=d.querySelector('[data-testid=chat-transcript-content]');content.style.maxWidth='${width}px';
				const controls=[...content.querySelectorAll('[aria-controls]')];
				const invalidControls=controls.filter(e=>e.getAttribute('aria-controls').split(/\\s+/).filter(Boolean).some(id=>!d.getElementById(id))).map(e=>e.outerHTML.slice(0,1000));
				return {overflow:content.scrollWidth-content.clientWidth,disclosureControls:controls.length,invalidControls};})()`)
			observations.push({ stage: "turn-disclosure", width, ...narrow })
			assert.ok(narrow.overflow <= 1, `Turn controls must fit a ${width}px transcript`)
			assert.ok(narrow.disclosureControls >= 2, "The turn and nested disclosure controls must be mounted")
			assert.deepEqual(narrow.invalidControls, [], "Disclosure controls must reference mounted elements")
		}
		await evaluate("d.querySelector('[data-testid=chat-transcript-content]').style.maxWidth=''")
		await acknowledge("transcript-turn-disclosure")
		try {
			await cdp.request(
				"Emulation.setEmulatedMedia",
				{
					features: [{ name: "prefers-reduced-motion", value: "reduce" }],
				},
				sessionId,
			)
			for (const { stage, className } of TURN_DISCLOSURE_THEMES) {
				await ready(stage)
				await waitUntil(
					() => evaluate<boolean>(`d.body.classList.contains(${javascriptLiteral(className)})`),
					Date.now() + 5_000,
					`${stage}_theme_timeout`,
				)
				await waitUntil(
					() =>
						evaluate<boolean>(`(()=>{
							const reference=d.createElement('span');reference.style.color='var(--vscode-editor-foreground,var(--vscode-foreground))';d.body.append(reference);
							try {
								const native=d.defaultView.getComputedStyle(reference).color;
								const expected=${javascriptLiteral(className)}==='vscode-dark'?d.defaultView.getComputedStyle(d.querySelector('.app-shell')).color:native;
								const paragraphs=['TURN_COMMENTARY_EVIDENCE','TURN_FINAL_EVIDENCE'].map(text=>[...d.querySelectorAll('article p')].find(e=>e.textContent===text));
								return (${javascriptLiteral(className)}!=='vscode-high-contrast'||native==='rgb(255, 255, 255)')&&paragraphs.every(e=>!!e&&d.defaultView.getComputedStyle(e).color===expected);
							} finally {reference.remove();}
						})()`),
					Date.now() + 5_000,
					`${stage}_assistant_foreground_timeout`,
				)
				assert.equal(
					await evaluate("d.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches"),
					true,
				)
				const capture = async (name: string) => {
					const screenshot = await cdp.request<{ data: string }>(
						"Page.captureScreenshot",
						{ format: "png", captureBeyondViewport: false },
						workbenchSession,
					)
					await fs.writeFile(path.join(directory, name), Buffer.from(screenshot.data, "base64"))
				}
				for (const width of [240, 320]) {
					await evaluate(
						`d.querySelector('[data-testid=chat-transcript-content]').style.maxWidth='${width}px'`,
					)
					await activate(parentToggle)
					assert.equal(await evaluate("d.body.innerText.includes('TURN_STEERING_EVIDENCE')"), false)
					await capture(`ui-${stage}-${width}-collapsed.png`)
					await activate(parentToggle)
					assert.equal(await evaluate("d.body.innerText.includes('TURN_STEERING_EVIDENCE')"), true)
					assert.equal(await evaluate("d.body.innerText.includes('TURN_REASONING_EVIDENCE')"), true)
					await capture(`ui-${stage}-${width}.png`)
				}
				await acknowledge(stage)
			}
		} finally {
			await cdp.request("Emulation.setEmulatedMedia", { features: [] }, sessionId)
			await evaluate("d.querySelector('[data-testid=chat-transcript-content]').style.maxWidth=''")
		}
		assert.equal(fatalEventCount, 0, "The renderer must not emit unhandled exceptions or crash notifications")
		assert.deepEqual(violations, [], "Following a growing transcript must keep its mounted rows bounded")
		return [
			"selected-task-before-hydration",
			"bounded-growing-transcript",
			"three-real-compactions",
			"reload-during-queued-compaction",
			"hidden-reveal",
			...unattendedStages,
			"browsing-preserved",
			...selectionStages,
			"canonical-turn-steering-disclosure",
			"nested-disclosure-restored",
			"turn-themes-narrow-reduced-motion",
			"no-renderer-fatal-events",
		]
	} finally {
		await persist()
		stopObserving()
	}
}
