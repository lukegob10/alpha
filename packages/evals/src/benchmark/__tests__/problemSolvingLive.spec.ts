import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { extensionBundleDigest, runLiveProblemSolvingCore } from "../problemSolvingLive"

const evalRoot = path.resolve(process.cwd(), "../../evals")
const repositoryRoot = path.resolve(process.cwd(), "../..")
const roots: string[] = []

async function root() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-live-runner-"))
	roots.push(directory)
	return directory
}

function options(attemptRoot: string, overrides: Partial<Parameters<typeof runLiveProblemSolvingCore>[0]> = {}) {
	return {
		evalRoot,
		repositoryRoot,
		attemptRoot,
		profileDir: path.join(attemptRoot, "profile"),
		taskIds: ["alpha-pr-comparison"],
		...overrides,
	}
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe("live problem-solving runner configuration", () => {
	it("fingerprints the extension bundle selected by the VS Code development host", async () => {
		const repository = await root()
		const bundlePath = path.join(repository, "src", "dist", "extension.js")
		const bundle = Buffer.from("extension bundle bytes")
		await fs.mkdir(path.dirname(bundlePath), { recursive: true })
		await fs.writeFile(bundlePath, bundle)

		expect(await extensionBundleDigest(repository)).toBe(createHash("sha256").update(bundle).digest("hex"))
	})

	it("keeps Terminal-Bench and holdout tasks out of local live grading", async () => {
		const parent = await root()
		const attemptRoot = path.join(parent, "run")
		await expect(
			runLiveProblemSolvingCore(options(attemptRoot, { taskIds: ["session-window-debug"] })),
		).rejects.toThrow("not eligible for live local grading")
		await expect(fs.stat(attemptRoot)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("rejects invalid repetition settings before creating a run directory", async () => {
		const parent = await root()
		const attemptRoot = path.join(parent, "run")
		await expect(runLiveProblemSolvingCore(options(attemptRoot, { repetitions: 4 }))).rejects.toThrow(
			"repetitions must be from 1 to 3",
		)
		await expect(fs.stat(attemptRoot)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("refuses to reuse a run directory and preserves its contents", async () => {
		const parent = await root()
		const attemptRoot = path.join(parent, "existing-run")
		await fs.mkdir(attemptRoot)
		await fs.writeFile(path.join(attemptRoot, "sentinel"), "preserve")
		await expect(
			runLiveProblemSolvingCore(
				options(attemptRoot, { repositoryRoot: path.join(parent, "missing-repository") }),
			),
		).rejects.toMatchObject({ code: "EEXIST" })
		expect(await fs.readFile(path.join(attemptRoot, "sentinel"), "utf8")).toBe("preserve")
	})
})
