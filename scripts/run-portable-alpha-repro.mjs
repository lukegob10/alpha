import { execFile as execFileCallback, spawn } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)
const windowGuardScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "portable-alpha-window-guard.ps1")

const sourceDirectory = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../apps/vscode-e2e/portable-automation",
)

function isWithin(candidate, parent) {
	const relative = path.relative(parent, candidate)
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export function parseArguments(args) {
	const values = new Map()
	for (let index = 0; index < args.length; index += 2) {
		const flag = args[index]
		const value = args[index + 1]
		if (
			![
				"--host",
				"--workspace",
				"--alpha-development-path",
				"--artifacts-dir",
				"--run-id",
				"--timeout-ms",
				"--mode",
				"--prompt-file",
				"--protected-writes",
				"--browser-approvals",
			].includes(flag) ||
			!value
		) {
			throw new Error(`Invalid argument: ${flag ?? "missing flag"}`)
		}
		if (values.has(flag)) throw new Error(`Duplicate argument: ${flag}`)
		values.set(flag, value)
	}
	for (const required of ["--host", "--workspace", "--artifacts-dir", "--run-id"]) {
		if (!values.has(required)) throw new Error(`Missing ${required}`)
	}
	const runId = values.get("--run-id")
	if (!/^[a-z0-9-]{1,64}$/.test(runId)) throw new Error("Run ID must use lowercase letters, numbers, and hyphens")
	const timeoutMs = values.has("--timeout-ms") ? Number(values.get("--timeout-ms")) : 900_000
	if (!Number.isInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 1_800_000) {
		throw new Error("Timeout must be 60,000 to 1,800,000 milliseconds")
	}
	const host = values.get("--host")
	const workspace = values.get("--workspace")
	const alphaDevelopmentPath = values.get("--alpha-development-path")
	const artifactsDir = values.get("--artifacts-dir")
	const mode = values.get("--mode") ?? "task"
	if (mode !== "task" && mode !== "probe") throw new Error("Mode must be task or probe")
	const protectedWrites = values.get("--protected-writes") ?? "deny"
	if (protectedWrites !== "allow" && protectedWrites !== "deny") {
		throw new Error("Protected writes must be allow or deny")
	}
	const browserApprovals = values.get("--browser-approvals") ?? "deny"
	if (browserApprovals !== "allow" && browserApprovals !== "deny") {
		throw new Error("Browser approvals must be allow or deny")
	}
	const promptFile = values.get("--prompt-file")
	if (promptFile && !path.isAbsolute(promptFile)) throw new Error("Prompt file must be an absolute path")
	if (
		![host, workspace, artifactsDir, ...(alphaDevelopmentPath ? [alphaDevelopmentPath] : [])].every(path.isAbsolute)
	) {
		throw new Error("Host, workspace, artifacts, and optional Alpha development paths must be absolute")
	}
	return {
		host,
		workspace,
		alphaDevelopmentPath,
		artifactsDir,
		runId,
		timeoutMs,
		mode,
		promptFile,
		allowProtectedWrites: protectedWrites === "allow",
		allowBrowserOpen: browserApprovals === "allow",
	}
}

export async function prepareRun(options) {
	const host = await fs.realpath(options.host)
	if (path.basename(host).toLowerCase() !== "code.exe") throw new Error("Host must be the portable Code.exe")
	const portableData = path.join(path.dirname(host), "data")
	if (!(await fs.stat(portableData)).isDirectory()) throw new Error("Portable VS Code data directory is missing")
	const workspace = await fs.realpath(options.workspace)
	if (!(await fs.stat(workspace)).isDirectory()) throw new Error("Workspace is not a directory")
	let alphaDevelopmentPath
	if (options.alphaDevelopmentPath) {
		alphaDevelopmentPath = await fs.realpath(options.alphaDevelopmentPath)
		if (!(await fs.stat(alphaDevelopmentPath)).isDirectory())
			throw new Error("Alpha development path is not a directory")
		const manifest = JSON.parse(await fs.readFile(path.join(alphaDevelopmentPath, "package.json"), "utf8"))
		if (`${manifest.publisher}.${manifest.name}`.toLowerCase() !== "alphainc.alpha") {
			throw new Error("Alpha development path is not an Alpha Code extension")
		}
		if (!(await fs.stat(path.join(alphaDevelopmentPath, "dist", "extension.js"))).isFile()) {
			throw new Error("Alpha development bundle is missing")
		}
	}
	let promptFile
	if (options.mode !== "probe") {
		promptFile = await fs.realpath(options.promptFile ?? path.join(workspace, "SPEC.md"))
		if (!(await fs.stat(promptFile)).isFile()) throw new Error("Task prompt is not a file")
	}
	await fs.mkdir(options.artifactsDir, { recursive: true })
	const artifactsDir = await fs.realpath(options.artifactsDir)
	for (const protectedPath of [path.dirname(host), workspace, path.resolve(sourceDirectory, "../../..")]) {
		if (isWithin(artifactsDir, protectedPath) || isWithin(protectedPath, artifactsDir)) {
			throw new Error("Artifacts directory must be separate from the host, workspace, and repository")
		}
	}
	const runDirectory = path.join(artifactsDir, options.runId)
	await fs.mkdir(runDirectory)
	const sidecar = path.join(runDirectory, "sidecar")
	await fs.mkdir(sidecar)
	await Promise.all(
		["package.json", "extension.js"].map((name) =>
			fs.copyFile(path.join(sourceDirectory, name), path.join(sidecar, name)),
		),
	)
	await fs.writeFile(
		path.join(sidecar, "run.json"),
		JSON.stringify(
			{
				workspace,
				mode: options.mode ?? "task",
				runId: options.runId,
				timeoutMs: options.timeoutMs,
				promptFile,
				allowProtectedWrites: options.allowProtectedWrites === true,
				allowBrowserOpen: options.allowBrowserOpen === true,
			},
			null,
			2,
		) + "\n",
		{ flag: "wx" },
	)
	return { host, workspace, alphaDevelopmentPath, runDirectory, sidecar }
}

async function guardPortableWindow(mode, prepared, result) {
	const { stdout } = await execFile(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			windowGuardScript,
			"-Mode",
			mode,
			"-HostPath",
			prepared.host,
			"-SnapshotPath",
			path.join(prepared.runDirectory, "baseline-windows.json"),
			"-AllowDiscard",
			(result?.workspaceAddedByAutomation === true || result?.workspaceIsUntitled === true) &&
			result?.dirtyEditorsAtFinish === 0
				? "true"
				: "false",
		],
		{ windowsHide: true, timeout: 20_000 },
	)
	return JSON.parse(stdout.trim())
}

