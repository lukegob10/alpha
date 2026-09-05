import { execFile, spawnSync } from "child_process"
import { existsSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { promisify } from "util"

import {
	buildPytestVerificationTerminalLaunch,
	createPytestVerificationEnvironment,
	type PytestVerificationLaunch,
} from "../PytestVerificationLauncher"

const execFileAsync = promisify(execFile)
const launch: PytestVerificationLaunch = Object.freeze({
	executionId: "physical-execution-1",
	moduleName: "alpha_pytest_receipt_123",
	moduleDirectory: "/tmp/alpha receipt's $(untrusted)",
	reportPath: "/tmp/alpha receipt's $(untrusted)/report.json",
})

function quotePowerShell(value: string): string {
	return `'${value.replace(/'/g, "''")}'`
}

function quotePosix(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`
}

describe("pytest verification launcher", () => {
	it("appends only observer imports without changing original options or environment", () => {
		const environment = Object.freeze({
			PYTHONPATH: "/project/lib:/shared/lib",
			PYTEST_PLUGINS: "existing.plugin,second_plugin",
			PYTEST_ADDOPTS: "--ignore=tests/unit -k smoke",
			PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1",
			OTHER: "unchanged",
		})
		const result = createPytestVerificationEnvironment(launch, environment, "linux")
		expect(result).toEqual({
			...environment,
			PYTHONPATH: `${environment.PYTHONPATH}:${launch.moduleDirectory}`,
			PYTEST_PLUGINS: `${environment.PYTEST_PLUGINS},${launch.moduleName}`,
		})
		expect(environment.PYTHONPATH).toBe("/project/lib:/shared/lib")
		expect(Object.isFrozen(result)).toBe(true)
	})

	it.each([{}, { PYTHONPATH: "", PYTEST_PLUGINS: "" }])(
		"does not introduce an empty import search entry when existing values are absent or empty",
		(environment) => {
			expect(createPytestVerificationEnvironment(launch, environment, "linux")).toEqual({
				PYTHONPATH: launch.moduleDirectory,
				PYTEST_PLUGINS: launch.moduleName,
			})
		},
	)

	it("preserves Windows mixed-case environment names and path separators", () => {
		const windowsLaunch = {
			...launch,
			moduleDirectory: "C:\\temp\\observer",
			reportPath: "C:\\temp\\observer\\report.json",
		}
		expect(
			createPytestVerificationEnvironment(
				windowsLaunch,
				{ PythonPath: "C:\\lib", PyTest_Plugins: "existing" },
				"win32",
			),
		).toEqual({ PythonPath: "C:\\lib;C:\\temp\\observer", PyTest_Plugins: `existing,${launch.moduleName}` })
	})

	it.each([undefined, "cmd", "fish", "wsl", "nu"])("does not guess wrapper syntax for shell %s", (shell) => {
		expect(buildPytestVerificationTerminalLaunch("python -m pytest", launch, shell, "linux")).toEqual({
			available: false,
			reason: expect.stringContaining("unsupported or unidentified"),
		})
	})

	it.each(["bash", "sh", "zsh", "gitbash"])("retains the original command once for %s", (shell) => {
		const command = 'python3 -m pytest tests/unit -k "quoted selection"'
		const result = buildPytestVerificationTerminalLaunch(command, launch, shell, "linux")
		expect(result.available).toBe(true)
		if (!result.available) throw new Error(result.reason)
		expect(result.commandToExecute.split(command)).toHaveLength(2)
		expect(result.commandToExecute).toContain("${PYTHONPATH:+${PYTHONPATH}:}")
		expect(result.commandToExecute).not.toContain("PYTEST_ADDOPTS=")
		expect(result.helper).toBeUndefined()
	})

	it.each(["pwsh", "powershell"])("uses a script-file exit boundary for %s", (shell) => {
		const command = "py -3.12 -m pytest tests/unit"
		const result = buildPytestVerificationTerminalLaunch(command, launch, shell, "linux")
		expect(result.available).toBe(true)
		if (!result.available) throw new Error(result.reason)
		expect(result.commandToExecute).toBe(`& ${quotePowerShell(`${launch.moduleDirectory}/launch.ps1`)}`)
		expect(result.commandToExecute).not.toContain("exit")
		expect(result.helper?.content.split(command)).toHaveLength(2)
		expect(result.helper?.content).toContain("} finally {")
		expect(result.helper?.content).not.toMatch(/\$LASTEXITCODE\s*=/)
		expect(result.helper?.content).not.toContain("ExecutionPolicy")
	})

	it.each([
		{ ...launch, moduleName: "observer;bad" },
		{ ...launch, moduleDirectory: "/tmp/colon:separator" },
		{ ...launch, moduleDirectory: "relative" },
		{ ...launch, reportPath: "/tmp/report\n.json" },
	])("rejects unsafe or unrepresentable descriptors without guessing", (invalid) => {
		expect(buildPytestVerificationTerminalLaunch("pytest", invalid, "bash", "linux").available).toBe(false)
	})
})

const powerShells = ["pwsh", "powershell"].filter(
	(executable) =>
		spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
			timeout: 5_000,
			windowsHide: true,
		}).status === 0,
)

const posixShells = (
	process.platform === "win32"
		? [
				{
					executable: path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
					shell: "bash",
				},
				{
					executable: path.join(
						process.env.ProgramFiles ?? "C:\\Program Files",
						"Git",
						"usr",
						"bin",
						"sh.exe",
					),
					shell: "sh",
				},
			]
		: [
				{ executable: "/bin/bash", shell: "bash" },
				{ executable: "/bin/sh", shell: "sh" },
				{ executable: "/bin/zsh", shell: "zsh" },
			]
).filter(({ executable }) => existsSync(executable))

describe("pytest verification launcher in real shells", () => {
	let directory: string
	let probePath: string
	let physicalLaunch: PytestVerificationLaunch

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-pytest-launcher-"))
		const moduleDirectory = path.join(directory, "observer's $literal space")
		await fs.mkdir(moduleDirectory)
		physicalLaunch = { ...launch, moduleDirectory, reportPath: path.join(moduleDirectory, "report.json") }
		probePath = path.join(directory, "probe.cjs")
		await fs.writeFile(
			probePath,
			`console.log(JSON.stringify({path:process.env.PYTHONPATH,plugins:process.env.PYTEST_PLUGINS,options:process.env.PYTEST_ADDOPTS}));process.exit(Number(process.argv[2]));`,
		)
	})

	afterEach(async () => {
		// Only remove the exact directory created by this test, never an observer-supplied path.
		if (
			directory &&
			path.dirname(directory) === path.resolve(os.tmpdir()) &&
			path.basename(directory).startsWith("alpha-pytest-launcher-")
		) {
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	for (const powerShell of powerShells) {
		it(`preserves Unicode helper paths and native arguments in ${powerShell}`, async () => {
			const unicodeDirectory = path.join(directory, "観察-é-Δ")
			await fs.mkdir(unicodeDirectory)
			const unicodeProbePath = path.join(unicodeDirectory, "検査.cjs")
			const outputPath = path.join(unicodeDirectory, "結果.json")
			await fs.writeFile(
				unicodeProbePath,
				`require('fs').writeFileSync(process.argv[2], JSON.stringify({args:process.argv.slice(3),path:process.env.PYTHONPATH}));process.exit(7);`,
			)
			const argumentsToPreserve = ["café", "日本語", "Δοκιμή"]
			const command = `& ${[process.execPath, unicodeProbePath, outputPath, ...argumentsToPreserve].map(quotePowerShell).join(" ")}`
			const result = buildPytestVerificationTerminalLaunch(
				command,
				{
					...physicalLaunch,
					moduleDirectory: unicodeDirectory,
					reportPath: path.join(unicodeDirectory, "receipt.json"),
				},
				"pwsh",
			)
			if (!result.available || !result.helper) throw new Error("Expected a PowerShell helper")
			await fs.writeFile(result.helper.path, result.helper.content, "utf8")
			const { stdout } = await execFileAsync(
				powerShell,
				[
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`${result.commandToExecute}\nWrite-Output ('exit=' + $LASTEXITCODE)`,
				],
				{
					env: { ...process.env, PYTHONPATH: "inherited" },
					timeout: 10_000,
					maxBuffer: 64 * 1_024,
					windowsHide: true,
				},
			)
			// Read UTF-8 from the native process's artifact so PS5 console decoding cannot mask a source-encoding bug.
			expect(JSON.parse(await fs.readFile(outputPath, "utf8"))).toEqual({
				args: argumentsToPreserve,
				path: `inherited${path.delimiter}${unicodeDirectory}`,
			})
			expect(stdout.trim()).toBe("exit=7")
		})

		it.each([0, 7])(
			`preserves ${powerShell} native exit %i, inherited environment, and the caller shell`,
			async (exitCode) => {
				const command = `& ${quotePowerShell(process.execPath)} ${quotePowerShell(probePath)} ${exitCode}`
				const result = buildPytestVerificationTerminalLaunch(command, physicalLaunch, "pwsh")
				if (!result.available || !result.helper) throw new Error("Expected a PowerShell helper")
				await fs.writeFile(result.helper.path, result.helper.content)
				const script = [
					result.commandToExecute,
					"$alphaProbeSucceeded = $?",
					"$alphaProbeExit = $LASTEXITCODE",
					"@{ kind='restored'; code=$alphaProbeExit; succeeded=$alphaProbeSucceeded; path=$env:PYTHONPATH; plugins=$env:PYTEST_PLUGINS; options=$env:PYTEST_ADDOPTS } | ConvertTo-Json -Compress",
				].join("\n")
				const { stdout } = await execFileAsync(
					powerShell,
					["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
					{
						env: {
							...process.env,
							PYTHONPATH: "original path",
							PYTEST_PLUGINS: "original_plugin",
							PYTEST_ADDOPTS: "--ignore=tests/unit",
						},
						timeout: 10_000,
						maxBuffer: 64 * 1_024,
						windowsHide: true,
					},
				)
				const lines = stdout
					.trim()
					.split(/\r?\n/)
					.map((line) => JSON.parse(line))
				expect(lines).toEqual([
					{
						path: `original path${path.delimiter}${physicalLaunch.moduleDirectory}`,
						plugins: `original_plugin,${launch.moduleName}`,
						options: "--ignore=tests/unit",
					},
					{
						kind: "restored",
						code: exitCode,
						succeeded: exitCode === 0,
						path: "original path",
						plugins: "original_plugin",
						options: "--ignore=tests/unit",
					},
				])
			},
		)

		it(`restores absent ${powerShell} environment variables after native failure`, async () => {
			const command = `& ${quotePowerShell(process.execPath)} ${quotePowerShell(probePath)} 7`
			const result = buildPytestVerificationTerminalLaunch(command, physicalLaunch, "pwsh")
			if (!result.available || !result.helper) throw new Error("Expected a PowerShell helper")
			await fs.writeFile(result.helper.path, result.helper.content)
			const script = `${result.commandToExecute}\n@{pathPresent=(Test-Path Env:PYTHONPATH);pluginsPresent=(Test-Path Env:PYTEST_PLUGINS)} | ConvertTo-Json -Compress`
			const environment = { ...process.env }
			delete environment.PYTHONPATH
			delete environment.PYTEST_PLUGINS
			const { stdout } = await execFileAsync(
				powerShell,
				["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
				{
					env: environment,
					timeout: 10_000,
					maxBuffer: 64 * 1_024,
					windowsHide: true,
				},
			)
			expect(JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!)).toEqual({
				pathPresent: false,
				pluginsPresent: false,
			})
		})
	}

	for (const { executable, shell } of posixShells) {
		it.each([0, 7])(`preserves ${shell} native exit %i and inherited shell environment`, async (exitCode) => {
			const command = `${quotePosix(process.execPath.replace(/\\/g, "/"))} ${quotePosix(probePath.replace(/\\/g, "/"))} ${exitCode}`
			const result = buildPytestVerificationTerminalLaunch(command, physicalLaunch, shell)
			if (!result.available) throw new Error(result.reason)
			const script = [
				"PYTHONPATH='original path'; export PYTHONPATH",
				"PYTEST_PLUGINS='original_plugin'; export PYTEST_PLUGINS",
				"PYTEST_ADDOPTS='--ignore=tests/unit'; export PYTEST_ADDOPTS",
				result.commandToExecute,
				"alpha_probe_exit=$?",
				`printf 'restored:%s|%s|%s|%s\\n' "$alpha_probe_exit" "$PYTHONPATH" "$PYTEST_PLUGINS" "$PYTEST_ADDOPTS"`,
			].join("\n")
			const { stdout } = await execFileAsync(executable, ["-c", script], {
				timeout: 10_000,
				maxBuffer: 64 * 1_024,
				windowsHide: true,
			})
			const lines = stdout.trim().split(/\r?\n/)
			expect(lines).toHaveLength(2)
			expect(JSON.parse(lines[0])).toEqual({
				path: `original path${path.delimiter}${physicalLaunch.moduleDirectory}`,
				plugins: `original_plugin,${launch.moduleName}`,
				options: "--ignore=tests/unit",
			})
			expect(lines[1]).toBe(`restored:${exitCode}|original path|original_plugin|--ignore=tests/unit`)
		})
	}
})
