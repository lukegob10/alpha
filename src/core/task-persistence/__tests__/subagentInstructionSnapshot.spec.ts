import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import { digestValue } from "../../agent/StepContext"
import { GlobalFileNames } from "../../../shared/globalFileNames"
import { readSubagentInstructionSnapshot, saveSubagentInstructionSnapshot } from "../subagentInstructionSnapshot"

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return { ...actual, lstat: vi.fn(actual.lstat), rename: vi.fn(actual.rename) }
})

describe("managed-child frozen instruction snapshot persistence", () => {
	let globalStoragePath: string

	beforeEach(async () => {
		globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-subagent-instructions-"))
	})

	afterEach(async () => {
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		vi.mocked(fs.lstat).mockReset().mockImplementation(actual.lstat)
		vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename)
		vi.restoreAllMocks()
		await fs.rm(globalStoragePath, { recursive: true, force: true })
	})

	it("round-trips the exact frozen body outside public history metadata", async () => {
		const instructions = "\nFrozen AGENTS and user instructions.\nPreserve this boundary.\n"
		const expectedDigest = digestValue(instructions)

		await saveSubagentInstructionSnapshot({
			taskId: "child-1",
			globalStoragePath,
			instructions,
			expectedDigest,
		})

		await expect(
			readSubagentInstructionSnapshot({ taskId: "child-1", globalStoragePath, expectedDigest }),
		).resolves.toBe(instructions)
		const persisted = JSON.parse(
			await fs.readFile(
				path.join(globalStoragePath, "tasks", "child-1", GlobalFileNames.subagentInstructionSnapshot),
				"utf8",
			),
		)
		expect(persisted).toEqual({ version: 1, digest: expectedDigest, instructions })
	})

	it("returns undefined for a legacy child without a private snapshot", async () => {
		await expect(
			readSubagentInstructionSnapshot({
				taskId: "legacy-child",
				globalStoragePath,
				expectedDigest: "a".repeat(64),
			}),
		).resolves.toBeUndefined()
		expect(await fs.readdir(globalStoragePath)).toEqual([])
	})

	it("does not create a configured custom storage root while reading a legacy child", async () => {
		const customStoragePath = path.join(globalStoragePath, "custom-storage")
		const configuration = vscode.workspace.getConfiguration()
		vi.spyOn(configuration, "get").mockReturnValue(customStoragePath)
		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue(configuration)

		await expect(
			readSubagentInstructionSnapshot({
				taskId: "legacy-child",
				globalStoragePath,
				expectedDigest: "a".repeat(64),
			}),
		).resolves.toBeUndefined()
		expect(await fs.readdir(globalStoragePath)).toEqual([])
	})

	it("leaves a missing snapshot in an existing legacy task untouched", async () => {
		const taskDirectory = path.join(globalStoragePath, "tasks", "legacy-child")
		await fs.mkdir(taskDirectory, { recursive: true })
		await fs.writeFile(path.join(taskDirectory, "legacy.json"), "legacy history")

		await expect(
			readSubagentInstructionSnapshot({
				taskId: "legacy-child",
				globalStoragePath,
				expectedDigest: "a".repeat(64),
			}),
		).resolves.toBeUndefined()
		expect(await fs.readdir(taskDirectory)).toEqual(["legacy.json"])
	})

	it.each(["Frozen launch instructions", ""])(
		"does not rewrite an identical snapshot %j when launch persistence is retried",
		async (instructions) => {
			const options = {
				taskId: "child-1",
				globalStoragePath,
				instructions,
				expectedDigest: digestValue(instructions),
			}
			await saveSubagentInstructionSnapshot(options)
			vi.mocked(fs.rename).mockClear()

			await expect(saveSubagentInstructionSnapshot(options)).resolves.toBeUndefined()
			expect(fs.rename).not.toHaveBeenCalled()
		},
	)

	it("rejects a second instruction boundary for the same child without overwriting the first", async () => {
		const instructions = "Original frozen boundary"
		const expectedDigest = digestValue(instructions)
		await saveSubagentInstructionSnapshot({ taskId: "child-1", globalStoragePath, instructions, expectedDigest })
		const filePath = path.join(globalStoragePath, "tasks", "child-1", GlobalFileNames.subagentInstructionSnapshot)
		const original = await fs.readFile(filePath, "utf8")
		const changed = "Different valid frozen boundary"

		await expect(
			saveSubagentInstructionSnapshot({
				taskId: "child-1",
				globalStoragePath,
				instructions: changed,
				expectedDigest: digestValue(changed),
			}),
		).rejects.toThrow("snapshot is invalid")
		expect(await fs.readFile(filePath, "utf8")).toBe(original)
	})

	it("serializes competing child instruction boundaries so only one can own the durable snapshot", async () => {
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		let releaseCommit!: () => void
		let notifyCommit!: () => void
		const commitEntered = new Promise<void>((resolve) => (notifyCommit = resolve))
		const commitReleased = new Promise<void>((resolve) => (releaseCommit = resolve))
		vi.mocked(fs.rename).mockImplementationOnce(async (source, destination) => {
			notifyCommit()
			await commitReleased
			await actual.rename(source, destination)
		})
		const instructions = "First frozen boundary"
		const expectedDigest = digestValue(instructions)
		const first = saveSubagentInstructionSnapshot({
			taskId: "child-1",
			globalStoragePath,
			instructions,
			expectedDigest,
		})
		await commitEntered
		const changed = "Second frozen boundary"
		const second = saveSubagentInstructionSnapshot({
			taskId: "child-1",
			globalStoragePath,
			instructions: changed,
			expectedDigest: digestValue(changed),
		})
		const settled = Promise.allSettled([first, second])
		releaseCommit()
		const results = await settled

		expect(results.map(({ status }) => status)).toEqual(["fulfilled", "rejected"])
		await expect(
			readSubagentInstructionSnapshot({ taskId: "child-1", globalStoragePath, expectedDigest }),
		).resolves.toBe(instructions)
	})

	it("releases persistence ownership after a failed first commit so the same boundary can be retried", async () => {
		const instructions = "Frozen launch instructions"
		const options = {
			taskId: "child-1",
			globalStoragePath,
			instructions,
			expectedDigest: digestValue(instructions),
		}
		const failure = Object.assign(new Error("snapshot commit failed"), { code: "EIO" })
		vi.mocked(fs.rename).mockRejectedValueOnce(failure)

		await expect(saveSubagentInstructionSnapshot(options)).rejects.toBe(failure)
		expect(await fs.readdir(path.join(globalStoragePath, "tasks", "child-1"))).toEqual([])
		await expect(saveSubagentInstructionSnapshot(options)).resolves.toBeUndefined()
		await expect(readSubagentInstructionSnapshot(options)).resolves.toBe(instructions)
	})

	it.each(["read", "save"] as const)("rejects a redirected task directory during %s", async (operation) => {
		const redirectedDirectory = path.join(globalStoragePath, "redirected")
		const tasksDirectory = path.join(globalStoragePath, "tasks")
		await fs.mkdir(redirectedDirectory)
		await fs.mkdir(tasksDirectory)
		await fs.symlink(
			redirectedDirectory,
			path.join(tasksDirectory, "child-1"),
			process.platform === "win32" ? "junction" : "dir",
		)
		const instructions = "Frozen instructions"
		const options = {
			taskId: "child-1",
			globalStoragePath,
			instructions,
			expectedDigest: digestValue(instructions),
		}

		await expect(
			operation === "read" ? readSubagentInstructionSnapshot(options) : saveSubagentInstructionSnapshot(options),
		).rejects.toThrow("Task storage path")
		expect(await fs.readdir(redirectedDirectory)).toEqual([])
	})

	it.each(["read", "save"] as const)(
		"rejects a redirected tasks root before a missing child %s",
		async (operation) => {
			const redirectedDirectory = path.join(globalStoragePath, "redirected")
			await fs.mkdir(redirectedDirectory)
			await fs.symlink(
				redirectedDirectory,
				path.join(globalStoragePath, "tasks"),
				process.platform === "win32" ? "junction" : "dir",
			)
			const instructions = "Frozen instructions"
			const options = {
				taskId: "child-1",
				globalStoragePath,
				instructions,
				expectedDigest: digestValue(instructions),
			}

			await expect(
				operation === "read"
					? readSubagentInstructionSnapshot(options)
					: saveSubagentInstructionSnapshot(options),
			).rejects.toThrow("Task storage path")
			expect(await fs.readdir(redirectedDirectory)).toEqual([])
		},
	)

	it.each(["", " \n\t"])(
		"round-trips an exact blank instruction snapshot %j with a matching digest",
		async (instructions) => {
			const options = {
				taskId: "empty-child",
				globalStoragePath,
				instructions,
				expectedDigest: digestValue(instructions),
			}
			await expect(readSubagentInstructionSnapshot(options)).resolves.toBeUndefined()
			await saveSubagentInstructionSnapshot(options)
			await expect(readSubagentInstructionSnapshot(options)).resolves.toBe(instructions)
		},
	)

	it("preserves an empty boundary against a later nonempty instruction snapshot", async () => {
		const options = {
			taskId: "empty-child",
			globalStoragePath,
			instructions: "",
			expectedDigest: digestValue(""),
		}
		await saveSubagentInstructionSnapshot(options)
		const filePath = path.join(
			globalStoragePath,
			"tasks",
			"empty-child",
			GlobalFileNames.subagentInstructionSnapshot,
		)
		const original = await fs.readFile(filePath, "utf8")
		const replacement = "Later user instructions"

		await expect(
			saveSubagentInstructionSnapshot({
				...options,
				instructions: replacement,
				expectedDigest: digestValue(replacement),
			}),
		).rejects.toThrow("snapshot is invalid")
		expect(await fs.readFile(filePath, "utf8")).toBe(original)
		await expect(readSubagentInstructionSnapshot(options)).resolves.toBe("")
	})

	it("rejects an empty body that does not match the frozen digest before creating storage", async () => {
		await expect(
			saveSubagentInstructionSnapshot({
				taskId: "empty-child",
				globalStoragePath,
				instructions: "",
				expectedDigest: digestValue("Expected nonempty instructions"),
			}),
		).rejects.toThrow("failed integrity validation")
		expect(await fs.readdir(globalStoragePath)).toEqual([])
	})

	it("does not interpret a missing persisted instruction field as an empty snapshot", async () => {
		const expectedDigest = digestValue("")
		const taskDirectory = path.join(globalStoragePath, "tasks", "empty-child")
		await fs.mkdir(taskDirectory, { recursive: true })
		await fs.writeFile(
			path.join(taskDirectory, GlobalFileNames.subagentInstructionSnapshot),
			JSON.stringify({ version: 1, digest: expectedDigest }),
		)

		await expect(
			readSubagentInstructionSnapshot({ taskId: "empty-child", globalStoragePath, expectedDigest }),
		).rejects.toThrow("snapshot is invalid")
	})

	it("rejects a persisted empty body whose recorded digest belongs to nonempty instructions", async () => {
		const expectedDigest = digestValue("Expected nonempty instructions")
		const taskDirectory = path.join(globalStoragePath, "tasks", "empty-child")
		await fs.mkdir(taskDirectory, { recursive: true })
		await fs.writeFile(
			path.join(taskDirectory, GlobalFileNames.subagentInstructionSnapshot),
			JSON.stringify({ version: 1, digest: expectedDigest, instructions: "" }),
		)

		await expect(
			readSubagentInstructionSnapshot({ taskId: "empty-child", globalStoragePath, expectedDigest }),
		).rejects.toThrow("failed integrity validation")
	})

	it("fails closed when the persisted body no longer matches its frozen digest", async () => {
		const instructions = "Frozen instructions"
		const expectedDigest = digestValue(instructions)
		await saveSubagentInstructionSnapshot({
			taskId: "child-1",
			globalStoragePath,
			instructions,
			expectedDigest,
		})
		const filePath = path.join(globalStoragePath, "tasks", "child-1", GlobalFileNames.subagentInstructionSnapshot)
		await fs.writeFile(
			filePath,
			JSON.stringify({ version: 1, digest: expectedDigest, instructions: "Changed live instructions" }),
		)

		await expect(
			readSubagentInstructionSnapshot({ taskId: "child-1", globalStoragePath, expectedDigest }),
		).rejects.toThrow("failed integrity validation")
	})

	it("does not repair a corrupted snapshot by replacing it during a launch retry", async () => {
		const instructions = "Frozen instructions"
		const options = {
			taskId: "child-1",
			globalStoragePath,
			instructions,
			expectedDigest: digestValue(instructions),
		}
		await saveSubagentInstructionSnapshot(options)
		const filePath = path.join(globalStoragePath, "tasks", "child-1", GlobalFileNames.subagentInstructionSnapshot)
		const corrupted = JSON.stringify({ version: 1, digest: options.expectedDigest, instructions: "Tampered body" })
		await fs.writeFile(filePath, corrupted)

		await expect(saveSubagentInstructionSnapshot(options)).rejects.toThrow("failed integrity validation")
		expect(await fs.readFile(filePath, "utf8")).toBe(corrupted)
	})

	it.each([
		null,
		[],
		{ version: 2, digest: "a".repeat(64), instructions: "Frozen instructions" },
		{ version: 1, digest: "a".repeat(64), instructions: "Frozen instructions", source: "unexpected" },
		{ version: 1, instructions: "Frozen instructions" },
		{ version: 1, digest: "a".repeat(64), instructions: 42 },
	])("rejects an incompatible persisted snapshot shape %j", async (snapshot) => {
		const taskDirectory = path.join(globalStoragePath, "tasks", "child-1")
		await fs.mkdir(taskDirectory, { recursive: true })
		await fs.writeFile(
			path.join(taskDirectory, GlobalFileNames.subagentInstructionSnapshot),
			JSON.stringify(snapshot),
		)

		await expect(
			readSubagentInstructionSnapshot({ taskId: "child-1", globalStoragePath, expectedDigest: "a".repeat(64) }),
		).rejects.toThrow("snapshot is invalid")
	})

	it("rejects a symbolic snapshot instead of following its body", async () => {
		const instructions = "Frozen instructions"
		const options = {
			taskId: "child-1",
			globalStoragePath,
			instructions,
			expectedDigest: digestValue(instructions),
		}
		await saveSubagentInstructionSnapshot(options)
		const filePath = path.join(globalStoragePath, "tasks", "child-1", GlobalFileNames.subagentInstructionSnapshot)
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		const stats = await actual.lstat(filePath)
		vi.spyOn(stats, "isSymbolicLink").mockReturnValue(true)
		vi.mocked(fs.lstat).mockImplementation(async (candidate, options) =>
			candidate === filePath ? stats : actual.lstat(candidate, options),
		)

		await expect(readSubagentInstructionSnapshot(options)).rejects.toThrow("snapshot is invalid")
		await expect(saveSubagentInstructionSnapshot(options)).rejects.toThrow("snapshot is invalid")
	})

	it("fails closed on an inaccessible snapshot rather than treating it as a legacy child", async () => {
		const instructions = "Frozen instructions"
		const options = {
			taskId: "child-1",
			globalStoragePath,
			instructions,
			expectedDigest: digestValue(instructions),
		}
		await saveSubagentInstructionSnapshot(options)
		const filePath = path.join(globalStoragePath, "tasks", "child-1", GlobalFileNames.subagentInstructionSnapshot)
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		vi.mocked(fs.lstat).mockImplementation(async (candidate, options) => {
			if (candidate === filePath) throw Object.assign(new Error("permission denied"), { code: "EACCES" })
			return actual.lstat(candidate, options)
		})

		await expect(readSubagentInstructionSnapshot(options)).rejects.toThrow("snapshot is unreadable")
		await expect(saveSubagentInstructionSnapshot(options)).rejects.toThrow("snapshot is unreadable")
	})
})
