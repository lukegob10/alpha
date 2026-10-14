import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { ExecaHarnessProcessRunner } from "../../orchestration/index"

import {
	extensionBundleDigest,
	launchExtension,
	orderProblemSolvingPromptVariants,
	runLiveProblemSolvingCore,
} from "../problemSolvingLive"

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
	vi.restoreAllMocks()
	await Promise.all(roots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe("live problem-solving runner configuration", () => {
	it("retains request purposes and provider failure attribution through the actual receipt reader", async () => {
		const directory = await root()
		const request = {
			workspace: directory,
			profileDir: path.join(directory, "profile"),
			artifactsDir: path.join(directory, "artifacts"),
			runId: "receipt-handoff",
			requestLimit: 40,
			provider: "live-copilot" as const,
			modelId: "model",
			effort: "high",
			hostVersion: "1.125.0",
			taskId: "fixture",
			promptPath: path.join(directory, "prompt.md"),
		}
		vi.spyOn(ExecaHarnessProcessRunner.prototype, "run").mockImplementation(async () => {
			const receiptDir = path.join(request.artifactsDir, request.runId)
			await fs.mkdir(receiptDir, { recursive: true })
			await fs.writeFile(
				path.join(receiptDir, "workflow-result.json"),
				JSON.stringify({
					status: "failed",
					requestsUsed: 7,
					requestsByPurpose: { task: 5, "reasoning-summary": 2 },
					failure: { category: "lifecycle", code: "unexpected_resume_task", providerCode: "request_timeout" },
				}),
			)
			return { exitCode: 0, timedOut: false, stdout: "", stderr: "", durationMs: 0, outputTruncated: false }
		})
		const host = await launchExtension(request, repositoryRoot, "frozen-build")
		expect(host.usage).toMatchObject({ requests: 7, taskRequests: 5, summaryRequests: 2 })
		expect(host.failureCode).toBe("unexpected_resume_task")
		expect(host.providerFailureCode).toBe("request_timeout")
	})

	it("balances prompt-arm order across repetitions", () => {
		expect(orderProblemSolvingPromptVariants(["baseline", "single-command"], 1)).toEqual([
			"baseline",
			"single-command",
		])
		expect(orderProblemSolvingPromptVariants(["baseline", "single-command"], 2)).toEqual([
			"single-command",
			"baseline",
		])
		expect(orderProblemSolvingPromptVariants(["baseline"], 2)).toEqual(["baseline"])
	})

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

	it("rejects duplicate prompt arms before creating a run directory", async () => {
		const parent = await root()
		const attemptRoot = path.join(parent, "run")
		await expect(
			runLiveProblemSolvingCore(options(attemptRoot, { promptVariants: ["baseline", "baseline"] })),
		).rejects.toThrow("prompt variants must be unique")
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
