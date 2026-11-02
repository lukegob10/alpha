import { javascriptLiteral } from "./ui/javascriptLiteral"
import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { downloadAndUnzipVSCode } from "@vscode/test-electron"
import { ticketTypeSchema, type TicketType } from "@alpha-code/types"
import { runExtensionTests, type ExtensionTestRunResult } from "./runTest"
import { prepareTestProfile } from "./testProfile"
import { CdpConnection } from "./ui/cdp"
import { waitUntil } from "./evidence/sharedStorageProtocol"
import { writeJsonAtomically } from "./suite/preflightEvidence"

interface Target {
	targetId: string
	type: string
	url: string
}

export function assertTicketsUiHostResult(host: ExtensionTestRunResult): void {
	assert.ok(
		host.status === "passed" &&
			host.execution === "extension-host" &&
			host.ownershipGate === "verified" &&
			host.captureComplete === true &&
			host.hostExitObserved === true &&
			host.actualVSCodeVersion === "1.138.0" &&
			host.exitCode === 0,
		"Tickets renderer requires a passing, verified, complete VS Code 1.138.0 host result",
	)
}

interface TicketFixture {
	name: string
	type: TicketType
	status: "backlog" | "in-progress" | "complete" | "canceled"
	priority?: "high" | "medium" | "low"
}

const fixtures: TicketFixture[] = [
	{ name: "UI fixture bug", type: "bug", status: "in-progress", priority: "high" },
	{ name: "UI fixture feature", type: "feature", status: "backlog", priority: "medium" },
	{ name: "UI fixture improvement", type: "improvement", status: "backlog", priority: "low" },
	{ name: "UI fixture testing", type: "testing", status: "complete", priority: "medium" },
	{ name: "UI fixture performance", type: "performance", status: "canceled" },
	{ name: "UI fixture ux", type: "ux", status: "in-progress", priority: "low" },
	{ name: "UI fixture decision", type: "decision", status: "backlog", priority: "medium" },
	{ name: "UI fixture review", type: "review", status: "backlog", priority: "low" },
]

function ticketMarkdown(fixture: TicketFixture, id: string, reference: string, date: string): string {
	return [
		"---",
		"schemaVersion: 1",
		`id: ${javascriptLiteral(id)}`,
		`reference: ${reference}`,
		`name: ${javascriptLiteral(fixture.name)}`,
		`type: ${fixture.type}`,
		...(fixture.priority ? [`priority: ${fixture.priority}`] : []),
		`createdAt: ${javascriptLiteral(date)}`,
		`updatedAt: ${javascriptLiteral(date)}`,
		"linkedTaskIds: []",
		"---",
		"## Description",
		`Seeded ${fixture.type} ticket for the rendered Tickets UI fixture.`,
		"",
		"## Context",
		"This ticket belongs to an isolated temporary workspace and home directory.",
		"",
		"## Success criteria",
		"The ticket is visible in its status section and opens in the same panel.",
		"",
		"## Implementation summary",
		"Fixture content only.",
		"",
	].join("\n")
}

async function seedTicketStore(workspace: string, home: string): Promise<string[]> {
	const canonical = await fs.realpath(workspace)
	const key = process.platform === "win32" ? canonical.toLowerCase() : canonical
	const name =
		path
			.basename(canonical)
			.replace(/[^a-zA-Z0-9_-]/g, "-")
			.slice(0, 80) || "project"
	const projectId = `${name}-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`
	const directory = path.join(home, ".alpha", "tickets", projectId)
	const date = "2026-09-25T12:00:00.000Z"
	const files: string[] = []
	for (const [index, fixture] of fixtures.entries()) {
		const id = randomUUID()
		const file = path.join(directory, fixture.status, `${id}.md`)
		await fs.mkdir(path.dirname(file), { recursive: true })
		await fs.writeFile(file, ticketMarkdown(fixture, id, `ATU-${String(index + 1).padStart(2, "0")}`, date), "utf8")
		files.push(file)
	}
	return files
}

