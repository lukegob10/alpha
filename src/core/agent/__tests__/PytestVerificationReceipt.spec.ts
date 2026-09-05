import fs from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { pythonVerificationObserverSource } from "../PytestVerificationObserver"
import { createPytestVerificationReceipt } from "../PytestVerificationReceipt"

vi.mock("../PytestVerificationObserver", () => ({
	pythonVerificationObserverSource: vi.fn((identity: unknown) => JSON.stringify(identity)),
}))

type Receipt = Awaited<ReturnType<typeof createPytestVerificationReceipt>>

describe("host-owned pytest runtime receipts", () => {
	let fixture: string
	let root: string
	let receipts: Receipt[]
	const selection = () => ({
		keyword: "",
		markexpr: "",
		collectonly: false,
		lf: false,
		stepwise: false,
		ignore: [] as string[],
		ignoreGlob: [] as string[],
		deselect: [] as string[],
	})
	const create = async (expectedFiles: string[] = ["tests/test_example.py"]) => {
		const receipt = await createPytestVerificationReceipt({
			executionId: "physical-execution-1",
			commandDigest: "a".repeat(64),
			cwd: root,
			workspaceRoot: root,
			expectedFiles,
			configFiles: ["pytest.ini"],
		})
		receipts.push(receipt)
		return receipt
	}
	const reportFor = (receipt: Receipt) => {
		const identity = vi
			.mocked(pythonVerificationObserverSource)
			.mock.calls.find(([candidate]) => candidate.reportPath === receipt.launch.reportPath)![0]
		return {
			schemaVersion: 1,
			executionId: identity.executionId,
			nonce: identity.nonce,
			commandDigest: identity.commandDigest,
			cwd: root,
			rootPath: root,
			configPath: null as string | null,
			pytestVersion: "8.4.2",
			collectionCompleted: true,
			selection: selection(),
			files: [{ path: path.join(root, "tests/test_example.py"), collected: 1, passed: 1, skipped: 0, failed: 0 }],
			exitStatus: 0,
		}
	}
	const writeReport = (receipt: Receipt, changes: Record<string, unknown> = {}) =>
		fs.writeFile(receipt.launch.reportPath, JSON.stringify({ ...reportFor(receipt), ...changes }))
	const expectUnavailable = async (receipt: Receipt) => {
		expect(await receipt.complete()).toMatchObject({
			validated: false,
			diagnostic: { code: "runtime_scope_unavailable", message: expect.stringContaining("unverified") },
		})
	}

	beforeEach(async () => {
		vi.clearAllMocks()
		receipts = []
		fixture = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "alpha-pytest-receipt-test-")))
		root = path.join(fixture, "workspace")
		await fs.mkdir(path.join(root, "tests"), { recursive: true })
		await fs.writeFile(path.join(root, "tests/test_example.py"), "def test_example():\n    assert True\n")
		await fs.writeFile(path.join(root, "pytest.ini"), "[pytest]\n")
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		for (const receipt of receipts) await receipt.dispose()
		await fs.rm(fixture, { recursive: true, force: true })
	})

	it("creates immutable isolated execution descriptors and accepts positive file receipts", async () => {
		const first = await create()
		const second = await create()
		expect(Object.isFrozen(first.launch)).toBe(true)
		expect(path.relative(root, first.launch.moduleDirectory).startsWith("..")).toBe(true)
		expect(first.launch.moduleDirectory).not.toBe(second.launch.moduleDirectory)
		expect(first.launch.moduleName).toMatch(/^_alpha_pytest_[a-f0-9]+$/)
		expect(reportFor(first).nonce).not.toBe(reportFor(second).nonce)
		await expect(
			fs.readFile(path.join(first.launch.moduleDirectory, `${first.launch.moduleName}.py`), "utf8"),
		).resolves.toContain(first.launch.executionId)
		await writeReport(first)
		expect(await first.complete()).toEqual({ validated: true })
	})

	it("caches completion and disposes its private directory exactly once", async () => {
		const receipt = await create()
		await writeReport(receipt)
		const first = receipt.complete()
		expect(receipt.complete()).toBe(first)
		expect(await first).toEqual({ validated: true })
		await fs.writeFile(receipt.launch.reportPath, "tampered")
		expect(await receipt.complete()).toEqual({ validated: true })
		const disposal = receipt.dispose()
		expect(receipt.dispose()).toBe(disposal)
		await disposal
		await expect(fs.stat(receipt.launch.moduleDirectory)).rejects.toMatchObject({ code: "ENOENT" })
		await expect(fs.stat(path.join(root, "tests/test_example.py"))).resolves.toBeDefined()
	})

	it("captures the execution identity and scope before asynchronous setup", async () => {
		const input = {
			executionId: "original-execution",
			commandDigest: "original-command",
			cwd: root,
			workspaceRoot: root,
			expectedFiles: ["tests/test_example.py"],
			configFiles: ["pytest.ini"],
		}
		const pending = createPytestVerificationReceipt(input)
		input.executionId = "mutated-execution"
		input.commandDigest = "mutated-command"
		input.expectedFiles.length = 0
		input.configFiles.length = 0
		const receipt = await pending
		receipts.push(receipt)
		expect(receipt.launch.executionId).toBe("original-execution")
		await writeReport(receipt, { configPath: path.join(root, "pytest.ini") })
		expect(await receipt.complete()).toEqual({ validated: true })
	})

	it("rejects a report replaced between metadata inspection and opening", async () => {
		const receipt = await create()
		await writeReport(receipt)
		const replacement = path.join(receipt.launch.moduleDirectory, "replacement.json")
		await fs.writeFile(replacement, JSON.stringify(reportFor(receipt)))
		const open = fs.open.bind(fs)
		vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
			if (file === receipt.launch.reportPath) await fs.rename(replacement, receipt.launch.reportPath)
			return open(file, flags, mode)
		})
		await expectUnavailable(receipt)
	})

	it("fails closed when disposed before validation and does not recreate reports", async () => {
		const receipt = await create()
		await receipt.dispose()
		await expectUnavailable(receipt)
	})

	it.each(["missing", "malformed", "oversized", "directory"])("rejects %s reports", async (kind) => {
		const receipt = await create()
		if (kind === "malformed") await fs.writeFile(receipt.launch.reportPath, "{not json}")
		if (kind === "oversized") await fs.writeFile(receipt.launch.reportPath, " ".repeat(256 * 1_024 + 1))
		if (kind === "directory") await fs.mkdir(receipt.launch.reportPath)
		await expectUnavailable(receipt)
	})

	it.each([
		{ schemaVersion: 2 },
		{ executionId: "different-execution" },
		{ nonce: "different-nonce" },
		{ commandDigest: "different-command" },
		{ collectionCompleted: false },
		{ exitStatus: 1 },
		{ unsupported: "xdist workers" },
		{ unexpectedField: true },
	])("rejects stale, failed, or unknown receipt fields %j", async (changes) => {
		const receipt = await create()
		await writeReport(receipt, changes)
		await expectUnavailable(receipt)
	})

	it.each([
		{ keyword: "smoke" },
		{ markexpr: "quick" },
		{ collectonly: true },
		{ lf: true },
		{ stepwise: true },
		{ ignore: ["tests/test_example.py"] },
		{ ignoreGlob: ["tests/*"] },
		{ deselect: ["tests/test_example.py::test_example"] },
	])("rejects runtime selection restrictions %j", async (restricted) => {
		const receipt = await create()
		await writeReport(receipt, { selection: { ...selection(), ...restricted } })
		await expectUnavailable(receipt)
	})

	it.each([
		{ collected: 0, passed: 0 },
		{ passed: 0, skipped: 1 },
		{ passed: 0, failed: 1 },
		{ passed: 2 },
		{ collected: 2, passed: 1 },
		{ collected: -1 },
		{ passed: 0.5 },
		{ collected: Number.MAX_SAFE_INTEGER + 1 },
	])("requires consistent positive passed tests per expected file %j", async (counts) => {
		const receipt = await create()
		await writeReport(receipt, { files: [{ ...reportFor(receipt).files[0], ...counts }] })
		await expectUnavailable(receipt)
	})

	it("requires every expected test file and rejects duplicate or oversized file lists", async () => {
		await fs.writeFile(path.join(root, "tests/test_other.py"), "def test_other():\n    assert True\n")
		const missing = await create(["tests/test_example.py", "tests/test_other.py"])
		await writeReport(missing)
		await expectUnavailable(missing)
		const duplicate = await create()
		await writeReport(duplicate, { files: [reportFor(duplicate).files[0], reportFor(duplicate).files[0]] })
		await expectUnavailable(duplicate)
		const oversized = await create()
		await writeReport(oversized, { files: Array.from({ length: 257 }, () => reportFor(oversized).files[0]) })
		await expectUnavailable(oversized)
		const empty = await create([])
		await writeReport(empty)
		await expectUnavailable(empty)
	})

	it("accepts only observed configurations and contained runtime paths", async () => {
		const allowed = await create()
		await writeReport(allowed, { configPath: path.join(root, "pytest.ini") })
		expect(await allowed.complete()).toEqual({ validated: true })
		await fs.writeFile(path.join(root, "other.ini"), "[pytest]\n")
		for (const changes of [
			{ configPath: path.join(root, "other.ini") },
			{ rootPath: fixture },
			{ cwd: fixture },
			{ configPath: path.join(fixture, "other.ini") },
		]) {
			const receipt = await create()
			await writeReport(receipt, changes)
			await expectUnavailable(receipt)
		}
	})

	it("accepts equivalent cwd, root, config, and test paths through a canonical workspace alias", async () => {
		const alias = path.join(fixture, "workspace-alias")
		await fs.symlink(root, alias, "junction")
		const receipt = await createPytestVerificationReceipt({
			executionId: "aliased-execution",
			commandDigest: "aliased-command",
			cwd: alias,
			workspaceRoot: root,
			expectedFiles: ["tests/test_example.py"],
			configFiles: ["pytest.ini"],
		})
		receipts.push(receipt)
		await writeReport(receipt, {
			cwd: alias,
			rootPath: alias,
			configPath: path.join(alias, "pytest.ini"),
			files: [{ ...reportFor(receipt).files[0], path: path.join(alias, "tests/test_example.py") }],
		})
		expect(await receipt.complete()).toEqual({ validated: true })
	})

	it("rejects a different canonical working directory even when both directories are inside the workspace", async () => {
		const receipt = await create()
		await writeReport(receipt, { cwd: path.join(root, "tests") })
		await expectUnavailable(receipt)
	})

	it("rejects report junctions without reading or deleting their external target", async () => {
		const receipt = await create()
		const outside = path.join(fixture, "outside")
		await fs.mkdir(outside)
		await fs.writeFile(path.join(outside, "retained.txt"), "retain")
		await fs.symlink(outside, receipt.launch.reportPath, "junction")
		await expectUnavailable(receipt)
		await receipt.dispose()
		await expect(fs.readFile(path.join(outside, "retained.txt"), "utf8")).resolves.toBe("retain")
	})

	it("rejects workspace test paths that resolve through outward junctions", async () => {
		const outside = path.join(fixture, "outside")
		await fs.mkdir(outside)
		await fs.writeFile(path.join(outside, "test_external.py"), "def test_external():\n    assert True\n")
		await fs.symlink(outside, path.join(root, "external"), "junction")
		const receipt = await create(["external/test_external.py"])
		await writeReport(receipt, {
			files: [{ ...reportFor(receipt).files[0], path: path.join(root, "external/test_external.py") }],
		})
		await expectUnavailable(receipt)
	})
})
