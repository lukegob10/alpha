import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { AgentControlState } from "@alpha-code/types"

import { FileAgentControlPersistence } from "../AgentControlStore"
import type { AgentControlTransactionDiagnostic } from "../AgentControlTransaction"

interface ReleaseInternals {
	readTransactionLock(lockPath: string): Promise<unknown>
	renameTransactionLock(source: string, destination: string): Promise<void>
	markTransactionLockReleased(token: string): Promise<void>
	releaseTransactionLock(token: string, diagnostic?: AgentControlTransactionDiagnostic): Promise<void>
}

const state: AgentControlState = {
	version: 2,
	updatedAt: 1,
	nextSequence: 1,
	agents: [],
	tombstones: [],
	mailbox: [],
	mailboxCursors: {},
	verificationObligations: [],
}

describe("FileAgentControlPersistence release failure diagnostics", () => {
	let directory: string
	let persistence: FileAgentControlPersistence
	let internals: ReleaseInternals
	let diagnostics: AgentControlTransactionDiagnostic[]

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-control-release-diagnostic-"))
		diagnostics = []
		persistence = new FileAgentControlPersistence(directory, {
			onTransactionDiagnostic: (diagnostic) => diagnostics.push({ ...diagnostic }),
		})
		internals = persistence as unknown as ReleaseInternals
		vi.spyOn(console, "warn").mockImplementation(() => undefined)
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("reports an owner-read failure without rejecting an already committed write", async () => {
		const failure = Object.assign(new Error("Owner metadata read failed"), { code: "EIO" })

		await expect(
			persistence.withTransaction(async () => {
				await persistence.write(state)
				vi.spyOn(internals, "readTransactionLock").mockRejectedValueOnce(failure)
			}),
		).resolves.toBeUndefined()

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]).toMatchObject({
			outcome: "success",
			committed: true,
			releaseFailed: true,
			releaseFailurePhase: "owner-read",
			releaseFailureCode: "EIO",
		})
		expect(await persistence.read()).toEqual(state)
	})

	it("retains the exhausted rename phase when release-marker publication succeeds", async () => {
		const failure = Object.assign(new Error("Release rename denied"), { code: "EPERM" })
		vi.spyOn(internals, "renameTransactionLock").mockRejectedValue(failure)
		const marker = vi.spyOn(internals, "markTransactionLockReleased")

		await expect(persistence.write(state)).resolves.toBeUndefined()

		expect(marker).toHaveBeenCalledOnce()
		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]).toMatchObject({
			outcome: "success",
			committed: true,
			releaseFailed: true,
			releaseFailurePhase: "rename",
			releaseFailureCode: "EPERM",
		})
	})

	it("reports release-marker failure when publication also fails after denied rename", async () => {
		vi.spyOn(internals, "renameTransactionLock").mockRejectedValue(
			Object.assign(new Error("Release rename denied"), { code: "EPERM" }),
		)
		vi.spyOn(internals, "markTransactionLockReleased").mockRejectedValue(
			Object.assign(new Error("Release marker could not be written"), { code: "ENOSPC" }),
		)

		await expect(persistence.write(state)).resolves.toBeUndefined()

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]).toMatchObject({
			outcome: "success",
			committed: true,
			releaseFailed: true,
			releaseFailurePhase: "release-marker",
			releaseFailureCode: "ENOSPC",
		})
	})

	it("uses unknown for an unclassified release failure without exposing arbitrary error content", async () => {
		const sensitive = "private-task-content-and-path"
		const failure = Object.assign(new Error(sensitive), { code: sensitive, path: sensitive, syscall: sensitive })
		vi.spyOn(internals, "releaseTransactionLock").mockRejectedValue(failure)

		await expect(persistence.write(state)).resolves.toBeUndefined()

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]).toMatchObject({
			outcome: "success",
			committed: true,
			releaseFailed: true,
			releaseFailurePhase: "unknown",
			releaseFailureCode: "unknown",
		})
		expect(JSON.stringify(diagnostics)).not.toContain(sensitive)
	})

	it("omits optional failure fields after successful release", async () => {
		await persistence.write(state)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]).toMatchObject({ outcome: "success", committed: true, releaseFailed: false })
		expect(diagnostics[0]).not.toHaveProperty("releaseFailurePhase")
		expect(diagnostics[0]).not.toHaveProperty("releaseFailureCode")
	})
})