/** Uses a temporary workspace and home so the real TicketStore and webview never touch user tickets. */
export async function runTicketsUi(executable: string, output: string) {
	await fs.mkdir(output, { recursive: true })
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-tickets-ui-"))
	const nonce = randomUUID()
	const runId = `tickets-${nonce}`
	const evidenceRoot = path.join(root, "evidence")
	const directory = path.join(evidenceRoot, runId)
	const workspace = path.join(root, "Alpha Tickets UI")
	const profileDir = path.join(root, "profile")
	const artifactsDir = path.join(root, "artifacts")
	const isolatedHome = path.join(root, "isolated-home")
	const appData = path.join(isolatedHome, "AppData", "Roaming")
	const localAppData = path.join(isolatedHome, "AppData", "Local")
	await fs.mkdir(isolatedHome, { recursive: true })
	await fs.mkdir(appData, { recursive: true })
	await fs.mkdir(localAppData, { recursive: true })
	const profile = await prepareTestProfile({
		profileDir,
		workspace,
		artifactsDir,
		vscodeVersion: "1.138.0",
		initializeProfile: true,
	})
	const fixtureFiles = await seedTicketStore(profile.workspace, isolatedHome)
	const abort = new AbortController()
	const timer = setTimeout(() => abort.abort(), 240_000)
	let hostSettled = false
	const running = runExtensionTests({
		providerMode: "scripted",
		vscodeVersion: "1.138.0",
		vscodeExecutablePath: executable,
		testFile: "tickets-ui.test",
		rendererDebuggingPort: 0,
		runId,
		profileDir,
		workspace,
		artifactsDir: evidenceRoot,
		initializeProfile: true,
		retainEvidenceForCampaign: true,
		extensionTestsEnv: {
			ALPHA_UI_ACCEPTANCE_NONCE: nonce,
			ALPHA_UI_TICKETS_HOME: isolatedHome,
			HOME: isolatedHome,
			USERPROFILE: isolatedHome,
			HOMEDRIVE: path.parse(isolatedHome).root.slice(0, 2),
			HOMEPATH: `${path.sep}${path.relative(path.parse(isolatedHome).root, isolatedHome)}`,
			APPDATA: appData,
			LOCALAPPDATA: localAppData,
		},
		signal: abort.signal,
	}).finally(() => {
		hostSettled = true
	})
	const hostEnded = running.then(() => {
		throw new Error("Tickets host exited before renderer checks completed")
	})
	void hostEnded.catch(() => {})
	let cdp: CdpConnection | undefined
	try {
		const ready = (stage: string) =>
			Promise.race([
				hostEnded,
				waitUntil(
					async () => {
						abort.signal.throwIfAborted()
						if (hostSettled) throw new Error("Tickets host exited")
						try {
							const receipt = JSON.parse(
								await fs.readFile(path.join(directory, `ui-stage-${stage}.json`), "utf8"),
							)
							assert.equal(receipt.nonce, nonce)
							assert.equal(receipt.version, "1.138.0")
							return true
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
							throw error
						}
					},
					Date.now() + 75_000,
					`tickets_${stage}_timeout`,
				),
			])
		await ready("tickets-dark")
		const [port, endpoint] = (await fs.readFile(path.join(profile.userDataDir, "DevToolsActivePort"), "utf8"))
			.trim()
			.split(/\r?\n/)
		if (!port || !endpoint) throw new Error("Owned DevTools endpoint is incomplete")
		assert.match(port, /^\d{1,5}$/)
		cdp = await CdpConnection.connect(`ws://127.0.0.1:${port}${endpoint}`)
		const connection = cdp
		const findTargets = async () => {
			const { targetInfos } = await connection.request<{ targetInfos: Target[] }>("Target.getTargets")
			const webviews = targetInfos.filter((entry) => entry.url.includes("extensionId=AlphaInc.alpha"))
			const page = targetInfos.find((entry) => entry.type === "page" && entry.url.includes("workbench"))
			return { webviews, page }
		}
		let webviewSession: string | undefined
		let page: Target | undefined
		await waitUntil(
			async () => {
				const current = await findTargets()
				page = current.page
				if (!page) return false
				for (const candidate of current.webviews) {
					const { sessionId } = await connection.request<{ sessionId: string }>("Target.attachToTarget", {
						targetId: candidate.targetId,
						flatten: true,
					})
					let hasTicketPanel = false
					try {
						const probe = await connection.request<{ result: { value: boolean } }>(
							"Runtime.evaluate",
							{
								expression:
									"(()=>{const d=document.getElementById('active-frame')?.contentDocument??document;return !!d.querySelector('.tickets-app')})()",
								returnByValue: true,
							},
							sessionId,
						)
						hasTicketPanel = probe.result.value
					} catch {
						// Another Alpha webview can close while candidates are inspected; keep looking.
					}
					if (hasTicketPanel) {
						webviewSession = sessionId
						return true
					}
					await connection.request("Target.detachFromTarget", { sessionId }).catch(() => undefined)
				}
				return false
			},
			Date.now() + 30_000,
			"tickets_webview_target_timeout",
		)
		assert.ok(webviewSession, "Tickets webview was identified by its .tickets-app root")
		assert.ok(page, "Owned workbench target exists")
		const { sessionId: pageSession } = await connection.request<{ sessionId: string }>("Target.attachToTarget", {
			targetId: page.targetId,
			flatten: true,
		})
		await connection.request("Page.bringToFront", {}, pageSession)
		const evaluate = async <T>(expression: string): Promise<T> => {
			abort.signal.throwIfAborted()
			const result = await connection.request<{ result: { value: T }; exceptionDetails?: unknown }>(
				"Runtime.evaluate",
				{
					expression: `(()=>{const d=document.getElementById('active-frame')?.contentDocument??document;return (${expression})})()`,
					returnByValue: true,
				},
				webviewSession,
			)
			assert.equal(result.exceptionDetails, undefined)
			return result.result.value
		}
		const check = (expression: string, label = expression) =>
			Promise.race([
				hostEnded,
				waitUntil(() => evaluate<boolean>(expression), Date.now() + 20_000, `tickets_render_timeout: ${label}`),
			])
		const pressEnter = async () => {
			for (const type of ["keyDown", "keyUp"])
				await connection.request(
					"Input.dispatchKeyEvent",
					{
						type,
						key: "Enter",
						code: "Enter",
						windowsVirtualKeyCode: 13,
						...(type === "keyDown" ? { text: "\r" } : {}),
					},
					webviewSession,
				)
		}
		const capture = async (name: string) => {
			const screenshot = await connection.request<{ data: string }>(
				"Page.captureScreenshot",
				{ format: "png" },
				pageSession,
			)
			await fs.writeFile(path.join(directory, `${name}.png`), Buffer.from(screenshot.data, "base64"))
		}
		const exerciseSelection = async (stage: string) => {
			const selector = "d.querySelector('.ticket-row .ticket-selection')"
			const metrics = () =>
				evaluate<{
					opacity: string
					pointerEvents: string
					appearance: string
					background: string
					checked: boolean
					hovered: boolean
					focused: boolean
					left: number
					top: number
					width: number
					height: number
					nameLeft: number
					fine: boolean
					coarse: boolean
					noHover: boolean
				}>(
					`(()=>{const input=${selector};const style=d.defaultView.getComputedStyle(input);const row=input.closest('.ticket-row');const rect=input.getBoundingClientRect();return {opacity:style.opacity,pointerEvents:style.pointerEvents,appearance:style.appearance,background:style.backgroundColor,checked:input.checked,hovered:row.matches(':hover'),focused:row.matches(':focus-within'),left:rect.left,top:rect.top,width:rect.width,height:rect.height,nameLeft:row.querySelector('.ticket-row-name').getBoundingClientRect().left,fine:d.defaultView.matchMedia('(hover:hover) and (pointer:fine)').matches,coarse:d.defaultView.matchMedia('(any-pointer:coarse)').matches,noHover:d.defaultView.matchMedia('(hover:none)').matches}})()`,
				)
			const moveAway = async () => {
				await evaluate("d.querySelector('.tickets-search input').focus()")
				const owner = await frameOwner()
				const search = await evaluate<{ x: number; y: number }>(
					"(()=>{const r=d.querySelector('.tickets-search input').getBoundingClientRect();const frame=document.getElementById('active-frame')?.getBoundingClientRect();return {x:r.left+r.width/2+(frame?.left??0),y:r.top+r.height/2+(frame?.top??0)}})()",
				)
				await connection.request(
					"Input.dispatchMouseEvent",
					{ type: "mouseMoved", x: owner.x + search.x, y: owner.y + search.y },
					pageSession,
				)
			}
			const frameOwner = async () => {
				const { frameTree } = await connection.request<{ frameTree: { frame: { id: string } } }>(
					"Page.getFrameTree",
					{},
					webviewSession,
				)
				const { backendNodeId } = await connection.request<{ backendNodeId: number }>(
					"DOM.getFrameOwner",
					{ frameId: frameTree.frame.id },
					pageSession,
				)
				const { model } = await connection.request<{ model: { content: number[] } }>(
					"DOM.getBoxModel",
					{ backendNodeId },
					pageSession,
				)
				return { x: model.content[0]!, y: model.content[1]! }
			}
			await moveAway()
			const idle = await metrics()
			await capture(`${stage}-selection-idle`)
			await fs.copyFile(
				path.join(directory, `${stage}-selection-idle.png`),
				path.join(output, `${runId}-${stage}-selection-idle.png`),
			)
			await fs.writeFile(
				path.join(output, `${runId}-${stage}-selection-idle.json`),
				JSON.stringify({ directory, idle }, null, 2),
			)
			assert.equal(idle.fine, true, "Desktop fixture must exercise a hover-capable fine pointer")
			assert.equal(idle.checked, false)
			assert.equal(idle.hovered || idle.focused, false, "Idle row must not be hovered or focused")
			assert.equal(idle.opacity, "0", "Idle unchecked selection control must be hidden")
			assert.equal(idle.pointerEvents, "none", "Hidden selection control must not intercept pointer input")

			const origin = await frameOwner()
			const inner = await evaluate<{ left: number; top: number }>(
				"(()=>{const r=document.getElementById('active-frame')?.getBoundingClientRect();return {left:r?.left??0,top:r?.top??0}})()",
			)
			const pointer = {
				x: origin.x + inner.left + idle.left + idle.width / 2,
				y: origin.y + inner.top + idle.top + idle.height / 2,
			}
			await connection.request("Input.dispatchMouseEvent", { type: "mouseMoved", ...pointer }, pageSession)
			await check(`d.defaultView.getComputedStyle(${selector}).opacity==='1'`, `${stage}_selection_hover`)
			const hovered = await metrics()
			assert.equal(hovered.hovered, true, "Native pointer input must hover the actual ticket row")
			assert.equal(hovered.appearance, "none", "Muted checkbox uses theme styling, not the native white face")
			if (stage !== "tickets-light") assert.notEqual(hovered.background, "rgb(255, 255, 255)")
			assert.deepEqual(
				[hovered.left, hovered.top, hovered.width, hovered.height, hovered.nameLeft],
				[idle.left, idle.top, idle.width, idle.height, idle.nameLeft],
				"Revealing selection must not shift the row or ticket title",
			)
			await capture(`${stage}-selection-hover`)
			await moveAway()
			await check(`d.defaultView.getComputedStyle(${selector}).opacity==='0'`, `${stage}_selection_after_hover`)
			await evaluate(
				`${selector}.closest('tbody').previousElementSibling.querySelector('.ticket-group-toggle').focus()`,
			)
			for (const type of ["keyDown", "keyUp"])
				await connection.request(
					"Input.dispatchKeyEvent",
					{ type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
					webviewSession,
				)
			assert.equal(
				await evaluate(`d.activeElement===${selector}`),
				true,
				"Native Tab reaches the hidden checkbox",
			)
			await check(
				`d.defaultView.getComputedStyle(${selector}).opacity==='1'`,
				`${stage}_selection_keyboard_focus`,
			)
			for (const type of ["keyDown", "keyUp"])
				await connection.request(
					"Input.dispatchKeyEvent",
					{ type, key: " ", code: "Space", windowsVirtualKeyCode: 32 },
					webviewSession,
				)
			await check(
				`${selector}.checked && !!d.querySelector('.tickets-list') && !d.querySelector('#ticket-heading')`,
				`${stage}_selection_does_not_open_detail`,
			)
			await moveAway()
			await check(`d.defaultView.getComputedStyle(${selector}).opacity==='1'`, `${stage}_checked_persists`)
			const selected = await metrics()
			assert.equal(selected.hovered || selected.focused, false)
			assert.equal(selected.checked, true)
			await capture(`${stage}-selection-checked`)
			// Clear using the same keyboard path before checking touch/no-hover fallback.
			await evaluate(`${selector}.focus()`)
			for (const type of ["keyDown", "keyUp"])
				await connection.request(
					"Input.dispatchKeyEvent",
					{ type, key: " ", code: "Space", windowsVirtualKeyCode: 32 },
					webviewSession,
				)
			await check(`!${selector}.checked`, `${stage}_selection_cleared`)
			await moveAway()
			for (const type of ["mouseMoved", "mousePressed", "mouseReleased"] as const)
				await connection.request(
					"Input.dispatchMouseEvent",
					{
						type,
						...pointer,
						button: type === "mouseMoved" ? "none" : "left",
						clickCount: type === "mouseMoved" ? 0 : 1,
					},
					pageSession,
				)
			await check(
				`${selector}.checked && !!d.querySelector('.tickets-list') && !d.querySelector('#ticket-heading')`,
				`${stage}_native_mouse_selection`,
			)
			await evaluate(`${selector}.focus()`)
			for (const type of ["keyDown", "keyUp"])
				await connection.request(
					"Input.dispatchKeyEvent",
					{ type, key: " ", code: "Space", windowsVirtualKeyCode: 32 },
					webviewSession,
				)
			await check(`!${selector}.checked`, `${stage}_mouse_selection_cleared`)
			await moveAway()
			await connection.request(
				"Emulation.setTouchEmulationEnabled",
				{ enabled: true, maxTouchPoints: 1 },
				webviewSession,
			)
			let touch
			try {
				await check(
					"d.defaultView.matchMedia('(any-pointer:coarse)').matches && d.defaultView.matchMedia('(hover:none)').matches",
					`${stage}_real_touch_media`,
				)
				await check(
					`d.defaultView.getComputedStyle(${selector}).opacity==='1'`,
					`${stage}_touch_selection_visible`,
				)
				touch = await metrics()
				assert.equal(touch.pointerEvents, "auto", "Touch users can reach unchecked selection without hover")
				await capture(`${stage}-selection-touch`)
				const touchPoint = {
					x: origin.x + inner.left + touch.left + touch.width / 2,
					y: origin.y + inner.top + touch.top + touch.height / 2,
				}
				await evaluate(
					"(()=>{const types=['touchstart','touchend','touchcancel','pointerdown','pointerup','pointercancel','click'];const events=[];const record=e=>{if(events.length>=12)return;const entry={type:e.type,checkbox:e.target.matches('.ticket-selection'),prevented:e.defaultPrevented};events.push(entry);d.defaultView.queueMicrotask(()=>entry.prevented=e.defaultPrevented)};for(const type of types)d.addEventListener(type,record,true);d.defaultView.__ticketTouchEvidence={events,dispose:()=>{for(const type of types)d.removeEventListener(type,record,true)}}})()",
				)
				await connection.request(
					"Input.synthesizeTapGesture",
					{ ...touchPoint, gestureSourceType: "touch", tapCount: 1, duration: 50 },
					pageSession,
				)
				try {
					await check(
						"['pointerdown','touchstart','pointerup','touchend'].every(type=>d.defaultView.__ticketTouchEvidence.events.some(e=>e.type===type&&e.checkbox&&!e.prevented))",
						`${stage}_native_touch_reaches_checkbox`,
					)
					assert.equal(
						await evaluate("!!d.querySelector('.tickets-list') && !d.querySelector('#ticket-heading')"),
						true,
						"Native touch on selection does not navigate to detail",
					)
					// This host's synthetic touch does not produce compatibility clicks, even on an unchanged native control.
					// Assert the complete unprevented touch path; native mouse and keyboard activation are checked above.
					assert.equal(
						await evaluate(`${selector}.checked`),
						await evaluate(
							"d.defaultView.__ticketTouchEvidence.events.some(e=>e.type==='click'&&e.checkbox)",
						),
					)
				} finally {
					const touchEvidence = await evaluate(
						"(()=>{const evidence=d.defaultView.__ticketTouchEvidence;const result={events:evidence.events,active:d.activeElement.tagName};evidence.dispose();delete d.defaultView.__ticketTouchEvidence;return result})()",
					)
					await fs.writeFile(
						path.join(output, `${runId}-${stage}-touch-events.json`),
						JSON.stringify({ touchPoint, origin, inner, touch, touchEvidence }, null, 2),
					)
				}
				if (await evaluate<boolean>(`${selector}.checked`)) {
					await evaluate(`${selector}.focus()`)
					for (const type of ["keyDown", "keyUp"])
						await connection.request(
							"Input.dispatchKeyEvent",
							{ type, key: " ", code: "Space", windowsVirtualKeyCode: 32 },
							webviewSession,
						)
				}
				await check(`!${selector}.checked`, `${stage}_touch_selection_cleared`)
				await moveAway()
			} finally {
				await connection.request("Emulation.setTouchEmulationEnabled", { enabled: false }, webviewSession)
			}
			await connection.request(
				"Emulation.setEmulatedMedia",
				{ features: [{ name: "forced-colors", value: "active" }] },
				webviewSession,
			)
			let forcedColors
			try {
				await check(
					"d.defaultView.matchMedia('(forced-colors:active)').matches",
					`${stage}_forced_colors_media`,
				)
				forcedColors = await metrics()
				assert.equal(forcedColors.appearance, "auto", "Forced colors retains the native accessible checkbox")
				await evaluate(`${selector}.focus()`)
				await capture(`${stage}-selection-forced-colors`)
			} finally {
				await connection.request("Emulation.setEmulatedMedia", { features: [] }, webviewSession)
			}
			await fs.writeFile(
				path.join(directory, `${stage}-selection-metrics.json`),
				JSON.stringify({ idle, hovered, selected, touch, forcedColors }, null, 2),
			)
		}
		const changeProperty = async (id: string, key: string, value: string) => {
			await evaluate(`d.getElementById(${javascriptLiteral(id)}).focus()`)
			for (const type of ["keyDown", "keyUp"])
				await connection.request(
					"Input.dispatchKeyEvent",
					{
						type,
						key,
						code: key,
						windowsVirtualKeyCode: key === "ArrowDown" ? 40 : 38,
					},
					webviewSession,
				)
			await check(
				`d.getElementById(${javascriptLiteral(id)})?.value === ${javascriptLiteral(value)} && !d.getElementById(${javascriptLiteral(id)})?.disabled`,
				`${id}_saved`,
			)
			await check(`d.activeElement?.id === ${javascriptLiteral(id)}`, `${id}_focus_restored`)
			await check("!d.querySelector('.tickets-notice')", `${id}_no_self_change_notice`)
		}
		const requiredTypes = [...ticketTypeSchema.options].sort()
		const assignedPriorityCount = fixtures.filter((fixture) => fixture.priority !== undefined).length
		for (const [stage, themeClass] of [
			["tickets-dark", "vscode-dark"],
			["tickets-light", "vscode-light"],
			["tickets-contrast", "vscode-high-contrast"],
		] as const) {
			if (stage !== "tickets-dark") await ready(stage)
			if (stage === "tickets-dark") {
				await check("!!d.querySelector('.tickets-view-tabs')", "tickets_navigation_ready")
				await evaluate(
					"[...d.querySelectorAll('.tickets-view-tabs button')].find(b=>b.textContent==='Tickets').focus()",
				)
				await pressEnter()
			}
			await check(
				`d.body.classList.contains(${javascriptLiteral(themeClass)}) && !!d.querySelector('.tickets-list') && d.querySelectorAll('.ticket-row-open').length === ${fixtures.length}`,
				`${stage}_list`,
			)
			for (const fixture of fixtures) {
				assert.equal(
					await evaluate(
						`(()=>{const row=[...d.querySelectorAll('.ticket-row')].find(r=>r.querySelector('.ticket-row-name')?.textContent===${javascriptLiteral(fixture.name)}); const r=row?.getBoundingClientRect(); return !!row && row.dataset.status===${javascriptLiteral(fixture.status)} && row.closest('tbody')?.id===${javascriptLiteral(`ticket-group-rows-${fixture.status}`)} && row.checkVisibility() && r.width>0 && r.height>0})()`,
					),
					true,
					`${fixture.name} is visible in its status section`,
				)
			}
			const listMetrics = await evaluate<{
				viewportWidth: number
				viewportScrollWidth: number
				listWidth: number
				listScrollWidth: number
				listClientWidth: number
				tableScrollWidth: number
				tableClientWidth: number
				occupiedRowWidth: number
				types: string[]
				priorities: number
				noPriority: number
			}>(
				`(()=>{const l=d.querySelector('.tickets-list');const s=d.querySelector('.ticket-table-scroll');return {viewportWidth:d.documentElement.clientWidth,viewportScrollWidth:d.documentElement.scrollWidth,listWidth:l.getBoundingClientRect().width,listScrollWidth:l.scrollWidth,listClientWidth:l.clientWidth,tableScrollWidth:s.scrollWidth,tableClientWidth:s.clientWidth,occupiedRowWidth:[...d.querySelector('.ticket-row').cells].reduce((sum,c)=>sum+c.getBoundingClientRect().width,0),types:[...new Set([...d.querySelectorAll('.ticket-type-badge')].map(e=>e.dataset.type))].sort(),priorities:d.querySelectorAll('.ticket-priority').length,noPriority:d.querySelectorAll('.ticket-priority-empty').length}})()`,
			)
			assert.deepEqual(listMetrics.types, requiredTypes)
			assert.ok(
				Math.abs(listMetrics.occupiedRowWidth - listMetrics.tableClientWidth) <= 1,
				"Visible columns fill the table without phantom space",
			)
			assert.equal(listMetrics.priorities, assignedPriorityCount)
			assert.equal(listMetrics.noPriority, fixtures.length - assignedPriorityCount)
			assert.ok(
				listMetrics.viewportScrollWidth <= listMetrics.viewportWidth + 1,
				"Webview has no horizontal overflow",
			)
			assert.ok(
				listMetrics.listScrollWidth <= listMetrics.listClientWidth + 1,
				"Tickets list has no horizontal overflow",
			)
			assert.ok(
				listMetrics.tableScrollWidth <= listMetrics.tableClientWidth + 1,
				"Ticket table has no horizontal overflow",
			)
			if (stage === "tickets-contrast") {
				assert.ok(
					listMetrics.listWidth > 0 && listMetrics.listWidth <= 500,
					`Narrow ticket panel required, observed ${listMetrics.listWidth}px`,
				)
				const inlinePriority = await evaluate<{ visible: number; assigned: number }>(
					"(()=>{const labels=[...d.querySelectorAll('.ticket-priority-inline')].filter(e=>e.checkVisibility());return {visible:labels.length,assigned:labels.filter(e=>e.dataset.priority!=='none').length}})()",
				)
				assert.deepEqual(
					inlinePriority,
					{ visible: fixtures.length, assigned: assignedPriorityCount },
					"Narrow rows show every ticket priority",
				)
			}
			await fs.writeFile(path.join(directory, `${stage}-metrics.json`), JSON.stringify(listMetrics, null, 2))
			await capture(`${stage}-list`)
			await exerciseSelection(stage)

			const selectedName = fixtures[0]!.name
			assert.equal(
				await evaluate(
					`(()=>{const e=[...d.querySelectorAll('.ticket-row-open')].find(b=>b.innerText.includes(${javascriptLiteral(selectedName)}));if(!e)return false;e.focus();return d.activeElement===e})()`,
				),
				true,
				"Seeded ticket identity is keyboard focusable",
			)
			await pressEnter()
			await check(
				`d.querySelector('#ticket-heading')?.textContent?.trim() === ${javascriptLiteral(selectedName)}`,
				`${stage}_detail`,
			)
			await capture(`${stage}-detail`)
			if (stage === "tickets-dark") {
				await changeProperty("ticket-priority-select", "ArrowDown", "medium")
				await changeProperty("ticket-type-select", "ArrowDown", "feature")
				const saved = await fs.readFile(fixtureFiles[0]!, "utf8")
				assert.match(saved, /priority: ["']?medium["']?/)
				assert.match(saved, /type: ["']?feature["']?/)
				await evaluate(
					"[...d.querySelectorAll('.tickets-breadcrumbs button')].find(b=>b.innerText.trim()==='Tickets').focus()",
				)
				await pressEnter()
				await check("!!d.querySelector('.tickets-list')", "property_roundtrip_back")
				await evaluate(
					`([...d.querySelectorAll('.ticket-row-open')].find(b=>b.innerText.includes(${javascriptLiteral(selectedName)}))).focus()`,
				)
				await pressEnter()
				await check(
					"d.getElementById('ticket-priority-select')?.value==='medium' && d.getElementById('ticket-type-select')?.value==='feature'",
					"property_roundtrip_readback",
				)
				await changeProperty("ticket-priority-select", "ArrowUp", "high")
				await changeProperty("ticket-type-select", "ArrowUp", "bug")
				const beforeExternal = await fs.readFile(fixtureFiles[0]!, "utf8")
				await fs.writeFile(
					fixtureFiles[0]!,
					beforeExternal.replace("Fixture content only.", "External fixture edit."),
					"utf8",
				)
				await check("!!d.querySelector('.tickets-notice')", "external_revision_notice")
				await evaluate("d.getElementById('ticket-priority-select').focus()")
				for (const type of ["keyDown", "keyUp"])
					await connection.request(
						"Input.dispatchKeyEvent",
						{ type, key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
						webviewSession,
					)
				await check(
					"!!d.querySelector('.ticket-reader-property-feedback[role=alert]') && !d.getElementById('ticket-priority-select').disabled",
					"stale_revision_rejected",
				)
				await check("d.activeElement?.id==='ticket-priority-select'", "failed_property_focus_restored")
				assert.match(await fs.readFile(fixtureFiles[0]!, "utf8"), /priority: ["']?high["']?/)
				await evaluate("d.querySelector('.tickets-notice button').focus()")
				await pressEnter()
				await check(
					"!d.querySelector('.tickets-notice') && d.querySelector('.ticket-reader-implementationSummary')?.textContent.includes('External fixture edit.')",
					"external_revision_reload",
				)
			}
			assert.equal(
				await evaluate(
					`(()=>{const e=[...d.querySelectorAll('.tickets-breadcrumbs button')].find(b=>b.innerText.trim()==='Tickets');if(!e)return false;e.focus();return d.activeElement===e})()`,
				),
				true,
				"Ticket detail breadcrumb is keyboard focusable",
			)
			await pressEnter()
			await check(
				`!!d.querySelector('.tickets-list') && d.querySelectorAll('.ticket-row-open').length === ${fixtures.length}`,
				`${stage}_back`,
			)
			await writeJsonAtomically(path.join(directory, `ui-done-${stage}.json`), {
				nonce,
				stage,
				status: "passed",
			})
		}
		const host = await running
		assertTicketsUiHostResult(host)
		const savedDirectory = path.join(output, runId)
		await fs.cp(directory, savedDirectory, { recursive: true })
		return { status: "passed", directory: savedDirectory, host }
	} finally {
		clearTimeout(timer)
		cdp?.close()
		abort.abort()
		await running.catch(() => {})
	}
}

if (require.main === module) {
	void (async () => {
		const executable = process.env.VSCODE_EXECUTABLE_PATH ?? (await downloadAndUnzipVSCode({ version: "1.138.0" }))
		console.log(
			JSON.stringify(await runTicketsUi(executable, path.resolve(__dirname, "../../../artifacts/tickets-ui"))),
		)
	})().catch((error) => {
		console.error(error)
		process.exitCode = 1
	})
}
