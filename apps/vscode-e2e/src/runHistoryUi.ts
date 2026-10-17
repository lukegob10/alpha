import { javascriptLiteral } from "./ui/javascriptLiteral"
import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { downloadAndUnzipVSCode } from "@vscode/test-electron"
import { runExtensionTests, type ExtensionTestRunResult } from "./runTest"
import { CdpConnection } from "./ui/cdp"
import { activateNativeChatHeader, readNativeChatHeader } from "./ui/nativeChatHeader"
import { waitUntil } from "./evidence/sharedStorageProtocol"
import { writeJsonAtomically } from "./suite/preflightEvidence"

interface Target {
	targetId: string
	type: string
	url: string
}
interface PanelMetrics {
	width: number
	height: number
	scrollWidth: number
	clientWidth: number
	composer: boolean
	alignedCards: boolean
	text: string
}

interface HistoryTextMetrics {
	fontFamily: string
	fontSize: string
	fontWeight: string
	lineHeight: string
	color: string
	opacity: number
}

interface HistoryStyleMetrics {
	heading: HistoryTextMetrics & {
		text: string
		sameElement: boolean
		bounds: { left: number; top: number; width: number; height: number }
	}
	title: HistoryTextMetrics
	titleLeft: number
	list: { left: number; borderLeft: number }
	age: HistoryTextMetrics | null
	expected: { fontFamily: string; fontSize: string; muted: string; foreground: string }
	row: {
		focused: boolean
		focusVisible: boolean
		hovered: boolean
		boxShadow: string
		outlineStyle: string
		outlineWidth: string
		role: string | null
		label: string | null
		statusLabels: Array<string | null>
		hasRunningSpinner: boolean
		hasTimestamp: boolean
	}
}

interface RendererNavigationProbe {
	startedAt: number
	domAt?: number
	paintedAt?: number
	openingFeedbackAt?: number
}

interface TicketPreviewFrame {
	height: number
	textHeight: number
	textWidth: number
	highlights: number
	enabledMentions: number
	expanded: string | null
}

type HistoryUiHost = Pick<
	ExtensionTestRunResult,
	"status" | "execution" | "ownershipGate" | "captureComplete" | "hostExitObserved" | "actualVSCodeVersion"
>

export async function completeHistoryUiRun<T extends HistoryUiHost>(
	host: T,
	directory: string,
	output: string,
	runId: string,
	expectedHostVersion = "1.125.0",
) {
	const savedDirectory = path.join(output, runId)
	await fs.cp(directory, savedDirectory, { recursive: true })
	if (
		host.status !== "passed" ||
		host.execution !== "extension-host" ||
		host.ownershipGate !== "verified" ||
		host.captureComplete !== true ||
		host.hostExitObserved !== true ||
		host.actualVSCodeVersion !== expectedHostVersion
	)
		throw new Error(`History UI host validation failed; inspect retained evidence in ${savedDirectory}`)
	return { status: "passed" as const, directory: savedDirectory, host }
}

