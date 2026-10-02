import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { randomUUID } from "node:crypto"

import { downloadAndUnzipVSCode } from "@vscode/test-electron"

import { runExtensionTests } from "./runTest"
import { waitUntil } from "./evidence/sharedStorageProtocol"
import { writeJsonAtomically } from "./suite/preflightEvidence"
import { TEST_ROOT_OWNERSHIP_MARKER } from "./testProfile"
import { CdpConnection } from "./ui/cdp"

interface Target {
	targetId: string
	type: string
	url: string
}

interface ClickTarget {
	x: number
	y: number
	label: string
	tagName: string
	className: string
}

interface NavigationUiProbe {
	mode: "new-chat" | "task-open"
	firstVisibleKind?: "new-chat-home" | "opening-indicator" | "task-transcript"
	firstVisibleAtEpochMs?: number
	firstVisibleFrameAtEpochMs?: number
	openingIndicatorAtEpochMs?: number
	openingIndicatorFrameAtEpochMs?: number
	transcriptAtEpochMs?: number
	transcriptFrameAtEpochMs?: number
	settledAtEpochMs?: number
	quietPeriodMs?: number
	lastMutationAtEpochMs?: number
	transcriptCount?: number
	openingIndicatorRemoved?: boolean
	frameStable?: boolean
	error?: string
}

interface HostIdentity {
	status: "passed" | "failed" | "blocked"
	execution: "extension-host" | "test-seam"
	ownershipGate?: "verified"
	captureComplete?: boolean
	hostExitObserved: boolean
	actualVSCodeVersion?: string
	extensionHostPid?: number
	evidenceManifestPath?: string
	artifactsDir: string
}

interface StageReceipt {
	nonce?: unknown
	stage?: unknown
	version?: unknown
	[key: string]: unknown
}

interface SystemSnapshot {
	cpuTotalMs: number
	cpuIdleMs: number
	freeMemoryBytes: number
	totalMemoryBytes: number
}

const EXPECTED_HOST = "1.125.0"
const TRANSCRIPT_MESSAGES = 1_200
const TRANSCRIPT_SENTINEL = "task-navigation-ui-transcript-sentinel"
const CYCLES = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"] as const
const QUIET_PERIOD_MS = 150
const PHASE_TIMEOUT_MS = 360_000

function systemSnapshot(): SystemSnapshot {
	const times = os.cpus().reduce(
		(total, cpu) => {
			for (const [kind, duration] of Object.entries(cpu.times)) {
				total.total += duration
				if (kind === "idle") total.idle += duration
			}
			return total
		},
		{ total: 0, idle: 0 },
	)
	return {
		cpuTotalMs: times.total,
		cpuIdleMs: times.idle,
		freeMemoryBytes: os.freemem(),
		totalMemoryBytes: os.totalmem(),
	}
}

function summarizeSystem(before: SystemSnapshot, after: SystemSnapshot) {
	const totalDeltaMs = Math.max(0, after.cpuTotalMs - before.cpuTotalMs)
	const idleDeltaMs = Math.max(0, after.cpuIdleMs - before.cpuIdleMs)
	return {
		hostWideCpuBusyPercent: totalDeltaMs
			? Math.max(0, Math.min(100, ((totalDeltaMs - idleDeltaMs) / totalDeltaMs) * 100))
			: null,
		freeMemoryBeforeBytes: before.freeMemoryBytes,
		freeMemoryAfterBytes: after.freeMemoryBytes,
		cpuSampleIntervalMs: totalDeltaMs,
	}
}

function summarize(values: number[]) {
	if (!values.length) return null
	const ordered = [...values].sort((left, right) => left - right)
	const at = (quantile: number) => ordered[Math.max(0, Math.ceil(quantile * ordered.length) - 1)]!
	return { count: ordered.length, p50: at(0.5), p95: at(0.95), max: ordered.at(-1)! }
}

function requireHostSuccess(
	host: HostIdentity,
	expectedVersion: string,
	phase: string,
): asserts host is HostIdentity & {
	status: "passed"
	execution: "extension-host"
	ownershipGate: "verified"
	captureComplete: true
	hostExitObserved: true
	actualVSCodeVersion: string
	extensionHostPid: number
	evidenceManifestPath: string
} {
	if (
		host.status !== "passed" ||
		host.execution !== "extension-host" ||
		host.ownershipGate !== "verified" ||
		host.captureComplete !== true ||
		host.hostExitObserved !== true ||
		host.actualVSCodeVersion !== expectedVersion ||
		!Number.isSafeInteger(host.extensionHostPid) ||
		!host.evidenceManifestPath
	) {
		throw new Error(`${phase} host validation failed; inspect retained evidence in ${host.artifactsDir}`)
	}
}

async function readBundleHash(host: HostIdentity): Promise<string> {
	assert.ok(host.evidenceManifestPath)
	const manifest = JSON.parse(await fs.readFile(host.evidenceManifestPath, "utf8")) as { bundleSha256?: unknown }
	assert.equal(typeof manifest.bundleSha256, "string")
	assert.match(manifest.bundleSha256 as string, /^[a-f0-9]{64}$/)
	return manifest.bundleSha256 as string
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
}

