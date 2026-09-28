import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { downloadAndUnzipVSCode } from "@vscode/test-electron"
import { runExtensionTests, type ExtensionTestRunResult } from "./runTest"
import { CdpConnection } from "./ui/cdp"
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
	text: string
}

interface RendererNavigationProbe {
	startedAt: number
	domAt?: number
	paintedAt?: number
	openingFeedbackAt?: number
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
	expectedHostVersion = "1.122.1",
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
export async function runHistoryUi(executable: string, output: string, expectedHostVersion = "1.122.1") {
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
		const evaluate = async <T>(expression: string): Promise<T> => {
			abort.signal.throwIfAborted()
			const result = await connection.request<{ result: { value: T }; exceptionDetails?: unknown }>(
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
		const capture = async (name: string) => {
			const screenshot = await connection.request<{ data: string }>(
				"Page.captureScreenshot",
				{ format: "png" },
				pageSession,
			)
			await fs.writeFile(path.join(directory, `${name}.png`), Buffer.from(screenshot.data, "base64"))
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
				`d.body.classList.contains(${JSON.stringify(themeClass)}) && !!d.querySelector('[data-testid="history-view-all"]')`,
			)
			await check("d.querySelectorAll('[data-testid^=task-item-history-visual-]').length === 5")
			assert.equal(await evaluate("!!d.querySelector('[data-testid=history-search-input]')"), false)
			await capture(`${stage}-preview`)
			await activate("history-view-all")
			await check("!!d.querySelector('[data-testid=history-search-input]')")
			await check("!!d.querySelector('[data-testid=task-item-history-visual-0]')")
			const metrics = await evaluate<PanelMetrics>(
				`(()=>{const s=d.querySelector('[data-testid="history-search-input"]').closest('section');const r=s.getBoundingClientRect();const c=d.querySelector('textarea');return {width:r.width,height:r.height,scrollWidth:s.scrollWidth,clientWidth:s.clientWidth,text:s.innerText,composer:!!c&&c.getBoundingClientRect().height>0}})()`,
			)
			assert.ok(metrics.composer, "Composer remains visible alongside Chats")
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
			`(()=>{const e=d.querySelector('[data-testid="chat-transcript-content"]');return {transcriptCount:Number(e?.dataset.count??0),renderedCount:Number(e?.dataset.renderedCount??0),sentinelVisible:d.body.innerText.includes(${JSON.stringify(navigationReady.sentinel)}),homeVisible:!!d.querySelector('[data-testid="alpha-home-brand"]')}})()`,
		)
		await fs.writeFile(
			path.join(directory, "navigation-ready-dom.json"),
			JSON.stringify(navigationStartState, null, 2),
		)
		await capture("navigation-ready")
		await check(
			`(()=>{const e=d.querySelector('[data-testid="chat-transcript-content"]');return Number(e?.dataset.count)>=${transcriptCount}&&d.body.innerText.includes(${JSON.stringify(navigationReady.sentinel)})})()`,
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
		await check(`!!d.querySelector(${JSON.stringify(taskItemSelector)})`)
		assert.equal(
			await evaluate(
				`(()=>{const e=d.querySelector(${JSON.stringify(taskItemSelector)});e.focus();return d.activeElement===e})()`,
			),
			true,
		)
		await installNavigationProbe(
			`(()=>{const e=d.querySelector('[data-testid="chat-transcript-content"]');return Number(e?.dataset.count)>=${transcriptCount}&&d.body.innerText.includes(${JSON.stringify(navigationReady.sentinel)})})()`,
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
			`(()=>{const e=d.querySelector('[data-testid="chat-transcript-content"]');return {count:Number(e?.dataset.count??0),renderedCount:Number(e?.dataset.renderedCount??0),sentinelVisible:d.body.innerText.includes(${JSON.stringify(navigationReady.sentinel)})}})()`,
		)
		assert.ok(reopenedTranscript.count >= transcriptCount, "Reopened transcript retains all fixture messages")
		assert.ok(reopenedTranscript.renderedCount > 0 && reopenedTranscript.renderedCount <= 100)
		assert.equal(reopenedTranscript.sentinelVisible, true)
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
		await writeJsonAtomically(path.join(directory, "ui-done-navigation-reopen-ready.json"), {
			nonce,
			stage: "navigation-reopen-ready",
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
		const expectedHostVersion = process.env.ALPHA_HISTORY_UI_VSCODE_VERSION ?? "1.122.1"
		const executable =
			process.env.VSCODE_EXECUTABLE_PATH ?? (await downloadAndUnzipVSCode({ version: expectedHostVersion }))
		const output = process.env.ALPHA_HISTORY_UI_OUTPUT ?? path.join(os.tmpdir(), "alpha-code-history-ux")
		console.log(JSON.stringify(await runHistoryUi(executable, output, expectedHostVersion)))
	})().catch((error) => {
		console.error(error)
		process.exitCode = 1
	})
}
