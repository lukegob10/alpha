import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

import { sha256 } from "../../evidence/canonical"
import { createTaskTemplate } from "../templates"
import { digestBenchmarkDirectory, loadPrivateGraderBundle } from "../loader"

describe("private grader execution identity", () => {
	it("rejects a private root that contains the public benchmark tree", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-bundle-overlap-"))
		const previous = process.env.ALPHA_EVALS_REPO_PATH
		try {
			const publicRoot = path.join(root, "public")
			await fs.mkdir(publicRoot)
			process.env.ALPHA_EVALS_REPO_PATH = publicRoot
			const task = {
				...createTaskTemplate({ id: "task", profile: "compact" }),
				graders: [
					{
						id: "private",
						version: 1,
						alias: "hidden_tests",
						bundleId: "private",
						bundleVersion: 1,
						bundleDigest: sha256("expected"),
					},
				],
			}
			await expect(loadPrivateGraderBundle(task, root)).rejects.toThrow("disjoint")
		} finally {
			if (previous === undefined) delete process.env.ALPHA_EVALS_REPO_PATH
			else process.env.ALPHA_EVALS_REPO_PATH = previous
			await fs.rm(root, { recursive: true, force: true })
		}
	})

	it.each([1, 2] as const)(
		"binds schema %s to public bytes and executes a retained snapshot",
		async (schemaVersion) => {
			const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "private-bundle-identity-"))
			const bundleRoot = path.join(privateRoot, "private-bundle")
			const relative = "task/hidden.cjs"
			const original = "module.exports = 'original'\n"
			await fs.mkdir(path.dirname(path.join(bundleRoot, relative)), { recursive: true })
			await fs.writeFile(path.join(bundleRoot, relative), original)
			const entryDigest = sha256(original)
			const expected =
				schemaVersion === 1 ? await digestBenchmarkDirectory(bundleRoot) : sha256(`${relative}\0${entryDigest}`)
			const manifest = {
				schemaVersion,
				id: "private-bundle",
				version: 1,
				readOnly: true,
				...(schemaVersion === 1
					? { digest: expected, runtimeImageDigest: sha256("runtime") }
					: { contentDigest: expected, network: false, diagnostics: "bounded-decision-codes-only" }),
				graders: [
					{
						id: "task.private",
						version: 1,
						entrypoint: relative,
						...(schemaVersion === 2 ? { digest: entryDigest } : {}),
					},
				],
			}
			const task = {
				...createTaskTemplate({ id: "task", profile: "compact" }),
				graders: [
					{
						id: "private",
						version: 1,
						alias: "hidden_tests",
						bundleId: "private-bundle",
						bundleVersion: 1,
						bundleDigest: expected,
					},
				],
			}
			await fs.writeFile(path.join(bundleRoot, "bundle.json"), JSON.stringify(manifest))
			let admitted: Awaited<ReturnType<typeof loadPrivateGraderBundle>>
			try {
				admitted = await loadPrivateGraderBundle(task, privateRoot)
				expect(admitted!.contentDigest).toBe(expected)
				expect(admitted!.root).not.toBe(bundleRoot)
				// A same-version replacement after verification cannot alter the executed snapshot.
				await fs.writeFile(path.join(bundleRoot, relative), "module.exports = 'replacement'\n")
				expect(await fs.readFile(path.join(admitted!.root, relative), "utf8")).toBe(original)
				expect(createRequire(import.meta.url)(path.join(admitted!.root, relative))).toBe("original")
				const replacementEntry = sha256(await fs.readFile(path.join(bundleRoot, relative)))
				const replacementDigest =
					schemaVersion === 1
						? await import("../fixtureDigest.mjs").then(({ fixtureTreeDigest }) =>
								fixtureTreeDigest([
									{ path: relative, bytes: Buffer.from("module.exports = 'replacement'\n") },
								]),
							)
						: sha256(`${relative}\0${replacementEntry}`)
				const replacement = {
					...manifest,
					...(schemaVersion === 1 ? { digest: replacementDigest } : { contentDigest: replacementDigest }),
					graders: [{ ...manifest.graders[0], ...(schemaVersion === 2 ? { digest: replacementEntry } : {}) }],
				}
				await fs.writeFile(path.join(bundleRoot, "bundle.json"), JSON.stringify(replacement))
				await expect(loadPrivateGraderBundle(task, privateRoot)).rejects.toThrow("public expected digest")
			} finally {
				await admitted?.dispose()
				await fs.rm(privateRoot, { recursive: true, force: true })
			}
		},
	)
})