function createPhase(
	phase: "seed" | "reopen",
	root: string,
	executable: string,
	version: string,
	nonce: string,
	taskId?: string,
) {
	const runId = `navigation-${phase}-${nonce}`
	const evidenceRoot = path.join(root, "evidence")
	const directory = path.join(evidenceRoot, runId)
	const abort = new AbortController()
	const timer = setTimeout(() => abort.abort(), PHASE_TIMEOUT_MS)
	let hostSettled = false
	const running = runExtensionTests({
		providerMode: "scripted",
		vscodeVersion: version,
		vscodeExecutablePath: executable,
		testFile: "task-navigation-ui.test",
		...(phase === "reopen" ? { rendererDebuggingPort: 0 as const } : {}),
		runId,
		profileDir: path.join(root, "profile"),
		workspace: path.join(root, "workspace"),
		artifactsDir: evidenceRoot,
		initializeProfile: phase === "seed",
		retainEvidenceForCampaign: true,
		extensionTestsEnv: {
			ALPHA_UI_ACCEPTANCE_NONCE: nonce,
			ALPHA_TASK_NAVIGATION_UI_PHASE: phase,
			ALPHA_TASK_NAVIGATION_UI_TASK_ID: taskId ?? "",
		},
		signal: abort.signal,
	}).finally(() => {
		hostSettled = true
		clearTimeout(timer)
	})
	const hostEnded = running.then(() => {
		throw new Error(`${phase} host exited before the renderer acknowledged its final stage`)
	})
	void hostEnded.catch(() => {})
	const ready = async (stage: string): Promise<StageReceipt> => {
		await Promise.race([
			hostEnded,
			waitUntil(
				async () => {
					abort.signal.throwIfAborted()
					if (hostSettled) throw new Error(`${phase} host exited before stage ${stage}`)
					try {
						const receipt = JSON.parse(
							await fs.readFile(path.join(directory, `ui-stage-${stage}.json`), "utf8"),
						) as StageReceipt
						assert.equal(receipt.nonce, nonce)
						assert.equal(receipt.stage, stage)
						assert.equal(receipt.version, version)
						return true
					} catch (error) {
						if (isMissing(error)) return false
						throw error
					}
				},
				Date.now() + 75_000,
				`navigation_${phase}_${stage}_timeout`,
			),
		])
		return JSON.parse(await fs.readFile(path.join(directory, `ui-stage-${stage}.json`), "utf8")) as StageReceipt
	}
	const acknowledge = async (stage: string, detail: Record<string, unknown> = {}) => {
		await writeJsonAtomically(
			path.join(directory, `ui-done-${stage}.json`),
			{ ...detail, nonce, stage, status: "passed" },
			{ rename: fs.link },
		)
	}
	return { abort, running, directory, evidenceRoot, ready, acknowledge }
}

function documentExpression(body: string, useActiveFrame = true) {
	return `(()=>{const d=${useActiveFrame ? "document.getElementById('active-frame')?.contentDocument??document" : "document"};const win=d.defaultView??window;${body}})()`
}

async function evaluate<T>(
	connection: CdpConnection,
	sessionId: string,
	body: string,
	useActiveFrame = true,
): Promise<T> {
	const result = await connection.request<{ result: { value: T }; exceptionDetails?: unknown }>(
		"Runtime.evaluate",
		{ expression: documentExpression(body, useActiveFrame), returnByValue: true },
		sessionId,
	)
	if (result.exceptionDetails) throw new Error("Renderer probe evaluation failed")
	return result.result.value
}

async function armClickTarget(
	connection: CdpConnection,
	sessionId: string,
	target: "new-chat" | "task-open",
	taskId?: string,
): Promise<ClickTarget> {
	const taskSelector = taskId ? `[data-testid="task-item-${taskId}"]` : ""
	const body =
		target === "new-chat"
			? `const labels=e=>[e.getAttribute('aria-label'),e.getAttribute('title')].filter(Boolean);const visible=e=>{const r=e.getBoundingClientRect(),s=win.getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'};const candidates=[...d.querySelectorAll('[aria-label],[title]')].filter(e=>labels(e).some(v=>/new chat/i.test(v))&&visible(e));const target=candidates.find(e=>e.classList.contains('action-label'))??candidates[0];const descriptions=candidates.slice(0,12).map(e=>({tagName:e.tagName,className:String(e.className),labels:labels(e)}));if(!target)return {error:'new-chat-action-not-found',descriptions};`
			: `const target=d.querySelector(${JSON.stringify(taskSelector)});if(!target)return {error:'task-row-not-found'};const visible=e=>{const r=e.getBoundingClientRect(),s=win.getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'};if(!visible(target))return {error:'task-row-not-visible'};`
	const result = await evaluate<ClickTarget & { error?: string; descriptions?: unknown }>(
		connection,
		sessionId,
		`${body}const rect=target.getBoundingClientRect();let capture=win.__alphaTaskNavigationClickCapture;if(!capture){capture={target:null,clickedAtEpochMs:null,trusted:false};win.__alphaTaskNavigationClickCapture=capture;d.addEventListener('click',event=>{if(capture.target&&event.isTrusted&&event.composedPath().includes(capture.target)){capture.clickedAtEpochMs=Date.now();capture.trusted=true}},true)}capture.target=target;capture.clickedAtEpochMs=null;capture.trusted=false;return {x:rect.left+rect.width/2,y:rect.top+rect.height/2,label:(target.getAttribute('aria-label')||target.getAttribute('title')||target.textContent||'').trim().slice(0,160),tagName:target.tagName,className:String(target.className)};`,
		target === "task-open",
	)
	if ("error" in result && result.error) {
		throw new Error(
			`Unable to locate ${target} click target: ${JSON.stringify({ error: result.error, descriptions: result.descriptions })}`,
		)
	}
	assert.ok(Number.isFinite(result.x) && Number.isFinite(result.y))
	return result
}

