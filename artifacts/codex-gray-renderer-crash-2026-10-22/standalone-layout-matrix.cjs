const { app, BrowserWindow, crashReporter } = require("electron")
const fs = require("node:fs/promises")
const path = require("node:path")
const os = require("node:os")
const { mkdtempSync, mkdirSync } = require("node:fs")
const output = __dirname
const fixture = path.join(output, "selection-layout-repro.html")
const profile = mkdtempSync(path.join(os.tmpdir(), "alpha-native-layout-"))
mkdirSync(path.join(profile, "crash-dumps"))
app.setPath("userData", profile)
app.setPath("crashDumps", path.join(profile, "crash-dumps"))
if (process.argv.includes("--collect-dumps")) crashReporter.start({ uploadToServer: false, rateLimit: false })
const results = []
app.on("window-all-closed", () => {})
async function run(variant) {
	const win = new BrowserWindow({
		width: 900,
		height: 650,
		show: true,
		webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
	})
	let settle
	const outcome = new Promise((resolve) => {
		settle = resolve
	})
	let timer
	win.webContents.once("render-process-gone", (_event, details) => settle({ status: "crashed", ...details }))
	try {
		await win.loadFile(fixture, { query: { case: variant } })
		win.focus()
		win.webContents.focus()
		const before = await win.webContents
			.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
            const rect = document.getElementById("swap").getBoundingClientRect()
            resolve({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
                supported: CSS.supports("animation-timeline", "scroll(self y)"),
                selected: !!getSelection().rangeCount && !getSelection().isCollapsed,
                timeline: getComputedStyle(document.querySelector(".repro-scroller")).animationTimeline,
                animation: getComputedStyle(document.querySelector(".repro-scroller")).animationName,
                rendererPid: undefined })
        })))`)
		before.rendererPid = win.webContents.getOSProcessId()
		timer = setTimeout(() => settle({ status: "timeout" }), 5000)
		if (variant === "script-toggle") {
			void win.webContents.executeJavaScript('document.getElementById("swap").click()').catch(() => {})
		} else {
			for (const type of ["mouseMove", "mouseDown", "mouseUp"]) {
				win.webContents.sendInputEvent({
					type,
					x: Math.round(before.x),
					y: Math.round(before.y),
					button: "left",
					clickCount: 1,
				})
			}
		}
		void win.webContents
			.executeJavaScript(
				`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => resolve({ status: "alive", clicks: window.__nativeLayoutRepro.clicks,
            selected: !!getSelection().rangeCount && !getSelection().isCollapsed,
            displays: [...document.querySelectorAll(".repro-scroller")].map(e => e.style.display) }), 0))))`,
			)
			.then(settle, () => {})
		const result = {
			variant,
			input: variant === "script-toggle" ? "DOM click" : "native mouse",
			before,
			outcome: await outcome,
		}
		results.push(result)
		console.log(JSON.stringify(result))
		if (result.outcome.status === "timeout" || (result.outcome.status === "alive" && result.outcome.clicks !== 1)) {
			throw new Error("Fixture input did not finish")
		}
	} finally {
		clearTimeout(timer)
		win.destroy()
	}
}
app.whenReady()
	.then(async () => {
		for (const variant of ["no-animation", "no-selection", "no-toggle", "normal-timeline", "full", "script-toggle"])
			await run(variant)
		await fs.writeFile(
			path.join(output, "standalone-layout-matrix.json"),
			JSON.stringify(
				{ electron: process.versions.electron, chromium: process.versions.chrome, profile, results },
				null,
				2,
			),
		)
		if (results.slice(0, 4).some((result) => result.outcome.status !== "alive"))
			throw new Error("A control unexpectedly crashed")
		app.quit()
	})
	.catch((error) => {
		console.error(error)
		app.exit(1)
	})
