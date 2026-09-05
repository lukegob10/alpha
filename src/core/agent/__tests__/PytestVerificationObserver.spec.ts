import { execFile, spawnSync } from "child_process"
import fs from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { promisify } from "util"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { pythonVerificationObserverSource } from "../PytestVerificationObserver"
import { createPytestVerificationReceipt } from "../PytestVerificationReceipt"

const execFileAsync = promisify(execFile)
const python = [
	{ executable: "python", args: [] },
	{ executable: "python3", args: [] },
	{ executable: "py", args: ["-3"] },
].find(({ executable, args }) => {
	const result = spawnSync(executable, [...args, "-c", "import pytest"], {
		timeout: 5_000,
		windowsHide: true,
		stdio: "ignore",
	})
	return result.status === 0
})

interface Receipt {
	unsupported?: string
	collectionCompleted: boolean
	exitStatus: number
	selection: Record<string, unknown>
	files: Array<{ path: string; collected: number; passed: number; skipped: number; failed: number }>
}

describe.skipIf(!python)("pytest verification observer with an installed Python/pytest runtime", () => {
	let workspace: string
	let reportPath: string
	let identity: Parameters<typeof pythonVerificationObserverSource>[0]

	beforeEach(async () => {
		workspace = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "alpha-pytest-observer-")))
		reportPath = path.join(workspace, "receipt.json")
		identity = { executionId: "execution-1", nonce: 'nonce-"-\\-☃', commandDigest: "a".repeat(64), reportPath }
		await fs.writeFile(path.join(workspace, "pytest.ini"), "[pytest]\n")
		await fs.writeFile(path.join(workspace, "alpha_observer.py"), pythonVerificationObserverSource(identity))
	})

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true })
	})

	const write = (file: string, content: string) => fs.writeFile(path.join(workspace, file), content)
	const receipt = async (): Promise<Receipt> => JSON.parse(await fs.readFile(reportPath, "utf8"))
	const execute = async (args: string[], environment: NodeJS.ProcessEnv = {}) => {
		const options = {
			cwd: workspace,
			windowsHide: true,
			timeout: 20_000,
			maxBuffer: 1_048_576,
			env: {
				...process.env,
				PYTHONPATH: workspace,
				PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1",
				PYTEST_PLUGINS: "",
				PYTEST_ADDOPTS: "",
				...environment,
			},
		}
		try {
			const result = await execFileAsync(python!.executable, [...python!.args, ...args], options)
			return { ...result, exitCode: 0 }
		} catch (error) {
			const failure = error as { code?: number | string; stdout?: string; stderr?: string }
			if (typeof failure.code !== "number") throw error
			return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", exitCode: failure.code }
		}
	}
	const pytest = (args: string[] = [], environment?: NodeJS.ProcessEnv) =>
		execute(["-m", "pytest", "-c", "pytest.ini", "-p", "alpha_observer", "-q", ...args], environment)

	it("writes bound identity and per-file outcomes without changing the test result", async () => {
		await write(
			"test_outcomes.py",
			"import pytest\ndef test_pass(): assert True\n@pytest.mark.skip(reason='intentional')\ndef test_skip(): pass\n@pytest.mark.xfail(reason='expected')\ndef test_xfail(): assert False\n",
		)
		const baseline = await execute(["-m", "pytest", "-c", "pytest.ini", "-q"])
		const observed = await pytest()
		expect(observed.exitCode).toBe(baseline.exitCode)
		expect(observed.stdout).toContain("1 passed, 1 skipped, 1 xfailed")
		expect(await receipt()).toMatchObject({
			schemaVersion: 1,
			executionId: identity.executionId,
			nonce: identity.nonce,
			commandDigest: identity.commandDigest,
			cwd: workspace,
			rootPath: workspace,
			configPath: path.join(workspace, "pytest.ini"),
			pytestVersion: expect.any(String),
			collectionCompleted: true,
			exitStatus: 0,
			selection: { keyword: "", markexpr: "", collectonly: false, lf: false, stepwise: false },
			files: [{ path: path.join(workspace, "test_outcomes.py"), collected: 3, passed: 1, skipped: 2, failed: 0 }],
		})
		expect((await receipt()).unsupported).toBeUndefined()
		await expect(fs.stat(`${reportPath}.tmp`)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("counts setup and teardown failures as failed tests without double-counting a call pass", async () => {
		await write(
			"test_failures.py",
			"import pytest\n@pytest.fixture\ndef broken_setup(): raise RuntimeError('setup')\n@pytest.fixture\ndef broken_teardown():\n    yield\n    raise RuntimeError('teardown')\ndef test_setup(broken_setup): pass\ndef test_teardown(broken_teardown): assert True\ndef test_call(): assert False\n",
		)
		expect((await pytest()).exitCode).toBe(1)
		expect((await receipt()).files).toEqual([
			{ path: path.join(workspace, "test_failures.py"), collected: 3, passed: 0, skipped: 0, failed: 3 },
		])
		expect((await receipt()).exitStatus).toBe(1)
	})

	it.each(["--collect-only", "--ignore=test_selected.py"])(
		"observes a non-validating run with %s",
		async (option) => {
			await write("test_selected.py", "def test_pass(): assert True\n")
			await pytest([option])
			const observed = await receipt()
			expect(observed.files.every((file) => file.passed === 0)).toBe(true)
			if (option === "--collect-only") expect(observed.selection.collectonly).toBe(true)
			else expect(observed.selection.ignore).toEqual(["test_selected.py"])
		},
	)

	it("captures inherited and configured effective selection rather than raw invocation arguments", async () => {
		await write("pytest.ini", "[pytest]\naddopts = -k selected\nmarkers = smoke: smoke coverage\n")
		await write(
			"test_selected.py",
			"import pytest\n@pytest.mark.smoke\ndef test_selected(): assert True\ndef test_other(): assert True\n",
		)
		await pytest([], { PYTEST_ADDOPTS: "-m smoke --stepwise" })
		expect(await receipt()).toMatchObject({
			selection: { keyword: "selected", markexpr: "smoke", stepwise: true },
			unsupported: "collection_selection_changed",
		})
	})

	it("rejects an inherited ini override silently dropping a failing test in the same file", async () => {
		await write("test_selected.py", "def test_smoke(): assert True\ndef test_regression(): assert False\n")
		const args = ["-m", "pytest", "-c", "pytest.ini", "-q"]
		const environment = { PYTEST_ADDOPTS: "-o python_functions=test_smoke" }
		expect((await execute(args)).exitCode).toBe(1)
		const unobserved = await execute(args, environment)
		expect(unobserved.exitCode).toBe(0)
		expect(unobserved.stdout).toContain("1 passed")
		expect((await pytest([], environment)).exitCode).toBe(0)
		expect(await receipt()).toMatchObject({
			unsupported: "unsupported_collection_override",
			files: [{ collected: 1, passed: 1 }],
		})
	})

	it("latches an effective collection restriction even when a later hook restores the default", async () => {
		await write("test_selected.py", "def test_smoke(): assert True\ndef test_regression(): assert False\n")
		await write(
			"conftest.py",
			"def pytest_configure(config): config._inicache['python_functions'] = ['test_smoke']\ndef pytest_sessionfinish(session): session.config._inicache['python_functions'] = ['test']\n",
		)
		expect((await pytest()).exitCode).toBe(0)
		expect(await receipt()).toMatchObject({
			unsupported: "unsupported_collection_setting:python_functions",
			files: [{ collected: 1, passed: 1 }],
		})
	})

	it("allows inherited overrides of supported reporting settings", async () => {
		await write("test_selected.py", "def test_one(): assert True\ndef test_two(): assert True\n")
		expect((await pytest([], { PYTEST_ADDOPTS: "-o console_output_style=count -o log_cli=false" })).exitCode).toBe(
			0,
		)
		expect((await receipt()).unsupported).toBeUndefined()
		expect((await receipt()).files[0]).toMatchObject({ collected: 2, passed: 2 })
	})

	it("detects custom deselection but allows collection reordering", async () => {
		await write("test_selected.py", "def test_one(): assert True\ndef test_two(): assert True\n")
		await write("conftest.py", "def pytest_collection_modifyitems(items): items.reverse()\n")
		await pytest()
		expect((await receipt()).unsupported).toBeUndefined()
		await write("conftest.py", "def pytest_collection_modifyitems(items): items.pop()\n")
		await pytest()
		expect(await receipt()).toMatchObject({ unsupported: "collection_selection_changed" })
		expect((await receipt()).files[0]).toMatchObject({ collected: 1, passed: 1 })
	})

	it("preserves ordinary fixtures, fixture parameters, and mark.parametrize", async () => {
		await write(
			"conftest.py",
			"import pytest\n@pytest.fixture(params=[1, 2])\ndef number(request): return request.param\ndef pytest_make_parametrize_id(val): return 'value-' + str(val)\n",
		)
		await write(
			"test_parameters.py",
			"import pytest\n@pytest.mark.parametrize('factor', [3, 4])\ndef test_product(number, factor): assert number * factor > 0\n",
		)
		expect((await pytest()).exitCode).toBe(0)
		expect((await receipt()).unsupported).toBeUndefined()
		expect((await receipt()).files[0]).toMatchObject({ collected: 4, passed: 4, skipped: 0, failed: 0 })
	})

	it("rejects a makeitem hook silently dropping one test from an otherwise passing file", async () => {
		await write("test_selected.py", "def test_kept(): assert True\ndef test_dropped(): assert False\n")
		await write(
			"conftest.py",
			"def pytest_pycollect_makeitem(collector, name, obj):\n    if name == 'test_dropped': return []\n",
		)
		expect((await pytest()).exitCode).toBe(0)
		expect(await receipt()).toMatchObject({
			unsupported: "custom_collection_hook:pytest_pycollect_makeitem",
			files: [{ collected: 1, passed: 1 }],
		})
	})

	it.each(["conftest", "module", "class"] as const)("rejects custom %s parametrization generators", async (owner) => {
		const generator = "def pytest_generate_tests(metafunc):\n    metafunc.parametrize('value', [1])\n"
		if (owner === "conftest") {
			await write("conftest.py", generator)
			await write("test_generated.py", "def test_value(value): assert value == 1\n")
		} else if (owner === "module") {
			await write("test_generated.py", `${generator}def test_value(value): assert value == 1\n`)
		} else {
			await write(
				"test_generated.py",
				"class TestGenerated:\n    def pytest_generate_tests(self, metafunc):\n        metafunc.parametrize('value', [1])\n    def test_value(self, value): assert value == 1\n",
			)
		}
		expect((await pytest()).exitCode).toBe(0)
		expect((await receipt()).unsupported).toBe(
			owner === "conftest" ? "custom_collection_hook:pytest_generate_tests" : "custom_test_generation",
		)
	})

	it.each(["pytest_collection_modifyitems", "pytest_collection_finish"])(
		"rejects an outer custom collection wrapper for %s",
		async (hook) => {
			await write("test_selected.py", "def test_pass(): assert True\n")
			await write(
				"conftest.py",
				`import pytest\n@pytest.hookimpl(hookwrapper=True, tryfirst=True)\ndef ${hook}(session):\n    yield\n`,
			)
			expect((await pytest()).exitCode).toBe(0)
			expect((await receipt()).unsupported).toBe(`custom_collection_wrapper:${hook}`)
		},
	)

	it("observes unsafe hooks in conftests first registered during collection", async () => {
		await fs.mkdir(path.join(workspace, "nested"))
		await write("nested/test_selected.py", "def test_kept(): assert True\ndef test_dropped(): assert False\n")
		await write(
			"nested/conftest.py",
			"def pytest_pycollect_makeitem(collector, name, obj):\n    if name == 'test_dropped': return []\n",
		)
		expect((await pytest()).exitCode).toBe(0)
		expect((await receipt()).unsupported).toBe("custom_collection_hook:pytest_pycollect_makeitem")
	})

	it("writes after ordinary sessionfinish hooks and preserves their exit status", async () => {
		await write("test_selected.py", "def test_pass(): assert True\n")
		await write("conftest.py", "def pytest_sessionfinish(session): session.exitstatus = 4\n")
		expect((await pytest()).exitCode).toBe(4)
		expect((await receipt()).exitStatus).toBe(4)
	})

	it("marks repeated sessions in the same interpreter unsupported", async () => {
		await write("test_selected.py", "def test_pass(): assert True\n")
		await execute([
			"-c",
			"import pytest; args=['-c','pytest.ini','-p','alpha_observer','-q']; pytest.main(args); pytest.main(args)",
		])
		expect((await receipt()).unsupported).toBe("repeated_sessions")
	})

	it("marks a distributed worker unsupported", async () => {
		await write("test_selected.py", "def test_pass(): assert True\n")
		await write("conftest.py", "def pytest_configure(config): config.workerinput = {}\n")
		expect((await pytest()).exitCode).toBe(0)
		expect((await receipt()).unsupported).toBe("distributed_execution")
	})

	it("bounds observed files while preserving collection", async () => {
		for (let index = 0; index < 257; index++) {
			await write(`test_${index}.py`, "def test_pass(): assert True\n")
		}
		expect((await pytest(["--collect-only"])).exitCode).toBe(0)
		const observed = await receipt()
		expect(observed.unsupported).toBe("file_overflow")
		expect(observed.files.length).toBeLessThanOrEqual(256)
		expect((await fs.stat(reportPath)).size).toBeLessThanOrEqual(262_144)
	})

	it.each([
		[1, 4_100, "unsupported_text"],
		[100, 3_000, "receipt_overflow"],
	] as const)(
		"bounds custom collector paths and receipt size (%i items, %i characters)",
		async (count, size, reason) => {
			await write(
				"test_paths.py",
				`import pytest\n@pytest.mark.parametrize('value', range(${count}))\ndef test_value(value): assert True\n`,
			)
			await write(
				"conftest.py",
				`from pathlib import Path\ndef pytest_collection_modifyitems(items):\n    for index, item in enumerate(items):\n        item.path = Path.cwd() / ('x' * ${size}) / ('test_' + str(index) + '.py')\n`,
			)
			expect((await pytest(["--collect-only"])).exitCode).toBe(0)
			expect((await receipt()).unsupported).toBe(reason)
			expect((await fs.stat(reportPath)).size).toBeLessThanOrEqual(262_144)
		},
	)

	it("leaves test execution unchanged when the receipt destination is unavailable", async () => {
		await write("test_selected.py", "def test_pass(): assert True\n")
		await write(
			"alpha_observer.py",
			pythonVerificationObserverSource({
				...identity,
				reportPath: path.join(workspace, "missing", "receipt.json"),
			}),
		)
		expect((await pytest()).exitCode).toBe(0)
		await expect(fs.stat(reportPath)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("passes an actual generated observer receipt through the host receipt manager", async () => {
		await write("test_manager.py", "def test_pass(): assert True\n")
		const manager = await createPytestVerificationReceipt({
			executionId: identity.executionId,
			commandDigest: identity.commandDigest,
			cwd: workspace,
			workspaceRoot: workspace,
			expectedFiles: ["test_manager.py"],
			configFiles: ["pytest.ini"],
		})
		try {
			const result = await execute(["-m", "pytest", "-c", "pytest.ini", "-p", manager.launch.moduleName, "-q"], {
				PYTHONPATH: [manager.launch.moduleDirectory, workspace].join(path.delimiter),
			})
			expect(result.exitCode).toBe(0)
			expect(await manager.complete()).toEqual({ validated: true })
		} finally {
			await manager.dispose()
		}
	})
})
