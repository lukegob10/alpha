import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { FilesystemArtifactStore } from "../../evidence/artifactStore"
import { EVALS_REPO_PATH } from "../../exercises/index"
import { loadCertificationSuite, runCertificationScenario } from "../runner"

const roots: string[] = []

async function scenario() {
	const suite = await loadCertificationSuite(path.join(EVALS_REPO_PATH, "certification", "suite.json"))
	const make = fs.mkdtemp.bind(fs)
	vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix) => {
		const root = await make(prefix)
		roots.push(root)
		return root
	})
	return suite.scenarios.find(({ kind }) => kind === "known_pass")!
}

afterEach(async () => {
	vi.restoreAllMocks()
	for (const root of roots.splice(0)) {
		const resolved = path.resolve(root)
		if (
			path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
			!path.basename(resolved).startsWith("alpha-cert-known-pass-")
		)
			throw new Error("Unexpected certification fixture cleanup path")
		await fs.rm(resolved, { recursive: true, force: true })
	}
})

describe("certification temporary evidence ownership", () => {
	it("removes its evidence directory after successful certification", async () => {
		const input = await scenario()
		await expect(runCertificationScenario(input)).resolves.toMatchObject({ terminalStatus: "passed" })
		expect(roots).toHaveLength(1)
		await expect(fs.stat(roots[0]!)).rejects.toHaveProperty("code", "ENOENT")
	})

	it.each(["put", "get"] as const)("removes its evidence directory when artifact %s fails", async (method) => {
		const input = await scenario()
		const failure = new Error(`fixture artifact ${method} failed`)
		vi.spyOn(FilesystemArtifactStore.prototype, method).mockRejectedValueOnce(failure)

		await expect(runCertificationScenario(input)).rejects.toBe(failure)
		expect(roots).toHaveLength(1)
		await expect(fs.stat(roots[0]!)).rejects.toHaveProperty("code", "ENOENT")
	})

	it("retains both the evidence failure and cleanup failure", async () => {
		const input = await scenario()
		const failure = new Error("fixture evidence collection failed")
		const cleanup = new Error("fixture evidence cleanup failed")
		vi.spyOn(FilesystemArtifactStore.prototype, "put").mockRejectedValueOnce(failure)
		vi.spyOn(fs, "rm").mockRejectedValueOnce(cleanup)

		await expect(runCertificationScenario(input)).rejects.toMatchObject({
			name: "AggregateError",
			cause: failure,
			errors: [failure, cleanup],
		})
	})

	it("reports cleanup failure after otherwise successful evidence capture", async () => {
		const input = await scenario()
		const cleanup = new Error("fixture evidence cleanup failed")
		const remove = fs.rm.bind(fs)
		vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
			if (roots.includes(String(target))) throw cleanup
			return remove(target, options)
		})

		await expect(runCertificationScenario(input)).rejects.toBe(cleanup)
	})
})
