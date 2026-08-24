import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { digestValue } from "../../agent/StepContext"
import { GlobalFileNames } from "../../../shared/globalFileNames"
import { readSubagentInstructionSnapshot, saveSubagentInstructionSnapshot } from "../subagentInstructionSnapshot"

describe("managed-child frozen instruction snapshot persistence", () => {
	let globalStoragePath: string

	beforeEach(async () => {
		globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-subagent-instructions-"))
	})

	afterEach(async () => {
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
	})

	it("rejects an empty instruction layer instead of marking it as system-placed", async () => {
		const instructions = " \n\t"
		await expect(
			saveSubagentInstructionSnapshot({
				taskId: "empty-child",
				globalStoragePath,
				instructions,
				expectedDigest: digestValue(instructions),
			}),
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
})
