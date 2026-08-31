import { classifyPlanCommand, isPlanCommandAllowed, isPlanCommandCwdAllowed } from "../plan-command"

describe("strict Plan command policy", () => {
	it.each([
		["git --no-pager status --short", "inspection"],
		["git --no-pager rev-parse --show-toplevel", "inspection"],
		["git --no-pager diff --no-ext-diff --no-textconv --stat", "inspection"],
		["pnpm --dir src exec vitest run shared/__tests__/plan-mode.spec.ts", "verification"],
		["pnpm exec tsc --noEmit", "verification"],
		["prettier --check src", "verification"],
		["python -m pytest tests", "verification"],
		["cargo check", "verification"],
	] as const)("allows one bounded %s command", (command, category) => {
		expect(classifyPlanCommand(command)).toEqual({ allowed: true, category })
	})

	it.each([
		"git status --short",
		"git --no-pager diff --stat",
		"git --no-pager diff --no-ext-diff --no-textconv --ext-diff",
		"git --no-pager grep -Osh secret",
		"git --no-pager grep -O sh secret",
		"git checkout main",
		"pnpm install",
		"pnpm run build",
		"pnpm exec vitest --watch",
		"vitest run --coverage",
		"eslint --fix .",
		"eslint --fi\\x .",
		"eslint -o report.txt .",
		"go test -o binary ./pkg",
		"go test -c ./pkg",
		"go test -coverprofile=coverage.out ./...",
		"go test -cpuprofile=cpu.out ./pkg",
		"go test -memprofile plan.out ./pkg",
		"go test -outputdir=plan-output ./pkg",
		"go test -trace plan.trace ./pkg",
		"go test -test.mutexprofile=mutex.out ./pkg",
		"pytest --junitxml=report.xml",
		"pytest --basetemp=.pytest-temp",
		"pytest --cache-clear",
		"pytest --cache-dir=.cache",
		"pytest -c pytest-other.ini",
		"pytest -p arbitrary_plugin",
		"vitest run --config alternate.config.ts",
		"jest --testResultsProcessor custom-processor.js",
		"eslint --parser custom-parser .",
		"eslint --format custom-formatter .",
		"vitest run --reporter custom-reporter",
		"tsc --noEmit --incremental",
		"tsc --noEmit --tsBuildInfoFile plan.tsbuildinfo",
		"tsc --noEmit --generateCpuProfile plan.cpuprofile",
		"tsc -b --noEmit",
		"cargo check --target-dir plan-output",
		"go test -exec wrapper ./pkg",
		"go test -vettool custom-vet ./pkg",
		"pytest -- --write-fixture",
		"tsc",
		"prettier --write src",
		"rm -rf build",
		"git --no-pager status && rm file",
		"git --no-pager status > status.txt",
		"echo $(touch file)",
		"echo `touch file`",
		"echo %PATH%",
		"echo $HOME",
		"vitest run\nrm file",
		"C:\\tools\\eslint.exe .",
	] as const)("fails closed for %s", (command) => {
		expect(isPlanCommandAllowed(command)).toBe(false)
	})

	it("rejects malformed quoting and excessively long input", () => {
		expect(isPlanCommandAllowed('eslint "src')).toBe(false)
		expect(isPlanCommandAllowed(`eslint ${"a".repeat(4_100)}`)).toBe(false)
	})

	it.each([undefined, null, "", ".", "src", "src/core"])("allows contained Plan cwd %j", (cwd) => {
		expect(isPlanCommandCwdAllowed(cwd)).toBe(true)
	})

	it.each(["/tmp", "C:/outside", "..", "../outside", "src/../../outside", "~/repo"])(
		"rejects escaping Plan cwd %s",
		(cwd) => {
			expect(isPlanCommandCwdAllowed(cwd)).toBe(false)
		},
	)
})