/** Exercises the built extension in an isolated exact-host profile, with trusted renderer input. */
export async function runHistoryUi(executable: string, output: string, expectedHostVersion = "1.125.0") {
	await fs.mkdir(output, { recursive: true })
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-chats-ui-"))
	const nonce = randomUUID()
	const runId = `chats-${nonce}`
	const evidenceRoot = path.join(root, "evidence")
	const directory = path.join(evidenceRoot, runId)
	const abort = new AbortController()
	const timer = setTimeout(() => abort.abort(), 240_000)
	let hostSettled = false
	const running = runExtensionTests({
		providerMode: "scripted",
		vscodeVersion: expectedHostVersion,
		vscodeExecutablePath: executable,
		testFile: "history-ui.test",
		rendererDebuggingPort: 0,
		runId,
		profileDir: path.join(root, "profile"),
		workspace: path.join(root, "workspace"),
		artifactsDir: evidenceRoot,
		initializeProfile: true,
		retainEvidenceForCampaign: true,
		extensionTestsEnv: {
			ALPHA_UI_ACCEPTANCE_NONCE: nonce,
			ALPHA_UI_EXPECTED_VSCODE_VERSION: expectedHostVersion,
		},
		signal: abort.signal,
	}).finally(() => {
		hostSettled = true
	})
	// A rejected launch must interrupt stage waits immediately, rather than surfacing as a fixture timeout.
	const hostEnded = running.then(() => {
		throw new Error("History host exited before renderer checks completed")
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
						if (hostSettled) throw new Error("History host exited")
						try {
							const receipt = JSON.parse(
								await fs.readFile(path.join(directory, `ui-stage-${stage}.json`), "utf8"),
							)
							assert.equal(receipt.nonce, nonce)
							assert.equal(receipt.version, expectedHostVersion)
							return true
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
							throw error
						}
					},
					Date.now() + 75_000,
					`history_${stage}_timeout`,
				),
			])
		await ready("chats-small")
		const [port, endpoint] = (
			await fs.readFile(
				path.join(root, "profile", expectedHostVersion, "user-data", "DevToolsActivePort"),
				"utf8",
			)
		)
			.trim()
			.split(/\r?\n/)
		if (!port || !endpoint) throw new Error("Owned DevTools endpoint is incomplete")
		assert.match(port, /^\d{1,5}$/)
		cdp = await CdpConnection.connect(`ws://127.0.0.1:${port}${endpoint}`)
		const connection = cdp
		const { targetInfos } = await connection.request<{ targetInfos: Target[] }>("Target.getTargets")
		const target = targetInfos.find((entry) => entry.url.includes("extensionId=AlphaInc.alpha"))
		const page = targetInfos.find((entry) => entry.type === "page" && entry.url.includes("workbench"))
		assert.ok(target, "Alpha webview target exists")
		assert.ok(page, "Owned workbench target exists")
		const attach = (targetId: string) =>
			connection.request<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })
		const { sessionId } = await attach(target.targetId)
		const { sessionId: pageSession } = await attach(page.targetId)
		await connection.request("Page.bringToFront", {}, pageSession)
		const evaluate = async <T>(
			expression: string,
			targetSession = sessionId,
			useActiveFrame = true,
		): Promise<T> => {
			abort.signal.throwIfAborted()
			const result = await connection.request<{ result: { value: T }; exceptionDetails?: unknown }>(
				"Runtime.evaluate",
				{
					expression: `(()=>{const d=${useActiveFrame ? "document.getElementById('active-frame')?.contentDocument??document" : "document"};return (${expression})})()`,
					returnByValue: true,
					awaitPromise: true,
				},
				targetSession,
			)
			assert.equal(result.exceptionDetails, undefined)
			return result.result.value
		}
		const check = (expression: string) =>
			Promise.race([
				hostEnded,
				waitUntil(
					() => evaluate<boolean>(expression),
					Date.now() + 15_000,
					`history_render_timeout: ${expression}`,
				),
			])
		const activate = async (testId: string) => {
			await check(`!!d.querySelector('[data-testid="${testId}"]')`)
			assert.equal(
				await evaluate(
					`(()=>{const e=d.querySelector('[data-testid="${testId}"]');e.focus();return d.activeElement===e})()`,
				),
				true,
			)
			for (const type of ["keyDown", "keyUp"]) {
				await connection.request(
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
		const pressEscape = async (targetSession = sessionId) => {
			for (const type of ["keyDown", "keyUp"])
				await connection.request(
					"Input.dispatchKeyEvent",
					{ type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
					targetSession,
				)
		}
		const activateSelector = async (selector: string) => {
			await check(`!!d.querySelector(${javascriptLiteral(selector)})`)
			assert.equal(
				await evaluate(
					`(()=>{const e=d.querySelector(${javascriptLiteral(selector)});e.focus();return d.activeElement===e})()`,
				),
				true,
			)
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
					sessionId,
				)
		}
		const capture = async (name: string) => {
			const screenshot = await connection.request<{ data: string }>(
				"Page.captureScreenshot",
				{ format: "png" },
				pageSession,
			)
			await fs.writeFile(path.join(directory, `${name}.png`), Buffer.from(screenshot.data, "base64"))
			const { frameTree } = await connection.request<{ frameTree: { frame: { id: string } } }>(
				"Page.getFrameTree",
				{},
				sessionId,
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
			const [x, y, right, , , bottom] = model.content
			assert.ok(
				typeof x === "number" &&
					Number.isFinite(x) &&
					typeof y === "number" &&
					Number.isFinite(y) &&
					typeof right === "number" &&
					Number.isFinite(right) &&
					typeof bottom === "number" &&
					Number.isFinite(bottom) &&
					right > x &&
					bottom > y,
				"Webview frame has measured bounds",
			)
			const clipped = await connection.request<{ data: string }>(
				"Page.captureScreenshot",
				{ format: "png", clip: { x, y, width: right - x, height: bottom - y, scale: 1 } },
				pageSession,
			)
			await fs.writeFile(path.join(directory, `${name}-content.png`), Buffer.from(clipped.data, "base64"))
			const header = await readNativeChatHeader(connection, pageSession)
			assert.ok(header, "Native ALPHA sidebar remains visible")
			const sidebar = header.sidebarBounds
			assert.ok(
				[sidebar.left, sidebar.top, sidebar.width, sidebar.height].every(Number.isFinite) &&
					sidebar.width > 0 &&
					sidebar.height > 0,
				"Native ALPHA sidebar has measured bounds",
			)
			await connection.request(
				"Input.dispatchMouseEvent",
				{
					type: "mouseMoved",
					x: header.bounds.left + header.bounds.width / 2,
					y: header.bounds.top + header.bounds.height / 2,
				},
				pageSession,
			)
			const sidebarScreenshot = await connection.request<{ data: string }>(
				"Page.captureScreenshot",
				{
					format: "png",
					clip: { x: sidebar.left, y: sidebar.top, width: sidebar.width, height: sidebar.height, scale: 1 },
				},
				pageSession,
			)
			await fs.writeFile(
				path.join(directory, `${name}-sidebar.png`),
				Buffer.from(sidebarScreenshot.data, "base64"),
			)
		}
		const headingReference = javascriptLiteral(`alpha-history-heading-${nonce}`)
		const observeHistoryStyle = async (taskId: string, rememberHeading = false) => {
			const observation = await evaluate<HistoryStyleMetrics | null>(
				`(()=>{
					const section=d.querySelector('[data-testid=history-preview-list]')?.closest('section');
					const heading=section?.querySelector('h2'),row=section?.querySelector(${javascriptLiteral(`[data-testid="task-item-${taskId}"]`)});
					const title=row?.querySelector('[data-testid=task-content]');
					if(!heading||!row||!title)return null;
					const win=d.defaultView;
					if(${rememberHeading})win[${headingReference}]=heading;
					const font=e=>{const s=win.getComputedStyle(e);return {fontFamily:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight,color:s.color,opacity:Number(s.opacity)}};
					const probe=d.createElement('span');probe.style.cssText='position:absolute;visibility:hidden;pointer-events:none;color:var(--vscode-descriptionForeground);font-family:var(--chat-ui-font-family,var(--vscode-font-family,sans-serif));font-size:var(--chat-ui-font-size,var(--vscode-font-size,13px))';d.body.appendChild(probe);
					const expectedStyle=win.getComputedStyle(probe),expected={fontFamily:expectedStyle.fontFamily,fontSize:expectedStyle.fontSize,muted:expectedStyle.color};
					probe.style.color='var(--vscode-foreground)';const foreground=win.getComputedStyle(probe).color;probe.remove();
					const r=heading.getBoundingClientRect(),s=win.getComputedStyle(row),age=row.querySelector('[data-testid=task-time-ago]'),list=section.querySelector('[data-testid=history-preview-list]');
					return {heading:{...font(heading),text:heading.textContent.trim(),sameElement:win[${headingReference}]===heading,bounds:{left:r.left,top:r.top,width:r.width,height:r.height}},title:font(title),titleLeft:title.getBoundingClientRect().left,list:{left:list.getBoundingClientRect().left,borderLeft:parseFloat(win.getComputedStyle(list).borderLeftWidth)},age:age?font(age):null,expected:{...expected,foreground},row:{focused:d.activeElement===row,focusVisible:row.matches(':focus-visible'),hovered:row.matches(':hover'),boxShadow:s.boxShadow,outlineStyle:s.outlineStyle,outlineWidth:s.outlineWidth,role:row.getAttribute('role'),label:row.getAttribute('aria-label'),statusLabels:[...row.querySelectorAll('[data-testid=task-status-indicator]')].map(e=>e.getAttribute('aria-label')),hasRunningSpinner:!!row.querySelector('[data-testid=task-status-indicator] .animate-spin'),hasTimestamp:!!age}};
				})()`,
			)
			assert.ok(observation, "Chats heading and fixture title must exist in both history states")
			return observation
		}
		const assertMutedHistoryStyle = (metrics: HistoryStyleMetrics) => {
			assert.equal(metrics.heading.text, "Chats")
			assert.equal(metrics.heading.fontFamily, metrics.expected.fontFamily)
			assert.equal(
				metrics.heading.fontSize,
				metrics.expected.fontSize,
				"Chats heading uses the compact chat UI font",
			)
			assert.equal(metrics.heading.color, metrics.expected.muted)
			assert.equal(metrics.title.fontFamily, metrics.expected.fontFamily)
			assert.equal(metrics.title.fontSize, metrics.expected.fontSize)
			assert.equal(metrics.title.fontWeight, "400")
			assert.equal(
				metrics.title.color,
				metrics.expected.muted,
				"Neutral history titles use descriptionForeground",
			)
			if (metrics.age) {
				assert.deepEqual(metrics.age, metrics.title, "History ages share the title typography and muted color")
			}
			assert.ok(metrics.heading.opacity > 0 && metrics.title.opacity > 0)
			assert.ok(metrics.heading.bounds.height > 0 && metrics.heading.bounds.height <= 24)
		}
		const observeMutedHistoryStyle = async (taskId: string, rememberHeading = false) => {
			let metrics = await observeHistoryStyle(taskId, rememberHeading)
			// Theme changes animate inherited row colors; compare after the neutral token is actually rendered.
			await waitUntil(
				async () => {
					metrics = await observeHistoryStyle(taskId)
					return (
						metrics.heading.color === metrics.expected.muted &&
						metrics.title.color === metrics.expected.muted
					)
				},
				Date.now() + 5000,
				"history_muted_color_transition_timeout",
			)
			return metrics
		}
		const assertSameHeading = (before: HistoryStyleMetrics, after: HistoryStyleMetrics) => {
			assert.equal(after.heading.sameElement, true, "Expand/collapse retains the same Chats heading")
			for (const key of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "color"] as const) {
				assert.equal(after.heading[key], before.heading[key], `Chats heading ${key} remains stable`)
			}
			for (const key of ["left", "top"] as const) {
				assert.ok(
					Math.abs(after.heading.bounds[key] - before.heading.bounds[key]) <= 0.5,
					`Chats heading ${key} remains stable`,
				)
			}
		}
		const inspectHistoryInteraction = async (taskId: string, baseline: HistoryStyleMetrics) => {
			const selector = javascriptLiteral(`[data-testid="task-item-${taskId}"]`)
			const point = await evaluate<{ x: number; y: number }>(
				`(()=>{const r=d.querySelector(${selector}).getBoundingClientRect(),f=document.getElementById('active-frame')?.getBoundingClientRect();return {x:r.left+r.width/2+(f?.left??0),y:r.top+r.height/2+(f?.top??0)}})()`,
			)
			const { frameTree } = await connection.request<{ frameTree: { frame: { id: string } } }>(
				"Page.getFrameTree",
				{},
				sessionId,
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
			const [originX, originY] = model.content
			assert.ok(typeof originX === "number" && typeof originY === "number")
			await connection.request(
				"Input.dispatchMouseEvent",
				{ type: "mouseMoved", x: originX + point.x, y: originY + point.y },
				pageSession,
			)
			await check(`d.querySelector(${selector}).matches(':hover')`)
			await check(
				`d.defaultView.getComputedStyle(d.querySelector(${selector}).querySelector('[data-testid=task-content]')).color===${javascriptLiteral(baseline.expected.foreground)}`,
			)
			const hovered = await observeHistoryStyle(taskId)
			await evaluate(`d.querySelector(${selector}).focus()`)
			for (const modifiers of [0, 8]) {
				for (const type of ["keyDown", "keyUp"]) {
					await connection.request(
						"Input.dispatchKeyEvent",
						{ type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers },
						sessionId,
					)
				}
			}
			await check(`d.activeElement===d.querySelector(${selector}) && d.activeElement.matches(':focus-visible')`)
			const focused = await observeHistoryStyle(taskId)
			assert.ok(
				focused.row.boxShadow !== "none" ||
					(focused.row.outlineStyle !== "none" && parseFloat(focused.row.outlineWidth) > 0),
				"History rows retain a visible keyboard focus indicator",
			)
			for (const state of [hovered, focused]) {
				for (const key of ["fontFamily", "fontSize", "fontWeight", "lineHeight"] as const) {
					assert.equal(state.title[key], baseline.title[key], `History title ${key} survives hover/focus`)
				}
				assert.ok(
					state.title.opacity > 0 &&
						[baseline.expected.muted, baseline.expected.foreground].includes(state.title.color),
					"History text stays visible in a readable theme color",
				)
				assert.deepEqual(state.row.statusLabels, baseline.row.statusLabels)
				assert.equal(state.row.hasRunningSpinner, baseline.row.hasRunningSpinner)
				assert.equal(state.row.hasTimestamp, baseline.row.hasTimestamp)
				assert.equal(state.row.role, baseline.row.role)
				assert.equal(state.row.label, baseline.row.label)
			}
			return { hovered, focused }
		}
		const installNavigationProbe = async (predicate: string, taskId?: string) =>
			evaluate<boolean>(
				`(()=>{const win=d.defaultView??window;const probe={startedAt:win.performance.now()};win.__alphaHistoryUiProbe=probe;const observer=new win.MutationObserver(()=>{const row=${taskId ? `d.querySelector('[data-testid="task-item-${taskId}"]')` : "undefined"};if(!probe.openingFeedbackAt&&row?.querySelector('[data-testid="task-opening-indicator"]'))probe.openingFeedbackAt=win.performance.now();if(probe.domAt===undefined&&(${predicate})){probe.domAt=win.performance.now();observer.disconnect();win.requestAnimationFrame(()=>win.requestAnimationFrame(()=>{probe.paintedAt=win.performance.now()}))}});observer.observe(d.body,{childList:true,subtree:true,attributes:true});return true})()`,
			)
		const readNavigationProbe = () => evaluate<RendererNavigationProbe>("d.defaultView.__alphaHistoryUiProbe")
		await check(
			"!!d.querySelector('[data-testid=history-view-all]') && d.querySelectorAll('[data-testid^=task-item-history-visual-]').length === 3",
		)
		assert.equal(
			await evaluate("!!d.querySelector('[data-testid=task-item-history-foreign-project]')"),
			false,
			"Another project's task must not appear in Chats preview",
		)
		assert.equal(await evaluate("!!d.querySelector('[data-testid=history-search-input]')"), false)
		const smallHeight = await evaluate<number>(
			"d.querySelector('[data-testid=history-view-all]').closest('section').getBoundingClientRect().height",
		)
		assert.ok(smallHeight < 160, `Three-row preview must fit its content, observed ${smallHeight}px`)
		await capture("chats-small-preview")
		assert.equal(
			await evaluate("d.querySelectorAll('.chat-toolbar').length"),
			0,
			"New chat has no duplicate toolbar row",
		)
		const nativeHeader = await activateNativeChatHeader(connection, pageSession, "more")
		await waitUntil(
			() => evaluate<boolean>("!!d.querySelector('[role=\"menu\"]')", pageSession, false),
			Date.now() + 5000,
			"native_chat_more_menu_timeout",
		)
		const menuEntries = await evaluate<string[]>(
			"Array.from(d.querySelectorAll('[role=\"menuitem\"]'), e=>(e.querySelector('.action-label')?.textContent??e.textContent).trim())",
			pageSession,
			false,
		)
		const alphaMenuEntries = menuEntries.filter((label) =>
			["Alpha: Incident Dashboard", "Scheduled Tasks", "Marketplace"].includes(label),
		)
		assert.ok(
			JSON.stringify(alphaMenuEntries) === JSON.stringify(["Scheduled Tasks", "Marketplace"]) ||
				JSON.stringify(alphaMenuEntries) ===
					JSON.stringify(["Alpha: Incident Dashboard", "Scheduled Tasks", "Marketplace"]),
			`Only approved toolbar entries remain: ${JSON.stringify(menuEntries)}`,
		)
		assert.ok(
			!menuEntries.some((label) => /^(?:Task History|All chats|Show sub-agents|Open in Editor)$/i.test(label)),
		)
		await capture("chat-toolbar-more")
		await pressEscape(pageSession)
		await waitUntil(
			() => evaluate<boolean>("!d.querySelector('[role=\"menu\"]')", pageSession, false),
			Date.now() + 5000,
			"native_chat_more_close_timeout",
		)
		await activateSelector(".chat-context-meter")
		await check('!!d.querySelector(\'[role="dialog"][aria-label="Task details"]\')')
		await capture("chat-context-details")
		await pressEscape()
		await check('!d.querySelector(\'[role="dialog"][aria-label="Task details"]\')')
		await fs.writeFile(
			path.join(directory, "chat-redesign-controls.json"),
			JSON.stringify(
				{
					hostVersion: expectedHostVersion,
					nativeHeader,
					menuEntries,
					alphaMenuEntries,
					contextDetailsOpenedAndClosed: true,
				},
				null,
				2,
			),
		)
		await activate("history-view-all")
		await check("!!d.querySelector('[data-testid=history-search-input]')")
		assert.equal(
			await evaluate("!!d.querySelector('[data-testid=task-item-history-foreign-project]')"),
			false,
			"Another project's task must not appear in expanded Chats",
		)
		const expandedSmallHeight = await evaluate<number>(
			"d.querySelector('[data-testid=history-search-input]').closest('section').getBoundingClientRect().height",
		)
		assert.ok(
			expandedSmallHeight < 250,
			`Small expanded history must not reserve empty rows, observed ${expandedSmallHeight}px`,
		)
		await capture("chats-small-expanded")
		await activate("history-close")
		await writeJsonAtomically(path.join(directory, "ui-done-chats-small.json"), {
			nonce,
			stage: "chats-small",
			status: "passed",
		})
		for (const [stage, themeClass] of [
			["chats-dark", "vscode-dark"],
			["chats-light", "vscode-light"],
			["chats-contrast", "vscode-high-contrast"],
		] as const) {
			await ready(stage)
			await check(
				`d.body.classList.contains(${javascriptLiteral(themeClass)}) && !!d.querySelector('[data-testid="history-view-all"]')`,
			)
			await check("d.querySelectorAll('[data-testid^=task-item-history-visual-]').length === 4")
			assert.equal(await evaluate("!!d.querySelector('[data-testid=history-search-input]')"), false)
			assert.equal(
				await evaluate("d.querySelectorAll('.chat-toolbar').length"),
				0,
				"Native header has no duplicate webview toolbar",
			)
			const previewStyle = await observeMutedHistoryStyle("history-visual-0", true)
			assertMutedHistoryStyle(previewStyle)
			await capture(`${stage}-preview`)
			const previewInteraction = await inspectHistoryInteraction("history-visual-0", previewStyle)
			await activate("history-view-all")
			await check("!!d.querySelector('[data-testid=history-search-input]')")
			await check("!!d.querySelector('[data-testid=task-item-history-visual-0]')")
			assert.equal(
				await evaluate("d.querySelectorAll('.chat-toolbar').length"),
				0,
				"Expanded history has no duplicate webview toolbar",
			)
			const expandedStyle = await observeMutedHistoryStyle("history-visual-0")
			assertMutedHistoryStyle(expandedStyle)
			assertSameHeading(previewStyle, expandedStyle)
			assert.deepEqual(
				expandedStyle.title,
				previewStyle.title,
				"Recent and expanded task titles use identical typography",
			)
			assert.deepEqual(expandedStyle.age, previewStyle.age, "Recent and expanded ages use identical typography")
			const previewInset = previewStyle.titleLeft - previewStyle.list.left - previewStyle.list.borderLeft
			const expandedInset = expandedStyle.titleLeft - expandedStyle.list.left - expandedStyle.list.borderLeft
			assert.ok(
				Math.abs(expandedInset - previewInset) <= 0.5,
				"Task titles retain the same content inset inside the list border",
			)
			assert.deepEqual(expandedStyle.row.statusLabels, previewStyle.row.statusLabels)
			assert.equal(expandedStyle.row.hasRunningSpinner, previewStyle.row.hasRunningSpinner)
			assert.equal(expandedStyle.row.hasTimestamp, previewStyle.row.hasTimestamp)
			await capture(`${stage}-expanded`)
			const expandedInteraction = await inspectHistoryInteraction("history-visual-0", expandedStyle)
			const metrics = await evaluate<PanelMetrics>(
				`(()=>{
					const s=d.querySelector('[data-testid="history-search-input"]').closest('section');
					const r=s.getBoundingClientRect(),c=d.querySelector('textarea');
					const history=s.querySelector('.new-task-history-list').getBoundingClientRect();
					const composer=c?.closest('.new-task-composer')?.getBoundingClientRect();
					return {
						width:r.width,height:r.height,scrollWidth:s.scrollWidth,clientWidth:s.clientWidth,text:s.innerText,
						composer:!!c&&c.getBoundingClientRect().height>0,
						alignedCards:!!composer&&Math.abs(history.left-composer.left)<0.1&&Math.abs(history.right-composer.right)<0.1
					};
				})()`,
			)
			assert.ok(metrics.composer, "Composer remains visible alongside Chats")
			assert.ok(
				metrics.alignedCards,
				"Expanded history and composer retain aligned card edges in a narrow sidebar",
			)
			assert.ok(metrics.width > 0 && metrics.width <= 420, `Narrow sidebar required, observed ${metrics.width}px`)
			assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, "Narrow panel has no horizontal overflow")
			assert.ok(!metrics.text.includes("View all"), "History is available inline")
			const screenshot = await connection.request<{ data: string }>(
				"Page.captureScreenshot",
				{ format: "png" },
				pageSession,
			)
			await fs.writeFile(path.join(directory, `${stage}.png`), Buffer.from(screenshot.data, "base64"))
			await fs.writeFile(path.join(directory, `${stage}.json`), JSON.stringify(metrics, null, 2))
			assert.equal(
				await evaluate(
					"(()=>{const e=d.querySelector('[data-testid=history-search-input]');e.focus();return d.activeElement===e})()",
				),
				true,
			)
			await connection.request("Input.insertText", { text: "cancellation" }, sessionId)
			await check(
				"!!d.querySelector('[data-testid=task-item-history-visual-3]') && !d.querySelector('[data-testid=task-item-history-visual-0]')",
			)
			// The next keyboard stop is the clear-search button; activate it without pointer input.
			for (const [key, code, keyCode] of [
				["Tab", "Tab", 9],
				["Enter", "Enter", 13],
			] as const) {
				for (const type of ["keyDown", "keyUp"])
					await connection.request(
						"Input.dispatchKeyEvent",
						{
							type,
							key,
							code,
							windowsVirtualKeyCode: keyCode,
							...(type === "keyDown" && key === "Enter" ? { text: "\r" } : {}),
						},
						sessionId,
					)
			}
			await check(
				"d.querySelector('[data-testid=history-search-input]').value === '' && !!d.querySelector('[data-testid=task-item-history-visual-0]')",
			)
			await activate("history-close")
			const collapsedStyle = await observeHistoryStyle("history-visual-0")
			assertSameHeading(previewStyle, collapsedStyle)
			await evaluate(`delete d.defaultView[${headingReference}]`)
			await fs.writeFile(
				path.join(directory, `${stage}-consistency.json`),
				JSON.stringify(
					{ previewStyle, expandedStyle, collapsedStyle, previewInteraction, expandedInteraction },
					null,
					2,
				),
			)
			await writeJsonAtomically(path.join(directory, `ui-done-${stage}.json`), { nonce, stage, status: "passed" })
		}

		await ready("navigation-ready")
		const navigationReady = JSON.parse(
			await fs.readFile(path.join(directory, "ui-stage-navigation-ready.json"), "utf8"),
		) as {
			taskId?: unknown
			expectedVisibleMessages?: unknown
			persistedTranscriptMessages?: unknown
			sentinel?: unknown
		}
		assert.equal(typeof navigationReady.taskId, "string")
		assert.match(navigationReady.taskId as string, /^[a-zA-Z0-9-]+$/)
		assert.ok(
			typeof navigationReady.expectedVisibleMessages === "number" &&
				navigationReady.expectedVisibleMessages >= 1200,
		)
		assert.ok(
			typeof navigationReady.persistedTranscriptMessages === "number" &&
				navigationReady.persistedTranscriptMessages >= navigationReady.expectedVisibleMessages,
		)
		assert.equal(navigationReady.sentinel, "history-ui-navigation-transcript-sentinel")
		const transcriptCount = navigationReady.expectedVisibleMessages as number
		const navigationStartState = await evaluate<{
			transcriptCount: number
			renderedCount: number
			sentinelVisible: boolean
			homeVisible: boolean
		}>(
			`(()=>{const e=d.querySelector('[data-testid="chat-transcript-content"]');return {transcriptCount:Number(e?.dataset.count??0),renderedCount:Number(e?.dataset.renderedCount??0),sentinelVisible:d.body.innerText.includes(${javascriptLiteral(navigationReady.sentinel)}),homeVisible:!!d.querySelector('[data-testid="alpha-home-brand"]')}})()`,
		)
		await fs.writeFile(
			path.join(directory, "navigation-ready-dom.json"),
			JSON.stringify(navigationStartState, null, 2),
		)
		await capture("navigation-ready")
		await check(
			`(()=>{const e=d.querySelector('[data-testid="chat-transcript-content"]');return Number(e?.dataset.count)>=${transcriptCount}&&d.body.innerText.includes(${javascriptLiteral(navigationReady.sentinel)})})()`,
		)
		await installNavigationProbe(
			"!!d.querySelector('[data-testid=alpha-home-brand]')&&!d.querySelector('[data-testid=chat-transcript-viewport]')",
		)
		await writeJsonAtomically(path.join(directory, "ui-done-navigation-ready.json"), {
			nonce,
			stage: "navigation-ready",
			status: "passed",
		})
		await check("typeof d.defaultView.__alphaHistoryUiProbe.paintedAt === 'number'")
		const newChatProbe = await readNavigationProbe()
		assert.ok(newChatProbe.domAt !== undefined && newChatProbe.paintedAt !== undefined)
		await ready("navigation-new-chat")
		const newChatReceipt = JSON.parse(
			await fs.readFile(path.join(directory, "ui-stage-navigation-new-chat.json"), "utf8"),
		) as { taskId?: unknown }
		assert.equal(newChatReceipt.taskId, navigationReady.taskId)
		await writeJsonAtomically(path.join(directory, "ui-done-navigation-new-chat.json"), {
			nonce,
			stage: "navigation-new-chat",
			status: "passed",
		})

		await ready("navigation-reopen-ready")
		const reopenReceipt = JSON.parse(
			await fs.readFile(path.join(directory, "ui-stage-navigation-reopen-ready.json"), "utf8"),
		) as { taskId?: unknown }
		assert.equal(reopenReceipt.taskId, navigationReady.taskId)
		const taskId = navigationReady.taskId as string
		const taskItemSelector = `[data-testid="task-item-${taskId}"]`
		await check(`!!d.querySelector(${javascriptLiteral(taskItemSelector)})`)
		assert.equal(
			await evaluate(
				`(()=>{const e=d.querySelector(${javascriptLiteral(taskItemSelector)});e.focus();return d.activeElement===e})()`,
			),
			true,
		)
		await installNavigationProbe(
			`(()=>{const e=d.querySelector('[data-testid="chat-transcript-content"]');return Number(e?.dataset.count)>=${transcriptCount}&&d.body.innerText.includes(${javascriptLiteral(navigationReady.sentinel)})})()`,
			taskId,
		)
		for (const type of ["keyDown", "keyUp"]) {
			await connection.request(
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
		await check("typeof d.defaultView.__alphaHistoryUiProbe.paintedAt === 'number'")
		const reopenProbe = await readNavigationProbe()
		assert.ok(reopenProbe.domAt !== undefined && reopenProbe.paintedAt !== undefined)
		const reopenedTranscript = await evaluate<{ count: number; renderedCount: number; sentinelVisible: boolean }>(
			`(()=>{const e=d.querySelector('[data-testid="chat-transcript-content"]');return {count:Number(e?.dataset.count??0),renderedCount:Number(e?.dataset.renderedCount??0),sentinelVisible:d.body.innerText.includes(${javascriptLiteral(navigationReady.sentinel)})}})()`,
		)
		assert.ok(reopenedTranscript.count >= transcriptCount, "Reopened transcript retains all fixture messages")
		assert.ok(reopenedTranscript.renderedCount > 0 && reopenedTranscript.renderedCount <= 100)
		assert.equal(reopenedTranscript.sentinelVisible, true)
		// Inspect earlier actions after measuring the bounded reopen window: Load all persists the expanded window.
		await activate("chat-load-all")
		await check("!!d.querySelector('.user-message-actions button[aria-label=\"Copy\"]')")
		assert.equal(
			await evaluate<boolean>(
				'(()=>{const copy=d.querySelector(\'.user-message-actions button[aria-label="Copy"]\');copy.focus();const actions=copy.closest(".user-message-actions");const edit=actions.querySelector(\'button[aria-label="Edit and resend"]\');return d.activeElement===copy&&d.defaultView.getComputedStyle(actions).opacity==="1"&&!!edit&&!edit.disabled})()',
			),
			true,
			"User-message Copy and Edit appear on keyboard focus and editing remains available for the completed task",
		)
		await capture("chat-user-message-actions")
		await fs.writeFile(
			path.join(directory, "chat-user-message-actions.json"),
			JSON.stringify({ hostVersion: expectedHostVersion, copyAndEditVisibleOnKeyboardFocus: true }, null, 2),
		)
		const rendererLatency = {
			schemaVersion: 1,
			hostVersion: expectedHostVersion,
			runId,
			provider: "scripted-fake-ai",
			taskId,
			extensionBundleSha256: undefined as string | undefined,
			transcriptCacheState: "persisted-transcript-task-object-closed-in-same-extension-host",
			sampleCounts: { newChat: 1, coldTaskReopen: 1, warmTaskReopen: 0 },
			transcriptMessages: transcriptCount,
			reopenedTranscript,
			measurementsMs: {
				newChatDomCommit: newChatProbe.domAt! - newChatProbe.startedAt,
				newChatFramePaint: newChatProbe.paintedAt! - newChatProbe.startedAt,
				reopenClickToOpeningFeedback:
					reopenProbe.openingFeedbackAt === undefined
						? null
						: reopenProbe.openingFeedbackAt - reopenProbe.startedAt,
				reopenClickToTranscriptDom: reopenProbe.domAt! - reopenProbe.startedAt,
				reopenClickToTranscriptFramePaint: reopenProbe.paintedAt! - reopenProbe.startedAt,
			},
			measurementBoundary: `VS Code ${expectedHostVersion} webview performance clock: New Chat DOM commit and frame after it; history-row click to opening feedback and transcript DOM/frame with persisted synthetic transcript; timings are one scripted sample, not a general speed claim.`,
		}
		const scriptRequestsBefore = await evaluate<string[]>(
			"d.defaultView.performance.getEntriesByType('resource').map(entry=>entry.name).filter(name=>name.split('?')[0].endsWith('.js'))",
		)
		await writeJsonAtomically(path.join(directory, "ui-done-navigation-reopen-ready.json"), {
			nonce,
			stage: "navigation-reopen-ready",
			status: "passed",
		})
		await ready("diagram-ready")
		await check(
			"Array.from(d.querySelectorAll('svg')).some(svg=>svg.textContent.includes('Alpha lazy diagram ready'))",
		)
		const scriptRequestsAfter = await evaluate<string[]>(
			"d.defaultView.performance.getEntriesByType('resource').map(entry=>entry.name).filter(name=>name.split('?')[0].endsWith('.js'))",
		)
		const diagramScriptRequests = scriptRequestsAfter.filter((url) => !scriptRequestsBefore.includes(url))
		assert.ok(diagramScriptRequests.length > 0, "The completed diagram loads its deferred JavaScript")
		await capture("diagram-ready")
		await fs.writeFile(
			path.join(directory, "diagram-lazy-loading.json"),
			JSON.stringify({
				hostVersion: expectedHostVersion,
				diagramScriptRequests,
				rendered: true,
			}),
			{ flag: "wx" },
		)
		await writeJsonAtomically(path.join(directory, "ui-done-diagram-ready.json"), {
			nonce,
			stage: "diagram-ready",
			status: "passed",
		})
		await ready("ticket-mention-ready")
		const ticketReceipt = JSON.parse(
			await fs.readFile(path.join(directory, "ui-stage-ticket-mention-ready.json"), "utf8"),
		) as { taskId?: unknown; text?: unknown }
		assert.equal(ticketReceipt.taskId, taskId)
		assert.equal(typeof ticketReceipt.text, "string")
		const ticketText = javascriptLiteral(ticketReceipt.text)
		const ticketSelector = `[data-alpha-ticket-preview="${nonce}"]`
		await check(
			`Array.from(d.querySelectorAll('.user-message')).some(e=>e.textContent.includes('Ticket mention layout fixture:'))`,
		)
		const ticketGeometry = await evaluate<{
			crossoverWidth: number
			rawHeight: number
			highlightedHeight: number
			lineHeight: number
		}>(
			`(()=>{
				const message=Array.from(d.querySelectorAll('.user-message')).find(e=>e.textContent.includes('Ticket mention layout fixture:'));
				message.setAttribute('data-alpha-ticket-preview',${javascriptLiteral(nonce)});
				message.dataset.originalStyle=message.getAttribute('style')??'';
				const content=message.querySelector('.wrap-anywhere'),probe=d.createElement('div');
				probe.style.cssText='position:absolute;visibility:hidden;pointer-events:none;max-width:none';
				const computed=d.defaultView.getComputedStyle(content);
				for(const key of ['fontFamily','fontSize','fontWeight','letterSpacing'])probe.style[key]=computed[key];
				// Preserve unitless inheritance so smaller ticket buttons scale their line height as in the message.
				probe.style.lineHeight=String(parseFloat(computed.lineHeight)/parseFloat(computed.fontSize));
				probe.setAttribute('aria-hidden','true');probe.inert=true;
				const raw=content.cloneNode(false),highlighted=content.cloneNode(false);
				raw.textContent=${ticketText};
				${ticketText}.split('@ticket:BAS-65').forEach((part,index)=>{
					if(index){const mention=d.createElement('button');mention.type='button';mention.className='mention-context-highlight text-[0.9em] cursor-pointer';mention.textContent='@ticket:BAS-65';highlighted.appendChild(mention)}
					highlighted.appendChild(d.createTextNode(part));
				});
				probe.append(raw,highlighted);message.appendChild(probe);
				const lineHeight=parseFloat(d.defaultView.getComputedStyle(content).lineHeight),cutoff=lineHeight*6+1;
				let match;
				for(let width=160;width<=480;width+=8){
					probe.style.width=width+'px';
					const rawHeight=raw.scrollHeight,highlightedHeight=highlighted.scrollHeight;
					if(rawHeight<=cutoff&&highlightedHeight>cutoff){match={crossoverWidth:width,rawHeight,highlightedHeight,lineHeight};break}
				}
				probe.remove();
				if(!match)throw new Error('Ticket fixture must expose different six-line wrapping for highlighted and plain text');
				return match;
			})()`,
		)
		const sampleTicketFrames = async (width: number) =>
			evaluate<TicketPreviewFrame[]>(
				`(()=>{
					const message=d.querySelector(${javascriptLiteral(ticketSelector)}),win=d.defaultView;
					const style=win.getComputedStyle(message);
					message.style.maxWidth='none';
					message.style.width=(${width}+parseFloat(style.paddingLeft)+parseFloat(style.paddingRight)+parseFloat(style.borderLeftWidth)+parseFloat(style.borderRightWidth))+'px';
					return new Promise(resolve=>{
						const frames=[];let remaining=14;
						const sample=()=>{
							if(remaining<=12){const content=message.querySelector('.wrap-anywhere'),toggle=message.querySelector('button[aria-controls]');frames.push({height:message.getBoundingClientRect().height,textHeight:content.scrollHeight,textWidth:content.clientWidth,highlights:content.querySelectorAll('.mention-context-highlight').length,enabledMentions:content.querySelectorAll('button:not(:disabled)').length,expanded:toggle?.getAttribute('aria-expanded')??null})}
							if(--remaining===0)resolve(frames);else win.requestAnimationFrame(sample);
						};win.requestAnimationFrame(sample);
					});
				})()`,
			)
		function assertStableTicketFrames(
			frames: TicketPreviewFrame[],
			expanded: string | null,
		): asserts frames is [TicketPreviewFrame, ...TicketPreviewFrame[]] {
			assert.equal(frames.length, 12)
			for (const frame of frames) {
				assert.deepEqual(frame, frames[0], "Ticket preview geometry and disclosure remain stable across frames")
				assert.equal(frame.highlights, 4, "Collapsing preserves all ticket highlight geometry")
				assert.equal(frame.expanded, expanded)
			}
		}
		const narrowCollapsed = await sampleTicketFrames(ticketGeometry.crossoverWidth)
		assertStableTicketFrames(narrowCollapsed, "false")
		assert.equal(narrowCollapsed[0].textWidth, ticketGeometry.crossoverWidth)
		assert.equal(narrowCollapsed[0].textHeight, ticketGeometry.highlightedHeight)
		assert.equal(narrowCollapsed[0].enabledMentions, 0, "Collapsed ticket controls cannot receive focus")
		assert.equal(
			await evaluate<boolean>(
				`Array.from(d.querySelector(${javascriptLiteral(ticketSelector)}).querySelectorAll('button.mention-context-highlight')).every(button=>{button.focus();return button.disabled&&d.activeElement!==button})`,
			),
			true,
			"Disabled ticket mentions reject keyboard focus while their preview is collapsed",
		)
		await activateSelector(`${ticketSelector} button[aria-expanded="false"]`)
		const narrowExpanded = await sampleTicketFrames(ticketGeometry.crossoverWidth)
		assertStableTicketFrames(narrowExpanded, "true")
		assert.equal(narrowExpanded[0].enabledMentions, 4)
		const wideExpanded = await sampleTicketFrames(900)
		assertStableTicketFrames(wideExpanded, null)
		assert.equal(wideExpanded[0].enabledMentions, 4)
		const narrowRestored = await sampleTicketFrames(ticketGeometry.crossoverWidth)
		assertStableTicketFrames(narrowRestored, "true")
		await activateSelector(`${ticketSelector} button[aria-expanded="true"]`)
		const narrowRecollapsed = await sampleTicketFrames(ticketGeometry.crossoverWidth)
		assertStableTicketFrames(narrowRecollapsed, "false")
		assert.equal(narrowRecollapsed[0].enabledMentions, 0)
		const mentionPoint = await evaluate<{ x: number; y: number }>(
			`(()=>{
				const message=d.querySelector(${javascriptLiteral(ticketSelector)});
				message.scrollIntoView({block:'center',inline:'nearest'});
				const clip=message.querySelector('.wrap-anywhere').parentElement.getBoundingClientRect();
				const mention=Array.from(message.querySelectorAll('button.mention-context-highlight')).find(button=>{
					const r=button.getBoundingClientRect();return r.top>=clip.top&&r.bottom<=clip.bottom&&r.right>0&&r.left<d.defaultView.innerWidth;
				});
				if(!mention)throw new Error('A collapsed ticket highlight must remain visible for pointer input');
				const r=mention.getBoundingClientRect(),frame=document.getElementById('active-frame')?.getBoundingClientRect();
				return {x:(Math.max(0,r.left)+Math.min(d.defaultView.innerWidth,r.right))/2+(frame?.left??0),y:r.top+r.height/2+(frame?.top??0)};
			})()`,
		)
		await capture("ticket-mention-preview")
		const { frameTree: ticketFrameTree } = await connection.request<{ frameTree: { frame: { id: string } } }>(
			"Page.getFrameTree",
			{},
			sessionId,
		)
		const { backendNodeId: ticketFrameNode } = await connection.request<{ backendNodeId: number }>(
			"DOM.getFrameOwner",
			{ frameId: ticketFrameTree.frame.id },
			pageSession,
		)
		const { model: ticketFrameBounds } = await connection.request<{ model: { content: number[] } }>(
			"DOM.getBoxModel",
			{ backendNodeId: ticketFrameNode },
			pageSession,
		)
		for (const type of ["mousePressed", "mouseReleased"]) {
			await connection.request(
				"Input.dispatchMouseEvent",
				{
					type,
					x: ticketFrameBounds.content[0]! + mentionPoint.x,
					y: ticketFrameBounds.content[1]! + mentionPoint.y,
					button: "left",
					clickCount: 1,
				},
				pageSession,
			)
		}
		await check(
			`d.querySelector(${javascriptLiteral(ticketSelector)}).querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')==='true'`,
		)
		const pointerExpanded = await sampleTicketFrames(ticketGeometry.crossoverWidth)
		assertStableTicketFrames(pointerExpanded, "true")
		await fs.writeFile(
			path.join(directory, "ticket-mention-preview-geometry.json"),
			JSON.stringify(
				{
					hostVersion: expectedHostVersion,
					ticketGeometry,
					narrowCollapsed,
					narrowExpanded,
					wideExpanded,
					narrowRestored,
					narrowRecollapsed,
					pointerExpanded,
				},
				null,
				2,
			),
			{ flag: "wx" },
		)
		await evaluate(
			`(()=>{const message=d.querySelector(${javascriptLiteral(ticketSelector)});message.setAttribute('style',message.dataset.originalStyle);delete message.dataset.originalStyle;message.removeAttribute('data-alpha-ticket-preview')})()`,
		)
		await writeJsonAtomically(path.join(directory, "ui-done-ticket-mention-ready.json"), {
			nonce,
			stage: "ticket-mention-ready",
			status: "passed",
		})
		const host = await running
		assert.ok(host.evidenceManifestPath)
		const manifest = JSON.parse(await fs.readFile(host.evidenceManifestPath, "utf8")) as { bundleSha256?: unknown }
		assert.equal(typeof manifest.bundleSha256, "string")
		assert.match(manifest.bundleSha256 as string, /^[a-f0-9]{64}$/)
		rendererLatency.extensionBundleSha256 = manifest.bundleSha256 as string
		await fs.writeFile(
			path.join(directory, "navigation-renderer-latency.json"),
			JSON.stringify(rendererLatency, null, 2),
			{ flag: "wx" },
		)
		return completeHistoryUiRun(host, directory, output, runId, expectedHostVersion)
	} finally {
		clearTimeout(timer)
		cdp?.close()
		abort.abort()
		await running.catch(() => {})
		// The temporary profile can contain host-owned resources; leave cleanup to the runner.
	}
}

if (require.main === module) {
	void (async () => {
		const expectedHostVersion = process.env.ALPHA_HISTORY_UI_VSCODE_VERSION ?? "1.125.0"
		const executable =
			process.env.VSCODE_EXECUTABLE_PATH ?? (await downloadAndUnzipVSCode({ version: expectedHostVersion }))
		const output = process.env.ALPHA_HISTORY_UI_OUTPUT ?? path.join(os.tmpdir(), "alpha-code-history-ux")
		console.log(JSON.stringify(await runHistoryUi(executable, output, expectedHostVersion)))
	})().catch((error) => {
		console.error(error)
		process.exitCode = 1
	})
}
