import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { downloadAndUnzipVSCode } from "@vscode/test-electron"
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
			host.actualVSCodeVersion === "1.125.0" &&
			host.exitCode === 0,
		"Tickets renderer requires a passing, verified, complete VS Code 1.125.0 host result",
	)
}

interface TicketFixture {
	name: string
	type: "bug" | "feature" | "improvement" | "testing" | "performance" | "ux"
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
]

function ticketMarkdown(fixture: TicketFixture, id: string, reference: string, date: string): string {
	return [
		"---",
		"schemaVersion: 1",
		`id: ${JSON.stringify(id)}`,
		`reference: ${reference}`,
		`name: ${JSON.stringify(fixture.name)}`,
		`type: ${fixture.type}`,
		...(fixture.priority ? [`priority: ${fixture.priority}`] : []),
		`createdAt: ${JSON.stringify(date)}`,
		`updatedAt: ${JSON.stringify(date)}`,
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
		vscodeVersion: "1.125.0",
		initializeProfile: true,
	})
	const fixtureFiles = await seedTicketStore(profile.workspace, isolatedHome)
	const abort = new AbortController()
	const timer = setTimeout(() => abort.abort(), 240_000)
	let hostSettled = false
	const running = runExtensionTests({
		providerMode: "scripted",
		vscodeVersion: "1.125.0",
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
							assert.equal(receipt.version, "1.125.0")
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
		const changeProperty = async (id: string, key: string, value: string) => {
			await evaluate(`d.getElementById(${JSON.stringify(id)}).focus()`)
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
				`d.getElementById(${JSON.stringify(id)})?.value === ${JSON.stringify(value)} && !d.getElementById(${JSON.stringify(id)})?.disabled`,
				`${id}_saved`,
			)
			await check(`d.activeElement?.id === ${JSON.stringify(id)}`, `${id}_focus_restored`)
			await check("!d.querySelector('.tickets-notice')", `${id}_no_self_change_notice`)
		}
		const requiredTypes = ["bug", "feature", "improvement", "performance", "testing", "ux"]
		for (const [stage, themeClass] of [
			["tickets-dark", "vscode-dark"],
			["tickets-light", "vscode-light"],
			["tickets-contrast", "vscode-high-contrast"],
		] as const) {
			if (stage !== "tickets-dark") await ready(stage)
			await check(
				`d.body.classList.contains(${JSON.stringify(themeClass)}) && !!d.querySelector('.tickets-list') && d.querySelectorAll('.ticket-row-open').length === 6`,
				`${stage}_list`,
			)
			for (const fixture of fixtures) {
				assert.equal(
					await evaluate(
						`(()=>{const row=[...d.querySelectorAll('.ticket-row')].find(r=>r.querySelector('.ticket-row-name')?.textContent===${JSON.stringify(fixture.name)}); const r=row?.getBoundingClientRect(); return !!row && row.dataset.status===${JSON.stringify(fixture.status)} && row.closest('tbody')?.id===${JSON.stringify(`ticket-group-rows-${fixture.status}`)} && row.checkVisibility() && r.width>0 && r.height>0})()`,
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
			assert.equal(listMetrics.priorities, 5)
			assert.equal(listMetrics.noPriority, 1)
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
				assert.deepEqual(inlinePriority, { visible: 6, assigned: 5 }, "Narrow rows show every ticket priority")
			}
			await fs.writeFile(path.join(directory, `${stage}-metrics.json`), JSON.stringify(listMetrics, null, 2))
			await capture(`${stage}-list`)

			const selectedName = fixtures[0]!.name
			assert.equal(
				await evaluate(
					`(()=>{const e=[...d.querySelectorAll('.ticket-row-open')].find(b=>b.innerText.includes(${JSON.stringify(selectedName)}));if(!e)return false;e.focus();return d.activeElement===e})()`,
				),
				true,
				"Seeded ticket identity is keyboard focusable",
			)
			await pressEnter()
			await check(
				`d.querySelector('#ticket-heading')?.textContent?.trim() === ${JSON.stringify(selectedName)}`,
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
					`([...d.querySelectorAll('.ticket-row-open')].find(b=>b.innerText.includes(${JSON.stringify(selectedName)}))).focus()`,
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
				"!!d.querySelector('.tickets-list') && d.querySelectorAll('.ticket-row-open').length === 6",
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
		const executable = process.env.VSCODE_EXECUTABLE_PATH ?? (await downloadAndUnzipVSCode({ version: "1.125.0" }))
		console.log(
			JSON.stringify(await runTicketsUi(executable, path.resolve(__dirname, "../../../artifacts/tickets-ui"))),
		)
	})().catch((error) => {
		console.error(error)
		process.exitCode = 1
	})
}
