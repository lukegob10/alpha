import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import type { CdpConnection } from "./cdp"
import { javascriptLiteral } from "./javascriptLiteral"
import { exerciseRenderedSelectionLayout } from "./renderedSelectionLayout"
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
			await acknowledge(`transcript-compact-${cycle}`)
			await sample(`transcript-busy-${cycle}`)
			await acknowledge(`transcript-busy-${cycle}`)
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
		assert.equal(fatalEventCount, 0, "The renderer must not emit unhandled exceptions or crash notifications")
		assert.deepEqual(violations, [], "Following a growing transcript must keep its mounted rows bounded")
		return [
			"selected-task-before-hydration",
			"bounded-growing-transcript",
			"three-real-compactions",
			"hidden-reveal",
			"browsing-preserved",
			...selectionStages,
			"no-renderer-fatal-events",
		]
	} finally {
		await persist()
		stopObserving()
	}
}