async function waitForClickTarget(
	connection: CdpConnection,
	sessionId: string,
	target: "new-chat" | "task-open",
	taskId?: string,
) {
	const selector = taskId ? `[data-testid="task-item-${taskId}"]` : ""
	const body =
		target === "new-chat"
			? `return [...d.querySelectorAll('[aria-label],[title]')].some(e=>/new chat/i.test((e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||''))&&(()=>{const r=e.getBoundingClientRect(),s=win.getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'})())`
			: `const e=d.querySelector(${JSON.stringify(selector)});if(!e)return false;const r=e.getBoundingClientRect(),s=win.getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'`
	await waitUntil(
		async () => evaluate<boolean>(connection, sessionId, body, target === "task-open"),
		Date.now() + 30_000,
		`navigation_${target}_target_timeout`,
	)
}

async function clickTarget(connection: CdpConnection, sessionId: string, target: ClickTarget) {
	for (const type of ["mouseMoved", "mousePressed", "mouseReleased"] as const) {
		await connection.request(
			"Input.dispatchMouseEvent",
			{
				type,
				x: target.x,
				y: target.y,
				button: type === "mouseMoved" ? "none" : "left",
				clickCount: type === "mouseMoved" ? 0 : 1,
			},
			sessionId,
		)
	}
}

async function installNavigationProbe(
	connection: CdpConnection,
	sessionId: string,
	mode: "new-chat" | "task-open",
	taskId: string,
) {
	const rowSelector = `[data-testid="task-item-${taskId}"]`
	const body = `const mode=${JSON.stringify(mode)},taskSelector=${JSON.stringify(rowSelector)},sentinel=${JSON.stringify(TRANSCRIPT_SENTINEL)},expectedCount=${TRANSCRIPT_MESSAGES},quietMs=${QUIET_PERIOD_MS};const previous=win.__alphaTaskNavigationProbe;if(previous){clearInterval(previous.interval);previous.observer?.disconnect()}const probe={mode,lastMutationAtEpochMs:Date.now()};win.__alphaTaskNavigationProbe=probe;const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=win.getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'};const state=()=>{if(mode==='new-chat'){const home=d.querySelector('[data-testid="alpha-home-brand"]'),composer=d.querySelector('textarea'),transcript=d.querySelector('[data-testid="chat-transcript-viewport"]');return {primary:visible(home)&&visible(composer)&&!transcript,kind:'new-chat-home',final:visible(home)&&visible(composer)&&!transcript,transcriptCount:0,opening:false}}const row=d.querySelector(taskSelector),indicator=row?.querySelector('[data-testid="task-opening-indicator"]'),content=d.querySelector('[data-testid="chat-transcript-content"]'),count=Number(content?.dataset.count??0),hasSentinel=!!content&&content.textContent?.includes(sentinel)===true,transcript=visible(content)&&count>=expectedCount&&hasSentinel,opening=visible(indicator);return {primary:opening||transcript,kind:opening?'opening-indicator':'task-transcript',final:transcript&&!opening&&row?.getAttribute('aria-busy')!=='true',transcriptCount:count,opening}};const frame=callback=>win.requestAnimationFrame(()=>win.requestAnimationFrame(()=>callback(Date.now())));const inspect=()=>{if(probe.settledAtEpochMs)return;const current=state();const now=Date.now();probe.transcriptCount=current.transcriptCount;if(current.opening&&!probe.openingIndicatorAtEpochMs){probe.openingIndicatorAtEpochMs=now;frame(at=>{probe.openingIndicatorFrameAtEpochMs=at})}if(current.primary&&!probe.firstVisibleAtEpochMs){probe.firstVisibleKind=current.kind;probe.firstVisibleAtEpochMs=now;frame(at=>{probe.firstVisibleFrameAtEpochMs=at})}if(current.kind==='task-transcript'&&current.final&&!probe.transcriptAtEpochMs){probe.transcriptAtEpochMs=now;frame(at=>{probe.transcriptFrameAtEpochMs=at})}if(current.final&&now-probe.lastMutationAtEpochMs>=quietMs){probe.quietPeriodMs=now-probe.lastMutationAtEpochMs;frame(at=>{const final=state(),settledNow=Date.now();if(final.final&&settledNow-probe.lastMutationAtEpochMs>=quietMs){probe.settledAtEpochMs=settledNow;probe.quietPeriodMs=settledNow-probe.lastMutationAtEpochMs;probe.openingIndicatorRemoved=mode==='new-chat'||!final.opening;probe.frameStable=true;clearInterval(probe.interval);probe.observer.disconnect()}})}};probe.observer=new win.MutationObserver(()=>{probe.lastMutationAtEpochMs=Date.now();inspect()});probe.observer.observe(d.body,{childList:true,subtree:true,characterData:true});probe.interval=setInterval(inspect,25);inspect();return true;`
	assert.equal(await evaluate<boolean>(connection, sessionId, body, true), true)
}

