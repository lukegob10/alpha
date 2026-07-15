import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const full = process.argv.includes("--full")
const skipPrivate = process.argv.includes("--skip-private")
const pnpm = resolvePnpmExecutable()

const providerSecrets = [
	"ANTHROPIC_API_KEY",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"DEEPSEEK_API_KEY",
	"GOOGLE_API_KEY",
	"MISTRAL_API_KEY",
	"OPENAI_API_KEY",
	"OPENROUTER_API_KEY",
	"VERCEL_AI_GATEWAY_API_KEY",
]

const childEnvironment = {
	...process.env,
	CI: "true",
	EVALS_OFFLINE_CERTIFICATION: "1",
}
for (const name of providerSecrets) delete childEnvironment[name]

const agentCriticalTests = [
	"__tests__/history-resume-delegation.spec.ts",
	"__tests__/nested-delegation-resume.spec.ts",
	"api/providers/__tests__/base-openai-compatible-provider-timeout.spec.ts",
	"api/providers/__tests__/openai-native-usage.spec.ts",
	"core/agent/__tests__/ToolPolicy.spec.ts",
	"core/agent/__tests__/ToolScheduler.spec.ts",
	"core/context-management/__tests__/context-management.spec.ts",
	"core/context-management/__tests__/truncation.spec.ts",
	"core/task/__tests__/flushPendingToolResultsToHistory.spec.ts",
	"core/task/__tests__/validateToolResultIds.spec.ts",
	"core/task/__tests__/WorkspaceMutationGate.spec.ts",
	"core/webview/__tests__/ClineProvider.flicker-free-cancel.spec.ts",
]

const settingsTests = [
	"src/components/settings/__tests__/SettingsView.change-detection.spec.tsx",
	"src/components/settings/__tests__/SettingsView.spec.tsx",
	"src/components/settings/__tests__/SettingsView.unsaved-changes.spec.tsx",
]

const phases = full
	? [
			phase("Workspace lint", pnpm, ["lint"]),
			phase("Workspace type-check", pnpm, ["check-types"]),
			phase("Workspace unit tests", pnpm, ["test"]),
		]
	: [
			phase("Agent-critical extension tests", pnpm, [
				"--filter",
				"alpha",
				"exec",
				"vitest",
				"run",
				...agentCriticalTests,
			]),
			phase("CLI cancellation tests", pnpm, [
				"--filter",
				"@alpha-code/cli",
				"exec",
				"vitest",
				"run",
				"src/commands/cli/__tests__/cancellation.test.ts",
			]),
			phase("Settings buffering tests", pnpm, [
				"--filter",
				"@alpha-code/vscode-webview",
				"exec",
				"vitest",
				"run",
				...settingsTests,
			]),
		]

phases.push(
	phase("Eval harness unit tests", pnpm, ["--filter", "@alpha-code/evals", "test:unit"]),
	phase("Eval harness contract tests", pnpm, ["--filter", "@alpha-code/evals", "test:contract"]),
	phase("Eval harness golden certification", pnpm, ["--filter", "@alpha-code/evals", "test:certification"]),
	phase("Eval harness infrastructure tests", pnpm, ["--filter", "@alpha-code/evals", "test:infrastructure"]),
	phase("Benchmark manifest validation", pnpm, ["--filter", "@alpha-code/evals", "benchmark:validate"]),
	phase("Benchmark initial-state certification", pnpm, ["--filter", "@alpha-code/evals", "benchmark:fixture-check"]),
)

const privateRoot = process.env.EVALS_PRIVATE_BENCHMARK_ROOT
const privateFingerprints = privateRoot && path.join(privateRoot, "reports", "private-authoring-fingerprints.json")
const authoringArgs = ["--filter", "@alpha-code/evals", "benchmark:author-check"]
if (privateFingerprints && existsSync(privateFingerprints)) {
	authoringArgs.push("--", "--private-fingerprints", privateFingerprints)
}
phases.push(phase("Benchmark diversity and authoring checks", pnpm, authoringArgs))

if (!skipPrivate && privateRoot && existsSync(path.join(privateRoot, "package.json"))) {
	phases.push(phase("Private benchmark model-free admission", pnpm, ["--dir", privateRoot, "test"]))
}

const startedAt = Date.now()
for (const item of phases) run(item)
const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1)
console.log(`\nOffline certification passed (${phases.length} phases, ${elapsedSeconds}s, no provider credentials).`)

function phase(label, command, args, cwd = repositoryRoot) {
	return { label, command, args, cwd }
}

function resolvePnpmExecutable() {
	if (process.platform !== "win32") return "pnpm"
	const home = process.env.PNPM_HOME
	if (!home) throw new Error("PNPM_HOME is required for structured pnpm execution on Windows")
	const versionsRoot = path.join(home, ".tools", "pnpm-exe")
	const executable = readdirSync(versionsRoot)
		.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
		.map((version) => path.join(versionsRoot, version, "pnpm.exe"))
		.find(existsSync)
	if (!executable) throw new Error(`Unable to locate pnpm.exe below ${versionsRoot}`)
	return executable
}

function run(item) {
	console.log(`\n==> ${item.label}`)
	const result = spawnSync(item.command, item.args, {
		cwd: item.cwd,
		env: childEnvironment,
		stdio: "inherit",
		shell: false,
	})
	if (result.error) throw result.error
	if (result.status !== 0) {
		console.error(`\nOffline certification stopped at: ${item.label}`)
		process.exit(result.status ?? 1)
	}
}
