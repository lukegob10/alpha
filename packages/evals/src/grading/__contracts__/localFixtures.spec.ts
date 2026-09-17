import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { describe, expect, it } from "vitest"

import { loadBenchmarkCatalog } from "../../benchmark/index"
import { ExecaHarnessProcessRunner, systemClock } from "../../orchestration/index"
import { createDefaultGraderRegistry, type CommandGraderSpec } from "../index"

const evalRoot = path.resolve(process.cwd(), "../../evals")
const calibrationRoot = path.resolve(process.cwd(), "src/grading/__fixtures__/gold")

async function readyFixtures(): Promise<Array<{ id: string; fixture: string }>> {
	const catalog = await loadBenchmarkCatalog(evalRoot)
	return [...catalog.tasks.values()]
		.map(({ task }) => task)
		.filter(({ partition, admission }) => partition === "smoke" && admission === "admitted")
		.map(({ id, fixture }) => ({ id, fixture }))
}

function spec(id: string): CommandGraderSpec {
	return {
		id: `${id}.visible-tests`,
		version: 1,
		type: "command",
		hardGate: true,
		failureClass: "outcome",
		commands: [{ command: "pnpm", args: ["test"] }],
		cwd: "workspace",
		timeoutMs: 30_000,
		maxOutputBytes: 256_000,
	}
}

describe("local ready eval fixtures", () => {
	it("reproduces the declared initial visible-test baseline for every ready task fixture", async () => {
		const fixtures = await readyFixtures()
		expect(fixtures).toHaveLength(8)
		for (const fixture of fixtures) {
			const result = await createDefaultGraderRegistry().execute([spec(fixture.id)], {
				workspaceRoot: path.join(evalRoot, fixture.fixture),
				changedPaths: [],
				trace: [],
				processRunner: new ExecaHarnessProcessRunner(),
				clock: systemClock,
			})
			expect(result.decision, fixture.id).toBe("outcome_failed")
		}
	})

	it("passes the known-good calibration solution twenty consecutive times", async () => {
		for (let iteration = 0; iteration < 20; iteration++) {
			const result = await createDefaultGraderRegistry().execute([spec("calibration-gold")], {
				workspaceRoot: calibrationRoot,
				changedPaths: [],
				trace: [],
				processRunner: new ExecaHarnessProcessRunner(),
				clock: systemClock,
			})
			expect(result.decision).toBe("passed")
		}
	})

	it("fails a deliberately broken copy for the intended command reason", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-broken-eval-"))
		try {
			await fs.cp(calibrationRoot, tempRoot, { recursive: true })
			await fs.writeFile(path.join(tempRoot, "src/sum.js"), "export function sum() { return 0 }\n")
			const result = await createDefaultGraderRegistry().execute([spec("broken-calibration")], {
				workspaceRoot: tempRoot,
				changedPaths: ["src/sum.js"],
				trace: [],
				processRunner: new ExecaHarnessProcessRunner(),
				clock: systemClock,
			})
			expect(result.decision).toBe("outcome_failed")
			expect(result.results[0]!.diagnostics[0]).toMatchObject({ code: "command_exit_nonzero" })
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true })
		}
	})
})
