import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import type { CdpConnection, CdpEvent } from "./cdp"
import { javascriptLiteral } from "./javascriptLiteral"

export const SELECTION_LAYOUT_ROUNDS = 24

export const selectionLayoutStage = (phase: "before" | "after", round: number): string =>
	`selection-layout-${phase}-${String.fromCharCode(97 + round)}`

interface NativePhases {
	layout: number
	compositing: number
	hitTest: number
}

/** Count known native phases in the process identified by Alpha's own performance mark. */
export class SelectionLayoutTrace {
	private readonly processes = new Map<number, NativePhases>()
	private readonly markerProcesses = new Set<number>()
	private records = 0
	private overflow = false
	constructor(
		private readonly marker: string,
		private readonly limit = 500_000,
	) {}

	observe(event: CdpEvent): void {
		if (event.method !== "Tracing.dataCollected" || !Array.isArray(event.params?.value)) return
		const entries: unknown[] = event.params.value
		for (const entry of entries) {
			if (++this.records > this.limit) {
				this.overflow = true
				return
			}
			if (!entry || typeof entry !== "object" || !("name" in entry) || !("pid" in entry)) continue
			const { name, pid } = entry
			if (typeof name !== "string" || typeof pid !== "number" || !Number.isSafeInteger(pid)) continue
			if (name === this.marker) {
				if (this.markerProcesses.size < 2) this.markerProcesses.add(pid)
				continue
			}
			const phase =
				name === "UpdateLayoutTree"
					? "layout"
					: name === "LocalFrameView::RunCompositingInputsLifecyclePhase"
						? "compositing"
						: name.includes("HitTest")
							? "hitTest"
							: undefined
			if (!phase) continue
			let counts = this.processes.get(pid)
			if (!counts) {
				if (this.processes.size >= 32) {
					this.overflow = true
					continue
				}
				counts = { layout: 0, compositing: 0, hitTest: 0 }
				this.processes.set(pid, counts)
			}
			counts[phase]++
		}
	}

	snapshot() {
		const rendererPids = [...this.markerProcesses]
		return {
			records: Math.min(this.records, this.limit + 1),
			overflow: this.overflow,
			rendererPids,
			phases:
				rendererPids.length === 1
					? { ...(this.processes.get(rendererPids[0]!) ?? { layout: 0, compositing: 0, hitTest: 0 }) }
					: { layout: 0, compositing: 0, hitTest: 0 },
		}
	}
}

interface SelectionSample {
	documentRetained: boolean
	selectionChanges: number
	trustedMouseMoves: number
	trustedMouseReleases: number
	focusChanges: number
	mutationBatches: number
	detachedSelections: number
	rangePresent: boolean
	toolbarVisible: boolean
	composerVisible: boolean
}

interface SelectionDriver {
	evaluate<T>(expression: string): Promise<T>
	ready(stage: string): Promise<unknown>
	acknowledge(stage: string): Promise<unknown>
}

