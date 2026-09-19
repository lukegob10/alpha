// This catalog selects existing owners; it does not implement tests or grading.
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
		commands: [["test", "--env-mode=loose"]],
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
	},
	offline: {
		exclusiveBuild: true,
		fidelity: "evaluator unit/contract/certification",
		decisions: "scripted",
		owner: "packages/evals",
		proves: "Evaluator and grader contracts without Postgres, Redis, Docker or provider requests",
		commands: [["--filter", "@alpha-code/types", "build"], ["test:evals:offline"]],
	},
	host: {
		exclusiveBuild: true,
		fidelity: "actual VS Code 1.122.1",
		decisions: "scripted / LM fixture",
		owner: "apps/vscode-e2e",
		proves: "Activation, modes and VS Code LM host contracts; not all UI acceptance",
		prerequisites: ["VS Code 1.122.1 binary/download access and desktop host support"],
		commands: [["--filter", "@alpha-code/vscode-e2e", "test:smoke:1221"]],
	},
	confidence: {
		exclusiveBuild: true,
		fidelity: "scripted integration and actual host",
		decisions: "scripted",
		owner: "apps/vscode-e2e, certification",
		proves: "Existing core confidence gate, including strict managed-agent evidence",
		prerequisites: ["VS Code 1.122.1 binary/download access and desktop host support"],
		commands: [["--filter", "@alpha-code/types", "build"], ["test:core:confidence"]],
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
		commands: [["--filter", "@alpha-code/types", "build"], ["test:evals:services"]],
	},
	infrastructure: {
		fidelity: "optional container infrastructure",
		decisions: "scripted",
		owner: "packages/evals",
		proves: "Docker adapter isolation and cleanup contracts; outside the Docker-free corporate workflow",
		prerequisites: ["Docker engine and approved test images"],
		commands: [["test:evals:infrastructure"]],
	},
}

export function selectLane(name, filters = []) {
	if (!Object.hasOwn(lanes, name)) throw new Error(`Unknown lane: ${name}. Use pnpm harness list.`)
	const lane = lanes[name]
	if (filters.length && !lane.acceptsFilters) throw new Error(`${name} does not accept filters`)
	if (lane.acceptsFilters && (!filters.length || filters.some((value) => value.startsWith("-")))) {
		throw new Error("focused requires one or more test paths, not runner options")
	}
	return { ...lane, commands: lane.commands.map((args) => [...args, ...filters]) }
}