export async function runPortableRepro(options, dependencies = {}) {
	const prepared = await prepareRun(options)
	const windowGuard =
		dependencies.windowGuard ??
		(process.platform === "win32" && !dependencies.launch ? guardPortableWindow : undefined)
	if (windowGuard) await windowGuard("snapshot", prepared)
	const launch =
		dependencies.launch ?? ((executable, args) => spawn(executable, args, { stdio: "ignore", windowsHide: false }))
	const child = launch(prepared.host, [
		`--folder-uri=${pathToFileURL(prepared.workspace).href}`,
		"--new-window",
		...(prepared.alphaDevelopmentPath ? [`--extensionDevelopmentPath=${prepared.alphaDevelopmentPath}`] : []),
		`--extensionDevelopmentPath=${prepared.sidecar}`,
	])
	let launchError
	child?.on?.("error", (error) => {
		launchError = error
	})
	child?.unref?.()
	const receipt = path.join(
		prepared.sidecar,
		`${options.runId}-${options.mode === "probe" ? "probe-result" : "task-result"}.json`,
	)
	const deadline = Date.now() + options.timeoutMs + 30_000
	while (Date.now() < deadline) {
		if (launchError) throw launchError
		try {
			const result = JSON.parse(await fs.readFile(receipt, "utf8"))
			if (result.runId !== options.runId || result.hostVersion !== "1.125.0") {
				throw new Error("Automation receipt identity does not match the requested run")
			}
			const windowCleanup = windowGuard ? await windowGuard("close", prepared, result) : undefined
			if (windowCleanup) {
				await fs.writeFile(
					path.join(prepared.runDirectory, "window-cleanup.json"),
					JSON.stringify({ at: new Date().toISOString(), ...windowCleanup }, null, 2) + "\n",
					{ flag: "wx" },
				)
			}
			return { result, receipt, runDirectory: prepared.runDirectory, windowCleanup }
		} catch (error) {
			if (error?.code !== "ENOENT") throw error
		}
		await (dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(500)
	}
	throw new Error(`The portable Alpha run timed out; inspect ${prepared.runDirectory}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const options = parseArguments(process.argv.slice(2))
		const { result, receipt, windowCleanup } = await runPortableRepro(options)
		console.log(
			JSON.stringify({
				status: result.status ?? result.stage,
				taskId: result.taskId,
				receipt,
				navigationMs: result.navigationMs,
				windowCleanup,
			}),
		)
		if (options.mode === "probe" ? result.stage !== "ready" : result.status !== "completed") process.exitCode = 1
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
	}
}