async function readClickCapture(connection: CdpConnection, sessionId: string, useActiveFrame: boolean) {
	await waitUntil(
		async () => {
			const result = await evaluate<{ trusted: boolean; clickedAtEpochMs?: number }>(
				connection,
				sessionId,
				`const value=win.__alphaTaskNavigationClickCapture;return {trusted:value?.trusted===true,clickedAtEpochMs:value?.clickedAtEpochMs}`,
				useActiveFrame,
			)
			return result.trusted && typeof result.clickedAtEpochMs === "number"
		},
		Date.now() + 5_000,
		"navigation_trusted_click_timeout",
	)
	return evaluate<{ trusted: boolean; clickedAtEpochMs: number }>(
		connection,
		sessionId,
		`const value=win.__alphaTaskNavigationClickCapture;return {trusted:value?.trusted===true,clickedAtEpochMs:value?.clickedAtEpochMs}`,
		useActiveFrame,
	)
}

async function readUiProbe(connection: CdpConnection, sessionId: string): Promise<NavigationUiProbe> {
	await waitUntil(
		async () => {
			const probe = await evaluate<NavigationUiProbe>(
				connection,
				sessionId,
				"return win.__alphaTaskNavigationProbe",
			)
			return typeof probe?.settledAtEpochMs === "number"
		},
		Date.now() + 60_000,
		"navigation_ui_settle_timeout",
	)
	return evaluate<NavigationUiProbe>(connection, sessionId, "return win.__alphaTaskNavigationProbe")
}

async function rendererMetrics(connection: CdpConnection, sessionId: string) {
	try {
		await connection.request("Performance.enable", {}, sessionId)
		const response = await connection.request<{ metrics: Array<{ name: string; value: number }> }>(
			"Performance.getMetrics",
			{},
			sessionId,
		)
		return Object.fromEntries(response.metrics.map(({ name, value }) => [name, value]))
	} catch {
		return { unavailable: true }
	}
}

async function clickAndMeasure(
	connection: CdpConnection,
	pageSession: string,
	webviewSession: string,
	taskId: string,
	operation: "new-chat" | "task-open",
) {
	const clickSession = operation === "new-chat" ? pageSession : webviewSession
	const clickUsesActiveFrame = operation === "task-open"
	const rendererBefore = await rendererMetrics(connection, webviewSession)
	const systemBefore = systemSnapshot()
	await installNavigationProbe(connection, webviewSession, operation, taskId)
	await waitForClickTarget(connection, clickSession, operation, taskId)
	const target = await armClickTarget(connection, clickSession, operation, taskId)
	await clickTarget(connection, clickSession, target)
	const click = await readClickCapture(connection, clickSession, clickUsesActiveFrame)
	assert.equal(click.trusted, true, "The interaction must use a trusted pointer click")
	const probe = await readUiProbe(connection, webviewSession)
	const rendererAfter = await rendererMetrics(connection, webviewSession)
	const systemAfter = systemSnapshot()
	const visibleAt = probe.firstVisibleFrameAtEpochMs ?? probe.firstVisibleAtEpochMs
	assert.ok(visibleAt, `${operation} must produce a visible frame`)
	assert.ok(probe.settledAtEpochMs && probe.frameStable === true, `${operation} must reach a quiet, frame-stable UI`)
	assert.equal(probe.openingIndicatorRemoved, true)
	if (operation === "task-open") {
		assert.ok((probe.transcriptCount ?? 0) >= TRANSCRIPT_MESSAGES)
		assert.ok(probe.transcriptFrameAtEpochMs, "Reopened task transcript must paint before settling")
	}
	return {
		operation,
		clickTarget: { label: target.label, tagName: target.tagName, className: target.className },
		trustedPointerClick: click.trusted,
		clickAtEpochMs: click.clickedAtEpochMs,
		firstVisibleKind: probe.firstVisibleKind,
		firstVisibleAtEpochMs: probe.firstVisibleAtEpochMs,
		firstVisibleFrameAtEpochMs: probe.firstVisibleFrameAtEpochMs,
		openingIndicatorAtEpochMs: probe.openingIndicatorAtEpochMs ?? null,
		openingIndicatorFrameAtEpochMs: probe.openingIndicatorFrameAtEpochMs ?? null,
		transcriptAtEpochMs: probe.transcriptAtEpochMs ?? null,
		transcriptFrameAtEpochMs: probe.transcriptFrameAtEpochMs ?? null,
		settledAtEpochMs: probe.settledAtEpochMs,
		quietPeriodMs: probe.quietPeriodMs,
		transcriptCount: probe.transcriptCount ?? 0,
		openingIndicatorRemoved: probe.openingIndicatorRemoved,
		frameStable: probe.frameStable,
		latencyMs: {
			clickToFirstVisibleFrame: visibleAt - click.clickedAtEpochMs,
			clickToSettledUi: probe.settledAtEpochMs! - click.clickedAtEpochMs,
		},
		rendererMetrics: { before: rendererBefore, after: rendererAfter },
		systemActivity: summarizeSystem(systemBefore, systemAfter),
	}
}

