import fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { describe, expect, it, vi } from "vitest"
import { parse, stringify } from "yaml"

import { loadProblemSolvingSet } from "../problemSolving"
import { runProblemSolvingAttempt } from "../problemSolvingCampaign"

const evalRoot = path.resolve(process.cwd(), "../../evals")
const repositoryRoot = path.resolve(process.cwd(), "../..")

async function withCopiedBank(run: (root: string, copiedEvalRoot: string) => Promise<void>): Promise<void> {
	const parent = await fs.realpath(os.tmpdir())
	const root = await fs.mkdtemp(path.join(parent, "alpha-bank-fixture-identity-"))
	try {
		const manifest = await loadProblemSolvingSet(evalRoot)
		const subset = {
			...manifest,
			tasks: manifest.tasks.filter(({ source, lane }) => source !== "alpha-task-bank" || lane !== "development"),
		}
		const suiteSource = await fs.readFile(path.join(evalRoot, "frontier-v1.yaml"), "utf8")
		const suite = parse(suiteSource) as { tasks: Array<{ id: string; fixture: string }> }
		const copiedEvalRoot = path.join(root, "evals")
		await fs.mkdir(path.join(copiedEvalRoot, "problem-solving"), { recursive: true })
		await fs.writeFile(path.join(copiedEvalRoot, "frontier-v1.yaml"), suiteSource)
		await fs.writeFile(path.join(copiedEvalRoot, "problem-solving", "v1.yaml"), stringify(subset))
		for (const task of subset.tasks) {
			if (task.source === "terminal-bench" || task.lane === "holdout") continue
			const fixture = task.fixture ?? suite.tasks.find(({ id }) => id === task.id)!.fixture
			await fs.cp(path.join(evalRoot, fixture), path.join(copiedEvalRoot, fixture), {
				recursive: true,
				filter: (source) => !["node_modules", ".git"].includes(path.basename(source)),
			})
		}
		await run(root, copiedEvalRoot)
	} finally {
		await removeCopiedBank(root, parent)
	}
}

async function removeCopiedBank(root: string, parent: string): Promise<void> {
	const canonical = await fs.realpath(root)
	if (path.dirname(canonical) !== parent || !path.basename(canonical).startsWith("alpha-bank-fixture-identity-"))
		throw new Error("Bank identity fixture cleanup ownership mismatch")
	await fs.rm(canonical, { recursive: true, force: true })
}

function attempt(root: string, copiedEvalRoot: string) {
	return {
		evalRoot: copiedEvalRoot,
		repositoryRoot,
		taskId: "repo-cache-invalidation",
		attemptRoot: path.join(root, "attempts"),
		attemptId: "fixture-identity",
		hostVersion: "1.138.0",
		provider: "live-copilot" as const,
		modelId: "controlled-model",
		effort: "high",
		runExtension: vi.fn(async () => ({
			phase: "sample" as const,
			status: "passed" as const,
			buildIdentity: "controlled-build",
			modelId: "controlled-model",
			effort: "high",
			usage: { requests: 0, cost: null, inputTokens: null, outputTokens: null },
		})),
	}
}

describe("problem-solving public fixture identity", () => {
	it("admits pristine bank bytes while its untouched broken implementation still fails acceptance", async () => {
		await withCopiedBank(async (root, copiedEvalRoot) => {
			const manifest = await loadProblemSolvingSet(copiedEvalRoot)
			expect(
				manifest.tasks.filter(({ source, lane }) => source === "alpha-task-bank" && lane === "holdout"),
			).toHaveLength(12)
			const options = attempt(root, copiedEvalRoot)
			const report = await runProblemSolvingAttempt(options)
			expect(options.runExtension).toHaveBeenCalledOnce()
			expect(report).toMatchObject({ countsAsSolving: false, graderDecision: "outcome_failed" })
		})
	})

	it.each(["source", "verifier"])("rejects tampered bank %s before dispatch", async (changed) => {
		await withCopiedBank(async (root, copiedEvalRoot) => {
			const fixture = path.join(copiedEvalRoot, "javascript", "repo-cache-invalidation")
			if (changed === "source") await fs.appendFile(path.join(fixture, "src", "cache.js"), "\n// changed input\n")
			else
				await fs.writeFile(
					path.join(fixture, "test", "behavior.test.js"),
					'import test from "node:test"; import assert from "node:assert/strict"; test("vacuous", () => { assert.equal(1, 1); assert.equal(2, 2) })\n',
				)
			const options = attempt(root, copiedEvalRoot)
			await expect(runProblemSolvingAttempt(options)).rejects.toThrow(/fixture digest mismatch/)
			expect(options.runExtension).not.toHaveBeenCalled()
		})
	})

	it.each(["source", "verifier"])("rejects bank %s changed at the copy boundary", async (changed) => {
		await withCopiedBank(async (root, copiedEvalRoot) => {
			const options = attempt(root, copiedEvalRoot)
			const workspace = path.join(options.attemptRoot, options.attemptId, "workspace")
			const copy = fs.cp
			const spy = vi.spyOn(fs, "cp").mockImplementation(async (source, destination, copyOptions) => {
				await copy(source, destination, copyOptions)
				if (destination !== workspace) return
				const relative = changed === "source" ? "src/cache.js" : "test/behavior.test.js"
				await fs.appendFile(path.join(workspace, relative), "\n// changed during copy\n")
			})
			try {
				await expect(runProblemSolvingAttempt(options)).rejects.toThrow(/fixture digest mismatch/)
				expect(options.runExtension).not.toHaveBeenCalled()
			} finally {
				spy.mockRestore()
			}
		})
	})

	it("rejects a bank fixture override even when the alternate directory has identical bytes", async () => {
		await withCopiedBank(async (root, copiedEvalRoot) => {
			const fixture = "javascript/repo-cache-invalidation"
			const alternate = "javascript/alternate-cache"
			await fs.cp(path.join(copiedEvalRoot, fixture), path.join(copiedEvalRoot, alternate), { recursive: true })
			const filename = path.join(copiedEvalRoot, "problem-solving", "v1.yaml")
			const manifest = await loadProblemSolvingSet(copiedEvalRoot)
			manifest.tasks.find(({ id }) => id === "repo-cache-invalidation")!.fixture = alternate
			await fs.writeFile(filename, stringify(manifest))
			const options = attempt(root, copiedEvalRoot)
			await expect(runProblemSolvingAttempt(options)).rejects.toThrow(/fixture path does not match/)
			expect(options.runExtension).not.toHaveBeenCalled()
		})
	})

	it.each(["fixture-root", "nested-directory"])("rejects symbolic %s metadata before dispatch", async (linked) => {
		await withCopiedBank(async (root, copiedEvalRoot) => {
			const fixture = path.join(copiedEvalRoot, "javascript", "repo-cache-invalidation")
			const target = linked === "fixture-root" ? fixture : path.join(fixture, "test")
			const stat = fs.lstat
			const spy = vi.spyOn(fs, "lstat").mockImplementation(async (source, statOptions) => {
				const metadata = await stat(source, statOptions)
				if (source !== target) return metadata
				return Object.assign(metadata, { isSymbolicLink: () => true })
			})
			const options = attempt(root, copiedEvalRoot)
			try {
				await expect(runProblemSolvingAttempt(options)).rejects.toThrow(/symbolic links/)
				expect(options.runExtension).not.toHaveBeenCalled()
			} finally {
				spy.mockRestore()
			}
		})
	})
})
