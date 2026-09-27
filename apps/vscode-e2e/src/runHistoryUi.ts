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

type HistoryUiHost = Pick<
	ExtensionTestRunResult,
	"status" | "execution" | "ownershipGate" | "captureComplete" | "hostExitObserved" | "actualVSCodeVersion"
>

export async function completeHistoryUiRun<T extends HistoryUiHost>(
	host: T,
	directory: string,
	output: string,
	runId: string,
) {
	const savedDirectory = path.join(output, runId)
	await fs.cp(directory, savedDirectory, { recursive: true })
	if (
		host.status !== "passed" ||
		host.execution !== "extension-host" ||
		host.ownershipGate !== "verified" ||
		host.captureComplete !== true ||
		host.hostExitObserved !== true ||
		host.actualVSCodeVersion !== "1.122.1"
	)
		throw new Error(`History UI host validation failed; inspect retained evidence in ${savedDirectory}`)
	return { status: "passed" as const, directory: savedDirectory, host }
}

/** Exercises the built extension in an isolated exact-host profile, with trusted renderer input. */
export async function runHistoryUi(executable: string, output: string) {
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
		vscodeVersion: "1.122.1",
		vscodeExecutablePath: executable,
		testFile: "history-ui.test",
		rendererDebuggingPort: 0,
		runId,
		profileDir: path.join(root, "profile"),
		workspace: path.join(root, "workspace"),
		artifactsDir: evidenceRoot,
		initializeProfile: true,
		retainEvidenceForCampaign: true,
		extensionTestsEnv: { ALPHA_UI_ACCEPTANCE_NONCE: nonce },
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
							assert.equal(receipt.version, "1.122.1")
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
			await fs.readFile(path.join(root, "profile", "1.122.1", "user-data", "DevToolsActivePort"), "utf8")
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
		await check(
			"!!d.querySelector('[data-testid=history-view-all]') && d.querySelectorAll('[data-testid^=task-item-history-visual-]').length === 3",
		)
		assert.equal(await evaluate("!!d.querySelector('[data-testid=history-search-input]')"), false)
		const smallHeight = await evaluate<number>(
			"d.querySelector('[data-testid=history-view-all]').closest('section').getBoundingClientRect().height",
		)
		assert.ok(smallHeight < 160, `Three-row preview must fit its content, observed ${smallHeight}px`)
		await capture("chats-small-preview")
		await activate("history-view-all")
		await check("!!d.querySelector('[data-testid=history-search-input]')")
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
		const host = await running
		return completeHistoryUiRun(host, directory, output, runId)
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
		const executable = process.env.VSCODE_EXECUTABLE_PATH ?? (await downloadAndUnzipVSCode({ version: "1.122.1" }))
		console.log(
			JSON.stringify(await runHistoryUi(executable, path.resolve(__dirname, "../../../artifacts/history-ux"))),
		)
	})().catch((error) => {
		console.error(error)
		process.exitCode = 1
	})
}