async function waitForTargets(connection: CdpConnection, deadline: number) {
	let selected: { webviewSession: string; pageSession: string; webview: Target; page: Target } | undefined
	await waitUntil(
		async () => {
			const { targetInfos } = await connection.request<{ targetInfos: Target[] }>("Target.getTargets")
			const webview = targetInfos.find((target) => target.url.includes("extensionId=AlphaInc.alpha"))
			const page = targetInfos.find((target) => target.type === "page" && target.url.includes("workbench"))
			if (!webview || !page) return false
			const attach = async (target: Target) => {
				const result = await connection.request<{ sessionId: string }>("Target.attachToTarget", {
					targetId: target.targetId,
					flatten: true,
				})
				return result.sessionId
			}
			selected = {
				webviewSession: await attach(webview),
				pageSession: await attach(page),
				webview,
				page,
			}
			return true
		},
		deadline,
		"navigation_renderer_targets_timeout",
	)
	assert.ok(selected)
	return selected
}

async function connectOwnedRenderer(profileRoot: string, version: string, deadline: number) {
	const userData = path.join(profileRoot, version, "user-data")
	let endpoint = ""
	await waitUntil(
		async () => {
			try {
				endpoint = await fs.readFile(path.join(userData, "DevToolsActivePort"), "utf8")
				return endpoint.trim().length > 0
			} catch (error) {
				if (isMissing(error)) return false
				throw error
			}
		},
		deadline,
		"navigation_devtools_endpoint_timeout",
	)
	const [port, browserPath] = endpoint.trim().split(/\r?\n/)
	assert.match(port ?? "", /^\d{1,5}$/)
	assert.match(browserPath ?? "", /^\/devtools\/browser\/[A-Za-z0-9-]+$/)
	return CdpConnection.connect(`ws://127.0.0.1:${port}${browserPath}`)
}

async function acknowledgeSeed(phase: ReturnType<typeof createPhase>, nonce: string, version: string) {
	const receipt = await phase.ready("seeded")
	assert.equal(receipt.version, version)
	assert.equal(typeof receipt.taskId, "string")
	assert.match(receipt.taskId as string, /^[A-Za-z0-9-]+$/)
	assert.equal(receipt.syntheticMessageCount, TRANSCRIPT_MESSAGES)
	assert.equal(receipt.sentinel, TRANSCRIPT_SENTINEL)
	assert.ok(typeof receipt.newChatCommandReturnMs === "number")
	await phase.acknowledge("seeded")
	return { receipt, host: await phase.running }
}