/** Native input and real React row updates exercise selection painting without a model or timing sleeps. */
export async function exerciseRenderedSelectionLayout(
	cdp: CdpConnection,
	workbenchSession: string,
	directory: string,
	nonce: string,
	driver: SelectionDriver,
	signal?: AbortSignal,
): Promise<string[]> {
	const { evaluate, ready, acknowledge } = driver
	const marker = `alpha-selection-layout-${nonce}`
	const trace = new SelectionLayoutTrace(marker)
	const observations: Array<{ round: number; phase: string; sample: SelectionSample }> = []
	let traceStarted = false
	let failure: unknown
	let completionTimer: NodeJS.Timeout | undefined
	let resolveTrace!: () => void
	const completed = new Promise<void>((resolve) => (resolveTrace = resolve))
	const stopObserving = cdp.observe((event) => {
		trace.observe(event)
		if (event.method === "Tracing.tracingComplete") resolveTrace()
	})
	const sample = () =>
		evaluate<SelectionSample>(`(()=>{const s=d.defaultView.__alphaSelectionLayout;
			const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
			return {documentRetained:s?.nonce===${javascriptLiteral(nonce)},selectionChanges:s?.selectionChanges??0,
				trustedMouseMoves:s?.trustedMouseMoves??0,trustedMouseReleases:s?.trustedMouseReleases??0,focusChanges:s?.focusChanges??0,
				mutationBatches:s?.mutationBatches??0,detachedSelections:s?.detachedSelections??0,
				rangePresent:!!d.getSelection()?.rangeCount&&!d.getSelection().isCollapsed,
				toolbarVisible:visible(d.querySelector('.chat-toolbar')),
				composerVisible:visible(d.querySelector('[data-testid=chat-bottom-dock] textarea'))}})()`)
	const persist = () =>
		fs.writeFile(
			path.join(directory, "ui-selection-layout.json"),
			JSON.stringify(
				{ nonce, rounds: SELECTION_LAYOUT_ROUNDS, observations, nativeTrace: trace.snapshot() },
				null,
				2,
			),
		)
	try {
		await ready(selectionLayoutStage("before", 0))
		await cdp.request("Tracing.start", {
			categories: "blink,benchmark,devtools.timeline,blink.user_timing",
			options: "record-until-full",
			transferMode: "ReportEvents",
		})
		traceStarted = true
		await evaluate(`(()=>{const content=d.querySelector('[data-testid=chat-transcript-content]');
			const scroller=d.querySelector('[data-testid=chat-transcript-scroller]');
			scroller.scrollTop=scroller.scrollHeight;scroller.dispatchEvent(new d.defaultView.Event('scroll',{bubbles:true}));
			const s={nonce:${javascriptLiteral(nonce)},selectionChanges:0,trustedMouseMoves:0,trustedMouseReleases:0,focusChanges:0,
				mutationBatches:0,detachedSelections:0,anchor:null,oldWidth:content.style.maxWidth};
			const selection=()=>s.selectionChanges++;
			const mouse=e=>{if(e.isTrusted)s.trustedMouseMoves++};
			const release=e=>{if(e.isTrusted)s.trustedMouseReleases++};
			const focus=()=>s.focusChanges++;
			const observer=new d.defaultView.MutationObserver(()=>{s.mutationBatches++;
				if(s.anchor&&!s.anchor.isConnected){s.detachedSelections++;s.anchor=null}});
			observer.observe(content,{childList:true,subtree:true,characterData:true});
			d.addEventListener('selectionchange',selection);d.addEventListener('mousemove',mouse);
			d.addEventListener('mouseup',release);
			d.addEventListener('focusin',focus);
			s.dispose=()=>{observer.disconnect();d.removeEventListener('selectionchange',selection);
				d.removeEventListener('mousemove',mouse);d.removeEventListener('focusin',focus);
				d.removeEventListener('mouseup',release);
				content.style.maxWidth=s.oldWidth;d.getSelection()?.removeAllRanges();
				d.defaultView.performance.clearMarks(${javascriptLiteral(marker)});delete d.defaultView.__alphaSelectionLayout};
			d.defaultView.__alphaSelectionLayout=s;d.defaultView.performance.mark(${javascriptLiteral(marker)});return true})()`)
		await evaluate(
			"new Promise(resolve=>d.defaultView.requestAnimationFrame(()=>d.defaultView.requestAnimationFrame(resolve)))",
		)
		for (let round = 0; round < SELECTION_LAYOUT_ROUNDS; round++) {
			signal?.throwIfAborted()
			await ready(selectionLayoutStage("before", round))
			for (const phase of ["before", "after"] as const) {
				if (phase === "after") await ready(selectionLayoutStage("after", round))
				const owner = await cdp.request<{ result: { value: { x: number; y: number } } }>(
					"Runtime.evaluate",
					{
						expression: `(()=>{const f=[...document.querySelectorAll('iframe')].find(e=>e.src.includes('extensionId=AlphaInc.alpha')&&e.getBoundingClientRect().width>0);
							if(!f)throw new Error('Alpha frame owner missing');const r=f.getBoundingClientRect();return {x:r.left,y:r.top}})()`,
						returnByValue: true,
					},
					workbenchSession,
				)
				assert.ok(owner.result.value, "Native pointer coordinates must resolve to Alpha's frame")
				const width = (round + (phase === "after" ? 1 : 0)) % 2 ? "280px" : "100%"
				const prepareSelection = () =>
					evaluate<{ x: number; y: number; selectedCharacters: number }>(`(()=>{
					const content=d.querySelector('[data-testid=chat-transcript-content]');
					const scroller=d.querySelector('[data-testid=chat-transcript-scroller]');
					const s=d.defaultView.__alphaSelectionLayout;if(s?.nonce!==${javascriptLiteral(nonce)})throw new Error('Selection fixture document changed');
					if(${round % 3 === 0}){const t=d.querySelector('[data-testid=chat-bottom-dock] textarea');t.focus();t.setSelectionRange(0,0)}else d.activeElement?.blur?.();
					const r=scroller.getBoundingClientRect();const frame=document.getElementById('active-frame')?.getBoundingClientRect();
					const rows=[...content.querySelectorAll('[data-chat-message-index]')];if(${round % 2 !== 0})rows.reverse();
					let text;for(const row of rows){const walker=d.createTreeWalker(row.querySelector('p,pre code')??row,d.defaultView.NodeFilter.SHOW_TEXT);
						let node;while(node=walker.nextNode()){if((node.textContent?.trim().length??0)>=8){text=node;break}}if(text)break}
					if(!text?.textContent?.length)throw new Error('Selection fixture needs real row text');
					const range=d.createRange();range.setStart(text,0);range.setEnd(text,Math.min(24,text.textContent.length));
					const selection=d.getSelection();selection.removeAllRanges();selection.addRange(range);s.anchor=text;
					content.style.maxWidth=${javascriptLiteral(width)};
					return {x:(frame?.left??0)+r.left+Math.min(r.width/2,120),
						y:(frame?.top??0)+r.top+Math.min(r.height/2,80),selectedCharacters:range.endOffset}})()`)
				const point = await prepareSelection()
				assert.ok(
					point.selectedCharacters > 0,
					"Every native hit test must start with a noncollapsed text range",
				)
				// Read geometry before selecting/dirtying layout, then route native input before awaiting paint.
				for (const offset of [0, 12, -8])
					await cdp.request(
						"Input.dispatchMouseEvent",
						{
							type: "mouseMoved",
							x: owner.result.value.x + point.x + offset,
							y: owner.result.value.y + point.y,
						},
						workbenchSession,
					)
				if (phase === "after") {
					const pointer = { x: owner.result.value.x + point.x, y: owner.result.value.y + point.y }
					await cdp.request(
						"Input.dispatchMouseEvent",
						{ type: "mousePressed", ...pointer, button: "left", buttons: 1, clickCount: 1 },
						workbenchSession,
					)
					// A press can collapse selection. Establish the pending range again before the native release path.
					assert.ok((await prepareSelection()).selectedCharacters > 0)
					await cdp.request(
						"Input.dispatchMouseEvent",
						{ type: "mouseReleased", ...pointer, button: "left", buttons: 0, clickCount: 1 },
						workbenchSession,
					)
				}
				await evaluate(
					"new Promise(resolve=>d.defaultView.requestAnimationFrame(()=>d.defaultView.requestAnimationFrame(resolve)))",
				)
				const current = await sample()
				observations.push({ round, phase, sample: current })
				await persist()
				assert.ok(current.documentRetained, "A reload must not conceal a renderer failure")
				assert.ok(
					current.toolbarVisible && current.composerVisible,
					"The complete chat surface must remain visible",
				)
				// Highlighting or transcript eviction can legitimately remove the selected node and collapse its range.
				// Every input starts with a range; surviving those native updates is the invariant under test.
				await acknowledge(selectionLayoutStage(phase, round))
			}
		}
		const last = observations.at(-1)!.sample
		assert.ok(last.trustedMouseReleases >= SELECTION_LAYOUT_ROUNDS, "Native releases must reach Alpha's document")
		assert.ok(
			last.trustedMouseMoves >= SELECTION_LAYOUT_ROUNDS,
			"Trusted pointer input must reach Alpha's document",
		)
		assert.ok(last.selectionChanges >= SELECTION_LAYOUT_ROUNDS, "The browser must process real range changes")
		assert.ok(last.mutationBatches >= SELECTION_LAYOUT_ROUNDS, "Selected chat rows must actually change")
		assert.ok(last.detachedSelections > 0, "The test must replace selected DOM nodes")
		assert.ok(last.focusChanges >= SELECTION_LAYOUT_ROUNDS / 3, "The test must repeatedly change composer focus")
	} catch (error) {
		failure = error
	} finally {
		if (traceStarted) {
			try {
				await cdp.request("Tracing.end")
				await Promise.race([
					completed,
					new Promise<never>((_, reject) => {
						completionTimer = setTimeout(
							() => reject(new Error("Selection trace completion timeout")),
							5_000,
						)
					}),
				])
			} catch (error) {
				failure ??= error
			}
		}
		clearTimeout(completionTimer)
		try {
			await evaluate("d.defaultView.__alphaSelectionLayout?.dispose()")
		} catch (error) {
			failure ??= error
		}
		stopObserving()
		await persist()
	}
	if (failure) throw failure
	const native = trace.snapshot()
	assert.equal(native.overflow, false, "Native trace evidence must stay within its bound")
	assert.equal(native.rendererPids.length, 1, "Native phases must belong to the original Alpha renderer")
	assert.ok(native.phases.layout > 0, "Alpha's renderer must execute native style/layout updates")
	assert.ok(native.phases.compositing > 0, "Alpha's renderer must enter the compositing phase from the crash path")
	assert.ok(native.phases.hitTest > 0, "Alpha's renderer must execute native hit testing")
	await ready("selection-layout-finished")
	await acknowledge("selection-layout-finished")
	return [
		"selected-row-replacement",
		"selection-focus-reflow",
		"trusted-pointer-hit-tests",
		"native-layout-phase-evidence",
	]
}
