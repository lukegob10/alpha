// This catalog selects existing owners; it does not implement tests or grading.
import { readFileSync } from "node:fs"
import { hostVsixTarget } from "../../src/lancedb-native.mjs"

export const lanes = {
	static: {
		exclusiveBuild: true,
		fidelity: "static",
		decisions: "none",
		owner: "workspace",
		proves: "Lint and affected extension/webview/host-runner type contracts",
		commands: [["lint"], ["check-types"]],
	},
	unit: {
		exclusiveBuild: true,
		fidelity: "unit/component and scripted integration",
		decisions: "scripted",
		owner: "src, packages, webview-ui",
		proves: "Extension dependency and UI contracts; includes bundle prerequisite",
		commands: [
			["bundle"],
			...[
				"packages/types",
				"packages/core",
				"packages/ipc",
				"packages/telemetry",
				"packages/build",
				"webview-ui",
				"src",
			].map((directory) => ["--dir", directory, "test"]),
		],
		// Ordinary workspace units retain their declared skips, recorded in each
		// receipt. Hard acceptance lanes below continue to require every test.
		receipts: [
			null,
			...[
				"packages/types",
				"packages/core",
				"packages/ipc",
				"packages/telemetry",
				"packages/build",
				"webview-ui",
				"src",
			].map((directory) => ({ runner: "vitest", packageDir: directory })),
		],
	},
	focused: {
		fidelity: "unit/component and scripted integration",
		decisions: "scripted",
		owner: "src",
		proves: "Selected extension Vitest contracts only",
		acceptsFilters: true,
		commands: [["--dir", "src", "test", "--maxWorkers=2"]],
	},
	tooling: {
		exclusiveBuild: true,
		fidelity: "runner unit",
		decisions: "scripted",
		owner: "scripts, apps/vscode-e2e",
		proves: "Local tooling and host runner mechanics without starting VS Code",
		commands: [
			["--filter", "@alpha-code/types", "build"],
			["test:tooling"],
			["--filter", "@alpha-code/vscode-e2e", "test:unit"],
		],
		receipts: [null, { runner: "node", requireAllTests: true }, { runner: "node" }],
	},
	offline: {
		exclusiveBuild: true,
		fidelity: "evaluator unit/contract/certification",
		decisions: "scripted",
		owner: "packages/evals",
		proves: "Evaluator and grader contracts without Postgres, Redis, Docker or provider requests",
		commands: [
			["--filter", "@alpha-code/types", "build"],
			["--filter", "@alpha-code/evals", "test:unit"],
			["--filter", "@alpha-code/evals", "test:contract"],
			["--filter", "@alpha-code/evals", "test:certification"],
		],
		receipts: [
			null,
			...["unit", "contract", "certification"].map((config) => ({
				runner: "vitest",
				requireAllTests: true,
				config,
			})),
		],
	},
	host: {
		exclusiveBuild: true,
		fidelity: "actual VS Code 1.138.0",
		decisions: "scripted / LM fixture",
		owner: "apps/vscode-e2e",
		proves: "Activation, modes and VS Code LM host contracts; not all UI acceptance",
		prerequisites: ["VS Code 1.138.0 binary/download access and desktop host support"],
		commands: [["--filter", "@alpha-code/vscode-e2e", "test:smoke:1380"]],
		receipts: [{ runner: "extension-host", suite: "smoke" }],
	},
	extended: {
		exclusiveBuild: true,
		fidelity: "actual VS Code 1.138.0",
		decisions: "scripted",
		owner: "apps/vscode-e2e",
		proves: "Instruction discovery, HTML previews, offline storage recovery and scheduled-task host contracts",
		prerequisites: ["VS Code 1.138.0 binary/download access and desktop host support"],
		commands: [["--filter", "@alpha-code/vscode-e2e", "test:extended:1380"]],
		receipts: [{ runner: "extension-host", suite: "extended" }],
	},
	rendered: {
		exclusiveBuild: true,
		fidelity: "actual VS Code 1.138.0 renderer and extension host",
		decisions: "scripted",
		owner: "apps/vscode-e2e rendered drivers",
		proves: "Bounded composer, transcript, question-input and managed approval/settings interactions; not all UI coverage",
		prerequisites: ["VS Code 1.138.0 binary/download access, desktop and local CDP loopback support"],
		commands: [["bundle"], ["--filter", "@alpha-code/vscode-e2e", "test:rendered:1380:run"]],
		receipts: [null, { runner: "extension-host", suite: "rendered" }],
	},
	stress: {
		exclusiveBuild: true,
		fidelity: "actual VS Code 1.138.0 extension host",
		decisions: "scripted",
		owner: "apps/vscode-e2e managed lifecycle acceptance",
		proves: "Bounded managed stream/process cancellation and budget/explicit-stop contracts; not the full stress bank",
		prerequisites: ["VS Code 1.138.0 binary/download access and desktop host support"],
		commands: [["bundle"], ["--filter", "@alpha-code/vscode-e2e", "compile"], ["harness:stress"]],
		receipts: [null, null, { runner: "extension-host", suite: "stress" }],
	},
	confidence: {
		exclusiveBuild: true,
		fidelity: "scripted integration and actual host",
		decisions: "scripted",
		owner: "apps/vscode-e2e, certification",
		proves: "Existing core confidence gate, including strict managed-agent evidence",
		prerequisites: ["VS Code 1.138.0 binary/download access and desktop host support"],
		commands: [["--filter", "@alpha-code/types", "build"], ["test:core:confidence"]],
		receipts: [null, { runner: "extension-host", suite: "confidence" }],
	},
	outcomes: {
		exclusiveBuild: true,
		fidelity: "actual VS Code 1.138.0 with independent repository outcome assertions",
		decisions: "scripted",
		owner: "apps/vscode-e2e existing smoke campaign",
		proves: "Three deterministic extension task outcomes: git inspection, repository bootstrap, and edit/test/commit/follow-up",
		prerequisites: ["VS Code 1.138.0 binary/download access and desktop host support"],
		commands: [
			["bundle"],
			[
				"--filter",
				"@alpha-code/vscode-e2e",
				"test:campaign",
				"--suite",
				"smoke",
				"--provider",
				"scripted",
				"--vscode-version",
				"1.138.0",
				"--samples",
				"1",
			],
		],
		receipts: [null, { runner: "task-outcomes" }],
	},
	services: {
		exclusiveBuild: true,
		fidelity: "service integration",
		decisions: "scripted",
		owner: "packages/evals",
		proves: "Database and Redis contracts without Docker",
		prerequisites: [
			"Dedicated configured test Postgres and Redis; never point destructive tests at shared application data",
		],
		commands: [
			["--filter", "@alpha-code/types", "build"],
			["--filter", "@alpha-code/evals", "services:check"],
			["--filter", "@alpha-code/evals", "test:integration"],
			["--filter", "@alpha-code/evals", "test:redis"],
		],
		receipts: [
			null,
			null,
			{ runner: "vitest", requireAllTests: true, config: "integration" },
			{ runner: "vitest", requireAllTests: true, config: "services" },
		],
	},
	infrastructure: {
		fidelity: "optional container infrastructure",
		decisions: "scripted",
		owner: "packages/evals",
		proves: "Docker adapter isolation and cleanup contracts; outside the Docker-free corporate workflow",
		prerequisites: ["Docker engine and approved test images"],
		commands: [["test:evals:infrastructure"]],
		receipts: [{ runner: "vitest", requireAllTests: true, config: "infrastructure" }],
	},
	mechanical: {
		exclusiveBuild: true,
		fidelity: "static unused-file and evaluator type analysis",
		decisions: "none",
		owner: "workspace",
		proves: "Existing Knip unused-file and evaluator lint/type checks; does not remove files",
		commands: [
			["knip"],
			["--filter", "@alpha-code/evals", "lint"],
			["--filter", "@alpha-code/evals", "check-types"],
		],
		receipts: [null, null, null],
	},
	admission: {
		exclusiveBuild: true,
		fidelity: "existing offline benchmark manifest, fixture and authoring admission",
		decisions: "scripted",
		owner: "packages/evals benchmark CLI",
		proves: "Real catalog, intentional initial fixture outcomes and corpus authoring validation; no provider tasks",
		commands: [
			["--filter", "@alpha-code/evals", "benchmark:validate"],
			["--filter", "@alpha-code/evals", "benchmark:fixture-check"],
			["--filter", "@alpha-code/evals", "benchmark:author-check"],
		],
		receipts: [null, null, null],
	},
	managed: {
		exclusiveBuild: true,
		fidelity: "deterministic certification and actual VS Code 1.138.0",
		decisions: "scripted",
		owner: "managed-agent certification and apps/vscode-e2e",
		proves: "Strict managed-agent automated gate, including non-Git and auto-apply host contracts",
		prerequisites: ["VS Code 1.138.0 binary/download access and desktop host support"],
		commands: [["certify:managed-agents:automated"]],
		receipts: [{ runner: "extension-host", suite: "managed" }],
	},
	minimum: {
		exclusiveBuild: true,
		fidelity: "actual VS Code 1.125.0 minimum host",
		decisions: "scripted / LM fixture",
		owner: "apps/vscode-e2e",
		proves: "Minimum-host activation, modes, recovery and VS Code LM compatibility",
		prerequisites: ["VS Code 1.125.0 binary/download access and desktop host support"],
		commands: [["--filter", "@alpha-code/vscode-e2e", "test:compatibility:1250"]],
		receipts: [{ runner: "extension-host", suite: "minimum" }],
	},
	performance: {
		exclusiveBuild: true,
		fidelity: "deterministic operation-count and component fixtures",
		decisions: "scripted",
		owner: "src and webview-ui",
		proves: "Selected discovery, startup, persistence, skills and UI operation bounds; not live latency",
		commands: [
			[
				"--dir",
				"src",
				"test",
				"--maxWorkers=2",
				"services/glob/__tests__/list-files-discovery.benchmark.spec.ts",
				"core/webview/__tests__/AlphaProvider.performance.spec.ts",
				"core/task/__tests__/Task.request-preflight-performance.spec.ts",
				"core/task-persistence/__tests__/TaskHistoryStore.workspace-performance.spec.ts",
				"services/skills/__tests__/SkillsManager.spec.ts",
				"core/prompts/sections/__tests__/skills.catalog-budget.spec.ts",
			],
			[
				"--dir",
				"webview-ui",
				"test",
				"--maxWorkers=2",
				"src/components/chat/__tests__/ChatView.transcript-performance.spec.tsx",
				"src/components/chat/__tests__/ChatTextArea.typing-performance.spec.tsx",
				"src/components/tickets/__tests__/TicketReader.performance.spec.tsx",
			],
		],
		receipts: [
			{ runner: "vitest", packageDir: "src", requireAllTests: true },
			{ runner: "vitest", packageDir: "webview-ui", requireAllTests: true },
		],
	},
	benchmarks: {
		exclusiveBuild: true,
		fidelity: "fixed offline production-import workloads",
		decisions: "none",
		owner: "existing StepContext and subagent context capture benchmarks",
		proves: "Retained fixed-workload samples and none-fork transcript-read bounds; timings are diagnostic",
		commands: [
			["--filter", "@alpha-code/types", "build"],
			["exec", "node", "scripts/harness/audit-benchmarks.mjs"],
		],
		receipts: [null, { runner: "benchmark" }],
	},
	packaging: {
		exclusiveBuild: true,
		fidelity: "host-target extension package inspection",
		decisions: "none",
		owner: "existing bundle, VSIX and verify-vsix-contents owners",
		proves: "Builds the host-target VSIX and verifies its retained contents",
		commands: [["bundle"], ["vsix"], ["exec", "node", "scripts/verify-vsix-contents.mjs", "<host-vsix>"]],
		receipts: [null, null, null],
	},
}

export function selectLane(name, filters = []) {
	if (!Object.hasOwn(lanes, name)) throw new Error(`Unknown lane: ${name}. Use pnpm harness list.`)
	const lane = lanes[name]
	if (filters.length && !lane.acceptsFilters) throw new Error(`${name} does not accept filters`)
	if (lane.acceptsFilters && (!filters.length || filters.some((value) => value.startsWith("-")))) {
		throw new Error("focused requires one or more test paths, not runner options")
	}
	const commands = lane.commands.map((args) => [...args, ...filters])
	if (name === "packaging") {
		const manifest = JSON.parse(readFileSync(new URL("../../src/package.json", import.meta.url), "utf8"))
		if (!/^[a-z0-9-]+$/.test(manifest.name) || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version))
			throw new Error("Invalid extension package identity")
		commands[2][3] = `bin/${manifest.name}-${manifest.version}-${hostVsixTarget()}.vsix`
	}
	return { ...lane, commands }
}
