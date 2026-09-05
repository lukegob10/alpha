import fs from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { resolveCommandVerification, type CommandVerificationDiagnostic } from "../VerificationScope"

const pytestInvocations = [
	"pytest",
	"python -m pytest",
	"python3 -m pytest",
	"python3.13 -m pytest",
	"py -3.13 -m pytest",
]

describe("Python command verification scope", () => {
	let root: string
	let fixture: string

	const write = async (file: string, content = "") => {
		const absolute = path.join(root, file)
		await fs.mkdir(path.dirname(absolute), { recursive: true })
		await fs.writeFile(absolute, content)
	}
	const resolve = (command: string, changedFiles: readonly string[], cwd = root) =>
		resolveCommandVerification({ workspaceRoot: root, cwd, command, changedFiles })

	beforeEach(async () => {
		fixture = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "alpha-verification-python-")))
		root = path.join(fixture, "workspace")
		await fs.mkdir(root)
		await write("src/application.py", "def answer():\n    return 42\n")
		await write("tests/test_application.py", "def test_answer():\n    assert True\n")
		await write("tests/unit/test_other.py", "def test_other():\n    assert True\n")
	})

	afterEach(async () => {
		await fs.rm(fixture, { recursive: true, force: true })
	})

	it.each(pytestInvocations)("recognizes equivalent full-suite invocation %s", async (invocation) => {
		expect(await resolve(`${invocation} -q`, ["src/application.py"])).toMatchObject({
			kind: "test",
			scopePath: root,
		})
	})

	it.each(pytestInvocations)("credits the conventional tests directory in %s", async (invocation) => {
		expect(
			await resolve(`${invocation} tests -q`, ["src/application.py", "tests/test_application.py"]),
		).toMatchObject({
			kind: "test",
			scopePath: root,
		})
	})

	it.each(pytestInvocations)("credits an explicitly selected changed test in %s", async (invocation) => {
		expect(
			await resolve(`${invocation} tests/test_application.py -q`, ["tests/test_application.py"]),
		).toMatchObject({
			kind: "test",
		})
		expect(await resolve(`${invocation} tests/test_application.py -q`, ["src/application.py"])).toBeUndefined()
	})

	it("limits a partial directory to changed tests it actually selects", async () => {
		expect(await resolve("pytest tests/unit -q", ["tests/unit/test_other.py"])).toMatchObject({ kind: "test" })
		expect(await resolve("pytest tests/unit -q", ["tests/test_application.py"])).toBeUndefined()
		expect(await resolve("pytest tests/unit -q", ["src/application.py"])).toBeUndefined()
		expect(
			await resolve("pytest tests/unit -q", ["tests/unit/test_other.py", "src/application.py"]),
		).toBeUndefined()
	})

	it("does not infer a full suite from an unrelated directory", async () => {
		await write("checks/test_smoke.py", "def test_smoke():\n    assert True\n")
		expect(await resolve("pytest checks -q", ["checks/test_smoke.py"])).toMatchObject({ kind: "test" })
		expect(await resolve("pytest checks -q", ["src/application.py"])).toBeUndefined()
		expect(await resolve("pytest missing -q", ["src/application.py"])).toBeUndefined()
	})

	it.each([
		["pytest.ini", "[pytest]\ntestpaths = checks\n"],
		["pyproject.toml", '[tool.pytest.ini_options]\ntestpaths = ["checks"]\n'],
		["setup.cfg", "[tool:pytest]\ntestpaths = checks\n"],
		["tox.ini", "[pytest]\ntestpaths = checks\n"],
	])("uses literal testpaths in %s as suite evidence", async (configFile, config) => {
		await write(configFile, config)
		await write("checks/test_smoke.py", "def test_smoke():\n    assert True\n")
		const accepted = await resolve("python3.13 -m pytest checks -q", ["src/application.py"])
		expect(accepted).toMatchObject({ kind: "test", scopePath: root })
		expect(accepted?.repositoryFiles[configFile]).toMatch(/^[a-f0-9]{64}$/)
		expect(await resolve("pytest -q", ["src/application.py"])).toMatchObject({ kind: "test" })
		expect(await resolve("pytest tests -q", ["src/application.py"])).toBeUndefined()
	})

	it("requires every configured suite directory before crediting source changes", async () => {
		await write("pytest.ini", "[pytest]\ntestpaths =\n    tests/unit\n    checks\n")
		await write("checks/test_smoke.py", "def test_smoke():\n    assert True\n")
		expect(await resolve("pytest tests/unit -q", ["src/application.py"])).toBeUndefined()
		expect(await resolve("pytest tests/unit checks -q", ["src/application.py"])).toMatchObject({ kind: "test" })
	})

	it("accepts standard multiline TOML testpaths with an unindented closing bracket", async () => {
		await write("pyproject.toml", '[tool.pytest.ini_options]\ntestpaths = [\n    "tests",\n]\n')
		expect(await resolve("python3.13 -m pytest tests -q", ["src/application.py"])).toMatchObject({ kind: "test" })
		expect(await resolve("pytest -q", ["src/application.py"])).toMatchObject({ kind: "test" })
	})

	it.each([
		["pytest.ini", "[pytest]\ntestpaths = tests\nminversion = 7.0\n"],
		["pytest.ini", "[pytest]\ntestpaths = tests\nmarkers =\n    smoke: quick smoke tests\n"],
		["pytest.ini", "[pytest]\ntestpaths = tests\nconsole_output_style = progress\naddopts = -ra -q\n"],
		["pyproject.toml", '[tool.pytest.ini_options]\ntestpaths = ["tests"]\nminversion = "7.0"\n'],
		[
			"pyproject.toml",
			'[tool.pytest.ini_options]\ntestpaths = ["tests"]\nmarkers = ["smoke: quick smoke tests"]\n',
		],
		[
			"pyproject.toml",
			'[tool.pytest.ini_options]\ntestpaths = ["tests"]\nconsole_output_style = "progress"\naddopts = "-ra -q"\n',
		],
	])("accepts harmless version, marker, or reporting settings in %s: %s", async (file, config) => {
		await write(file, config)
		expect(await resolve("pytest tests", ["src/application.py"])).toMatchObject({ kind: "test" })
	})

	it.each([
		'[[tool.example.index]]\nname = "internal"\nurl = "https://example.invalid/simple"\n',
		'[project.urls]\n"Source Code" = "https://example.invalid/source"\n',
	])("ignores unrelated TOML array tables and quoted metadata: %s", async (metadata) => {
		await write("pyproject.toml", `${metadata}\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n`)
		expect(await resolve("pytest tests", ["src/application.py"])).toMatchObject({ kind: "test" })
	})

	it.each([
		{ command: "pytest tests", configured: false },
		{ command: "pytest tests", configured: true },
		{ command: "pytest -q", configured: true },
	])("keeps unrelated source directories from exhausting suite scope: %j", async ({ command, configured }) => {
		if (configured) await write("pytest.ini", "[pytest]\ntestpaths = tests\n")
		for (let index = 0; index < 30; index++) await write(`src/component-${index}/module.py`, "value = 42\n")
		expect(await resolve(command, ["src/application.py"])).toMatchObject({ kind: "test", scopePath: root })
	})

	it.each([
		"pytest tests --collect-only",
		"pytest tests --co",
		"pytest tests -k answer",
		"pytest tests -m smoke",
		"pytest tests --ignore=tests/unit",
		"pytest tests --deselect=tests/test_application.py::test_answer",
		"pytest tests/test_application.py::test_answer",
		"pytest tests --lf",
		"pytest tests --last-failed",
		"pytest tests -c other.ini",
		"pytest tests --rootdir=tests",
		"pytest tests -o testpaths=tests/unit",
		"pytest tests -p custom_plugin",
		"python -c pytest",
		"python3.13 -I -m pytest tests",
		"py -3.13 -c pytest",
		"uv run pytest tests",
		"poetry run pytest tests",
		"env pytest tests",
		"PYTEST_ADDOPTS=-k pytest tests",
		"pytest tests && echo passed",
		"pytest tests | cat",
		"pytest tests; echo passed",
		"pytest tests > result.txt",
	])("rejects filtered, ambiguous, or shell-composed evidence: %s", async (command) => {
		expect(await resolve(command, ["tests/test_application.py"])).toBeUndefined()
	})

	it.each([
		"[pytest]\naddopts = --collect-only\n",
		"[pytest]\naddopts = -k smoke\n",
		"[pytest]\nnorecursedirs = tests/unit\n",
		"[pytest]\npython_files = smoke_*.py\n",
		"[pytest]\ntestpaths = ../outside\n",
	])("rejects unsupported or escaping collection configuration %s", async (config) => {
		await write("pytest.ini", config)
		expect(await resolve("pytest -q", ["src/application.py"])).toBeUndefined()
		expect(await resolve("pytest tests -q", ["tests/test_application.py"])).toBeUndefined()
	})

	it("does not credit unrelated languages or another project's source", async () => {
		await write("src/application.ts", "export const answer = 42\n")
		await write("nested/pyproject.toml", '[project]\nname = "nested"\n')
		await write("nested/src/application.py", "answer = 42\n")
		expect(await resolve("python3.13 -m pytest tests", ["src/application.ts"])).toBeUndefined()
		expect(await resolve("py -3.13 -m pytest tests", ["nested/src/application.py"])).toBeUndefined()
	})

	it.each([
		["pytest tests && echo passed", "unsafe_command"],
		["pytest tests --collect-only", "unsupported_command"],
		["pytest tests -k answer", "unsupported_command"],
		["uv run python3.13 -m pytest tests", "unsupported_command"],
		["hatch run pytest tests", "unsupported_command"],
		["tox -e pytest", "unsupported_command"],
		["custom-pytest tests", "unsupported_command"],
		["pytest tests/unit", "uncovered_changes"],
	])("reports a single actionable rejection for %s", async (command, code) => {
		const diagnostics: CommandVerificationDiagnostic[] = []
		expect(
			await resolveCommandVerification({
				workspaceRoot: root,
				cwd: root,
				command,
				changedFiles: ["src/application.py"],
				onRejected: (diagnostic) => diagnostics.push(diagnostic),
			}),
		).toBeUndefined()
		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]).toMatchObject({ code, message: expect.any(String) })
		expect(diagnostics[0].message.length).toBeGreaterThan(20)
	})

	it("does not credit a changed test outside configured testpaths in an implicit suite run", async () => {
		await write("pytest.ini", "[pytest]\ntestpaths = tests/unit\n")
		expect(await resolve("pytest -q", ["tests/test_application.py"])).toBeUndefined()
		expect(await resolve("pytest tests/test_application.py", ["tests/test_application.py"])).toMatchObject({
			kind: "test",
		})
	})

	it.each([
		[".pytest.ini", "[pytest]\naddopts = --collect-only\n"],
		["pytest.toml", '[pytest]\naddopts = ["--collect-only"]\n'],
		[".pytest.toml", '[pytest]\naddopts = ["-k", "smoke"]\n'],
		["pyproject.toml", '[tool.pytest]\naddopts = ["--collect-only"]\n'],
		["tests/.pytest.ini", "[pytest]\naddopts = --collect-only\n"],
		["tests/.pytest.toml", '[pytest]\naddopts = ["--collect-only"]\n'],
		["pyproject.toml", 'tool.pytest.ini_options.addopts = "-k smoke"\n'],
		["pyproject.toml", '[tool]\npytest.ini_options.addopts = "-k smoke"\n'],
	])("inspects collection settings in %s and rejects unsupported behavior", async (configFile, config) => {
		await write(configFile, config)
		const diagnostics: CommandVerificationDiagnostic[] = []
		expect(
			await resolveCommandVerification({
				workspaceRoot: root,
				cwd: root,
				command: "pytest tests",
				changedFiles: ["tests/test_application.py"],
				onRejected: (diagnostic) => diagnostics.push(diagnostic),
			}),
		).toBeUndefined()
		expect(diagnostics).toEqual([{ code: "unsupported_configuration", message: expect.any(String) }])
	})

	it.each(["conftest.py", "tests/conftest.py"])("rejects executable collection hooks in %s", async (file) => {
		await write(file, "def pytest_ignore_collect(collection_path, config):\n    return True\n")
		expect(await resolve("pytest tests", ["src/application.py"])).toBeUndefined()
		expect(await resolve("pytest tests/test_application.py", ["tests/test_application.py"])).toBeUndefined()
	})

	it("loads a nested hook for directory collection while an explicit sibling test loads only ancestor hooks", async () => {
		await write("tests/unit/conftest.py", "def pytest_ignore_collect(collection_path, config):\n    return True\n")
		expect(await resolve("pytest tests", ["src/application.py"])).toBeUndefined()
		expect(await resolve("pytest tests/test_application.py", ["tests/test_application.py"])).toMatchObject({
			kind: "test",
		})
	})

	it("fails closed when a configuration cannot be inspected as a regular file", async () => {
		await fs.mkdir(path.join(root, "pytest.ini"))
		await expect(resolve("pytest tests", ["src/application.py"])).rejects.toThrow("bounded regular file")
	})

	it("does not follow an outward junction during collection discovery or explicit targeting", async () => {
		const outside = path.join(fixture, "outside")
		await fs.mkdir(outside)
		await fs.writeFile(path.join(outside, "test_external.py"), "def test_external():\n    assert True\n")
		await fs.symlink(outside, path.join(root, "tests/external"), "junction")
		await expect(resolve("pytest tests", ["src/application.py"])).rejects.toThrow("outside")
		await expect(resolve("pytest tests/external", ["src/application.py"])).rejects.toThrow("outside")
	})

	it.each(["pytest.toml", ".pytest.toml", "tests/pytest.toml", "tests/.pytest.toml"])(
		"does not infer native TOML behavior without an installed pytest version: %s",
		async (file) => {
			await write(file, '[pytest]\ntestpaths = ["tests"]\n')
			expect(await resolve("pytest tests", ["src/application.py"])).toBeUndefined()
		},
	)

	it("rejects conflicting configuration files even when one has no testpaths", async () => {
		await write("pytest.ini", "[pytest]\n")
		await write("pyproject.toml", '[tool.pytest.ini_options]\ntestpaths = ["checks"]\n')
		await write("checks/test_smoke.py", "def test_smoke():\n    assert True\n")
		expect(await resolve("pytest checks", ["src/application.py"])).toBeUndefined()
	})

	it("allows unrelated project metadata alongside an unambiguous pytest configuration", async () => {
		await write("pytest.ini", "[pytest]\ntestpaths = tests\n")
		await write("pyproject.toml", '[project]\nname = "example"\nversion = "1.0.0"\n')
		expect(await resolve("pytest tests", ["src/application.py"])).toMatchObject({ kind: "test" })
	})

	it("does not ignore ordinary env directories while proving a conventional complete suite", async () => {
		await write("env/test_extra.py", "def test_extra():\n    assert True\n")
		expect(await resolve("pytest tests/", ["src/application.py"])).toBeUndefined()
	})

	it("does not credit changed tests under the default egg-directory exclusion", async () => {
		await write("artifacts.egg/test_skipped.py", "def test_skipped():\n    assert True\n")
		expect(await resolve("pytest -q", ["artifacts.egg/test_skipped.py"])).toBeUndefined()
	})

	it.each(["pyvenv.cfg", "conda-meta/history"])(
		"fails closed for tests in an arbitrary directory marked as an environment by %s",
		async (marker) => {
			await write(`sandbox/${marker}`, "")
			await write("sandbox/test_skipped.py", "def test_skipped():\n    assert True\n")
			expect(await resolve("pytest -q", ["sandbox/test_skipped.py"])).toBeUndefined()
		},
	)

	it("fingerprints inspected configs and absent hooks so later edits invalidate accepted evidence", async () => {
		await write("pytest.ini", "[pytest]\ntestpaths = tests\naddopts = -q\n")
		const before = await resolve("pytest tests", ["src/application.py"])
		expect(before).toMatchObject({ kind: "test" })
		expect(before?.repositoryFiles[".pytest.ini"]).toBe("missing")
		expect(before?.repositoryFiles["pytest.toml"]).toBe("missing")
		expect(before?.repositoryFiles[".pytest.toml"]).toBe("missing")
		expect(before?.repositoryFiles["tests/conftest.py"]).toBe("missing")
		await write("pytest.ini", "[pytest]\ntestpaths = tests\naddopts = -v\n")
		const after = await resolve("pytest tests", ["src/application.py"])
		expect(after).toMatchObject({ kind: "test", commandDigest: before?.commandDigest })
		expect(after?.repositoryFiles["pytest.ini"]).not.toBe(before?.repositoryFiles["pytest.ini"])
		expect(after?.repositoryDigest).not.toBe(before?.repositoryDigest)
		await write("tests/conftest.py", "collect_ignore = ['test_application.py']\n")
		expect(await resolve("pytest tests", ["src/application.py"])).toBeUndefined()
	})
})