export async function runTaskNavigationUi(executable: string, output: string, expectedHostVersion = EXPECTED_HOST) {
	if (expectedHostVersion !== EXPECTED_HOST) {
		throw new Error(`Task navigation UX certification is pinned to VS Code ${EXPECTED_HOST}`)
	}
	await fs.mkdir(output, { recursive: true })
	const root = await fs.mkdtemp(path.join(output, "run-"))
	const nonce = randomUUID()
	const profileRoot = path.join(root, "profile")
	const workspace = path.join(root, "workspace")
	const profileMarkerPath = path.join(profileRoot, TEST_ROOT_OWNERSHIP_MARKER)
	const markerBefore = await fs.readFile(profileMarkerPath).catch((error: unknown) => {
		if (isMissing(error)) return undefined
		throw error
	})
	if (markerBefore) throw new Error("The task navigation runner requires a fresh profile path")

	const seedPhase = createPhase("seed", root, executable, expectedHostVersion, nonce)
	let activePhase: ReturnType<typeof createPhase> | undefined = seedPhase
	let connection: CdpConnection | undefined
	try {
		const { receipt: seedReceipt, host: seedHost } = await acknowledgeSeed(seedPhase, nonce, expectedHostVersion)
		requireHostSuccess(seedHost, expectedHostVersion, "seed")
		const seedBundleHash = await readBundleHash(seedHost)
		const taskId = seedReceipt.taskId as string
		const profileMarker = await fs.readFile(profileMarkerPath, "utf8")

		const reopenPhase = createPhase("reopen", root, executable, expectedHostVersion, nonce, taskId)
		activePhase = reopenPhase
		const coldStagePromise = reopenPhase.ready("cold-open")
		connection = await connectOwnedRenderer(profileRoot, expectedHostVersion, Date.now() + 75_000)
		const targets = await waitForTargets(connection, Date.now() + 75_000)
		await connection.request("Page.bringToFront", {}, targets.pageSession)

		const measurements: Array<Record<string, unknown>> = []
		const persistMeasurements = async (stage: string) =>
			writeJsonAtomically(path.join(root, "task-navigation-ui-samples.json"), {
				schemaVersion: 1,
				stage,
				hostVersion: expectedHostVersion,
				taskId,
				extensionBundleSha256: seedBundleHash,
				profileMarkerPath,
				profileMarker: JSON.parse(profileMarker),
				measurements,
			})
		const coldReceipt = await coldStagePromise
		assert.equal(coldReceipt.taskId, taskId)
		assert.equal(coldReceipt.extensionHostPid === seedHost.extensionHostPid, false)
		assert.equal(coldReceipt.taskHistoryContainsTask, true)
		try {
			await waitForClickTarget(connection, targets.webviewSession, "task-open", taskId)
		} catch (error) {
			const dom = await evaluate<Record<string, unknown>>(
				connection,
				targets.webviewSession,
				`const rows=[...d.querySelectorAll('[data-testid^="task-item-"]')];return {url:d.URL,hasActiveFrame:!!document.getElementById('active-frame'),taskId:${JSON.stringify(taskId)},taskRowPresent:!!d.querySelector('[data-testid="task-item-${taskId}"]'),taskRowIds:rows.slice(0,20).map(e=>e.getAttribute('data-testid')),historyViewAllPresent:!!d.querySelector('[data-testid="history-view-all"]'),historyListPresent:!!d.querySelector('[data-testid="history-preview-list"]'),bodyText:d.body.innerText.slice(0,1200)}`,
			)
			const screenshot = await connection.request<{ data: string }>(
				"Page.captureScreenshot",
				{ format: "png" },
				targets.pageSession,
			)
			const diagnosticPath = path.join(root, "cold-task-row-diagnostic.json")
			await fs.writeFile(
				diagnosticPath,
				JSON.stringify({ stage: coldReceipt, dom, error: String(error) }, null, 2),
			)
			await fs.writeFile(path.join(root, "cold-task-row-diagnostic.png"), Buffer.from(screenshot.data, "base64"))
			throw new Error(`Task row was not available; inspect ${diagnosticPath}`)
		}
		const coldClickTarget = await armClickTarget(connection, targets.webviewSession, "task-open", taskId)
		await installNavigationProbe(connection, targets.webviewSession, "task-open", taskId)
		const coldRendererBefore = await rendererMetrics(connection, targets.webviewSession)
		const coldSystemBefore = systemSnapshot()
		await clickTarget(connection, targets.webviewSession, coldClickTarget)
		const coldClick = await readClickCapture(connection, targets.webviewSession, true)
		const coldUi = await readUiProbe(connection, targets.webviewSession)
		assert.equal(coldClick.trusted, true)
		assert.ok(coldUi.settledAtEpochMs && coldUi.frameStable === true)
		assert.ok((coldUi.transcriptCount ?? 0) >= TRANSCRIPT_MESSAGES)
		const coldRendererAfter = await rendererMetrics(connection, targets.webviewSession)
		const coldSystemAfter = systemSnapshot()
		await reopenPhase.acknowledge("cold-open", {
			version: expectedHostVersion,
			taskId,
			trustedPointerClick: true,
			clickAtEpochMs: coldClick.clickedAtEpochMs,
			firstVisibleFrameAtEpochMs: coldUi.firstVisibleFrameAtEpochMs,
			settledAtEpochMs: coldUi.settledAtEpochMs,
		})
		measurements.push({
			phase: "process-cold-first-task-open",
			cacheState: "task-object-absent-at-start-of-new-extension-host-process",
			clickTarget: {
				label: coldClickTarget.label,
				tagName: coldClickTarget.tagName,
				className: coldClickTarget.className,
			},
			trustedPointerClick: true,
			clickAtEpochMs: coldClick.clickedAtEpochMs,
			firstVisibleKind: coldUi.firstVisibleKind,
			firstVisibleAtEpochMs: coldUi.firstVisibleAtEpochMs,
			firstVisibleFrameAtEpochMs: coldUi.firstVisibleFrameAtEpochMs,
			openingIndicatorAtEpochMs: coldUi.openingIndicatorAtEpochMs ?? null,
			openingIndicatorFrameAtEpochMs: coldUi.openingIndicatorFrameAtEpochMs ?? null,
			transcriptAtEpochMs: coldUi.transcriptAtEpochMs ?? null,
			transcriptFrameAtEpochMs: coldUi.transcriptFrameAtEpochMs ?? null,
			settledAtEpochMs: coldUi.settledAtEpochMs,
			quietPeriodMs: coldUi.quietPeriodMs,
			transcriptCount: coldUi.transcriptCount,
			openingIndicatorRemoved: coldUi.openingIndicatorRemoved,
			frameStable: coldUi.frameStable,
			latencyMs: {
				clickToFirstVisibleFrame:
					(coldUi.firstVisibleFrameAtEpochMs ?? coldUi.firstVisibleAtEpochMs!) - coldClick.clickedAtEpochMs,
				clickToSettledUi: coldUi.settledAtEpochMs! - coldClick.clickedAtEpochMs,
			},
			rendererMetrics: { before: coldRendererBefore, after: coldRendererAfter },
			systemActivity: summarizeSystem(coldSystemBefore, coldSystemAfter),
		})
		await persistMeasurements("process-cold-first-task-open")

		for (const cycle of CYCLES) {
			const blankStage = reopenPhase.ready(`warm-${cycle}-new-chat`)
			const stageReceipt = await blankStage
			assert.equal(stageReceipt.taskId, taskId)
			const blank = await clickAndMeasure(
				connection,
				targets.pageSession,
				targets.webviewSession,
				taskId,
				"new-chat",
			)
			await reopenPhase.acknowledge(`warm-${cycle}-new-chat`, { version: expectedHostVersion, taskId, cycle })
			measurements.push({ phase: "warm-new-chat", cycle, ...blank })
			await persistMeasurements(`warm-${cycle}-new-chat`)

			const taskStage = await reopenPhase.ready(`warm-${cycle}-task-open`)
			assert.equal(taskStage.taskId, taskId)
			const reopened = await clickAndMeasure(
				connection,
				targets.pageSession,
				targets.webviewSession,
				taskId,
				"task-open",
			)
			await reopenPhase.acknowledge(`warm-${cycle}-task-open`, {
				version: expectedHostVersion,
				taskId,
				cycle,
			})
			measurements.push({ phase: "warm-task-open", cycle, ...reopened })
			await persistMeasurements(`warm-${cycle}-task-open`)
		}

		const completion = await reopenPhase.ready("benchmark-complete")
		assert.equal(completion.taskId, taskId)
		await reopenPhase.acknowledge("benchmark-complete")
		const coldOpenObservedAtEpochMs = completion.coldOpenObservedAtEpochMs as number | undefined
		const extensionHostActivity = completion.extensionHostActivity as
			| {
					warmHostObservations?: Array<{
						cycle: string
						newChatObservedAtEpochMs: number
						taskOpenObservedAtEpochMs: number
					}>
			  }
			| undefined
		assert.equal(typeof coldOpenObservedAtEpochMs, "number")
		assert.equal(extensionHostActivity?.warmHostObservations?.length, CYCLES.length)
		const coldMeasurement = measurements[0]!
		const coldLatency = coldMeasurement.latencyMs as Record<string, number>
		coldLatency.clickToExtensionHostObservation =
			Number(coldOpenObservedAtEpochMs) - Number(coldMeasurement.clickAtEpochMs)
		for (const observation of extensionHostActivity!.warmHostObservations!) {
			for (const [phase, observedAt] of [
				["warm-new-chat", observation.newChatObservedAtEpochMs],
				["warm-task-open", observation.taskOpenObservedAtEpochMs],
			] as const) {
				const measurement = measurements.find(
					(item) => item.phase === phase && item.cycle === observation.cycle,
				)
				assert.ok(measurement, `Missing ${phase} measurement for ${observation.cycle}`)
				const latency = measurement.latencyMs as Record<string, number>
				latency.clickToExtensionHostObservation = observedAt - Number(measurement.clickAtEpochMs)
			}
		}
		const reopenHost = await reopenPhase.running
		requireHostSuccess(reopenHost, expectedHostVersion, "reopen")
		const reopenBundleHash = await readBundleHash(reopenHost)
		assert.equal(
			reopenBundleHash,
			seedBundleHash,
			"Both exact-host processes must use identical bundled Alpha bytes",
		)
		assert.notEqual(
			reopenHost.extensionHostPid,
			seedHost.extensionHostPid,
			"The cold phase must use a fresh extension host",
		)
		assert.equal(
			await fs.readFile(profileMarkerPath, "utf8"),
			profileMarker,
			"The same marked profile must be reused",
		)

		const navigationMeasurements = measurements.filter((item) => item.phase !== "process-cold-first-task-open")
		const report = {
			schemaVersion: 1,
			hostVersion: expectedHostVersion,
			provider: "scripted",
			modelRequests: 0,
			seedRunId: seedHost.runId,
			reopenRunId: reopenHost.runId,
			profile: {
				markerPath: profileMarkerPath,
				marker: JSON.parse(profileMarker),
				profileRoot,
				workspace,
				identity: path.basename(root),
			},
			processState: {
				seedExtensionHostPid: seedHost.extensionHostPid,
				reopenExtensionHostPid: reopenHost.extensionHostPid,
				freshExtensionHost: seedHost.extensionHostPid !== reopenHost.extensionHostPid,
				processColdFirstTaskOpenSamples: 1,
				taskObjectColdReopenSamples: 1,
				warmBlankSamples: CYCLES.length,
				warmTaskReopenSamples: CYCLES.length,
				warmCycleCount: CYCLES.length,
			},
			fixture: {
				taskId,
				transcriptMessages: TRANSCRIPT_MESSAGES,
				transcriptSentinel: TRANSCRIPT_SENTINEL,
				coldStartTaskAbsent: true,
				warmNavigationSameTaskObject: true,
			},
			bundle: { sha256: seedBundleHash, identicalAcrossProcesses: seedBundleHash === reopenBundleHash },
			measurement: {
				clock: "Date.now epoch milliseconds from the owned renderer and extension-host processes",
				firstVisible: "first qualifying DOM content followed by a double requestAnimationFrame callback",
				settled: `final UI predicate remained true after ${QUIET_PERIOD_MS} ms without child, text, or subtree mutations and two more animation frames`,
				extensionHostAcknowledgement:
					"host observes the UI fixture stage after the external driver writes its completion marker (50 ms polling granularity)",
				commandReturn:
					"seed phase calls alpha.plusButtonClicked directly and records the extension-host command promise return",
				limitations: [
					"One VS Code window is measured; one-versus-six-window shared contention is not included.",
					"The workload uses 1,200 synthetic persisted messages and a scripted provider; it does not call a live model or perform browser work.",
					"Host-wide CPU and free memory include unrelated system activity; renderer and extension-host metrics are scoped more narrowly.",
				],
				seedNewChatCommandReturnMs: seedReceipt.newChatCommandReturnMs,
			},
			summaryMs: {
				processColdFirstTaskOpenFirstVisible: summarize([
					Number((measurements[0]!.latencyMs as Record<string, number>).clickToFirstVisibleFrame),
				]),
				processColdFirstTaskOpenSettled: summarize([
					Number((measurements[0]!.latencyMs as Record<string, number>).clickToSettledUi),
				]),
				warmNewChatFirstVisible: summarize(
					navigationMeasurements
						.filter((item) => item.phase === "warm-new-chat")
						.map((item) => Number((item.latencyMs as Record<string, number>).clickToFirstVisibleFrame)),
				),
				warmNewChatSettled: summarize(
					navigationMeasurements
						.filter((item) => item.phase === "warm-new-chat")
						.map((item) => Number((item.latencyMs as Record<string, number>).clickToSettledUi)),
				),
				warmTaskOpenFirstVisible: summarize(
					navigationMeasurements
						.filter((item) => item.phase === "warm-task-open")
						.map((item) => Number((item.latencyMs as Record<string, number>).clickToFirstVisibleFrame)),
				),
				warmTaskOpenSettled: summarize(
					navigationMeasurements
						.filter((item) => item.phase === "warm-task-open")
						.map((item) => Number((item.latencyMs as Record<string, number>).clickToSettledUi)),
				),
				warmNewChatExtensionHostObservation: summarize(
					navigationMeasurements
						.filter((item) => item.phase === "warm-new-chat")
						.map((item) =>
							Number((item.latencyMs as Record<string, number>).clickToExtensionHostObservation),
						),
				),
				warmTaskOpenExtensionHostObservation: summarize(
					navigationMeasurements
						.filter((item) => item.phase === "warm-task-open")
						.map((item) =>
							Number((item.latencyMs as Record<string, number>).clickToExtensionHostObservation),
						),
				),
			},
			measurements,
			extensionHostActivity,
			evidence: {
				seed: { directory: seedHost.artifactsDir, manifest: seedHost.evidenceManifestPath },
				reopen: { directory: reopenHost.artifactsDir, manifest: reopenHost.evidenceManifestPath },
				profileRoot,
			},
		}
		const reportPath = path.join(root, "task-navigation-ui-benchmark.json")
		await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { flag: "wx" })
		return { status: "passed" as const, reportPath, root, report }
	} finally {
		connection?.close()
		activePhase?.abort.abort()
		await activePhase?.running.catch(() => undefined)
		if (seedPhase !== activePhase) {
			seedPhase.abort.abort()
			await seedPhase.running.catch(() => undefined)
		}
	}
}

if (require.main === module) {
	void (async () => {
		const expectedHostVersion = process.env.ALPHA_TASK_NAVIGATION_UI_VSCODE_VERSION ?? EXPECTED_HOST
		const executable =
			process.env.VSCODE_EXECUTABLE_PATH ?? (await downloadAndUnzipVSCode({ version: expectedHostVersion }))
		const output =
			process.env.ALPHA_TASK_NAVIGATION_UI_OUTPUT ?? path.join(os.tmpdir(), "alpha-code-task-navigation-ux")
		console.log(JSON.stringify(await runTaskNavigationUi(executable, output, expectedHostVersion)))
	})().catch((error) => {
		console.error(error)
		process.exitCode = 1
	})
}
