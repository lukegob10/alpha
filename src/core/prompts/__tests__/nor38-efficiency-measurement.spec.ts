import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"

import { DEFAULT_MODES } from "../../../../packages/types/src/mode"
import { countTokens } from "../../../utils/countTokens"
import { getObjectiveSection } from "../sections/objective"
import { getRulesSection } from "../sections/rules"
import { getSharedToolUseSection } from "../sections/tool-use"
import { getToolUseGuidelinesSection } from "../sections/tool-use-guidelines"
import attemptCompletion from "../tools/native-tools/attempt_completion"
import updateTodoList from "../tools/native-tools/update_todo_list"

vi.mock("../../../utils/shell", () => ({ getShell: () => "/bin/bash" }))

const root = path.resolve(__dirname, "../../../..")
const digest = (value: string) => createHash("sha256").update(value).digest("hex")

describe("NOR38 emitted workflow prompt measurement", () => {
	it("records production workflow sections and schema bytes without a model or filesystem discovery", async () => {
		const codeInstructions = DEFAULT_MODES.find((mode) => mode.slug === "code")?.customInstructions
		expect(codeInstructions).toBeTruthy()
		const sections = {
			objective: getObjectiveSection(),
			rules: getRulesSection("/public-fixture"),
			toolUse: getSharedToolUseSection(),
			toolUseGuidelines: getToolUseGuidelinesSection(),
			codeInstructions: codeInstructions!,
			completionSchema: JSON.stringify(attemptCompletion),
			todoSchema: JSON.stringify(updateTodoList),
		}
		const samples = []
		for (const [section, text] of Object.entries(sections)) {
			samples.push({
				section,
				bytes: Buffer.byteLength(text),
				localTokenEstimate: await countTokens([{ type: "text", text }], { useWorker: false }),
				digest: digest(text),
			})
		}
		const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
		const report = {
			schemaVersion: 1,
			benchmark: "nor38-emitted-workflow-sections",
			revision: git("rev-parse", "HEAD"),
			workingTree: git("status", "--porcelain") ? "modified" : "clean",
			node: process.version,
			harnessDigest: digest(await fs.readFile(__filename, "utf8")),
			configuration: "primary-code-no-delegation-overrides-public-workspace-bash-v1",
			boundary:
				"Production section functions and two native tool schemas; excludes complete system prompt and history",
			tokenMethod: "Alpha local o200k_base estimator with 1.5 safety multiplier per section; not provider usage",
			providerTokens: null,
			providerRequests: 0,
			timeToUsefulAnswerMs: null,
			samples,
			totalBytes: samples.reduce((total, sample) => total + sample.bytes, 0),
			totalLocalTokenEstimate: samples.reduce((total, sample) => total + sample.localTokenEstimate, 0),
		}
		expect(report.samples).toHaveLength(7)
		expect(report.samples.every((sample) => sample.bytes > 0 && sample.localTokenEstimate > 0)).toBe(true)
		// Predeclared against unchanged 90bb4ea: 15,318 bytes and 4,247 local tokens for these exact seven parts.
		// This guards prompt size; the owning tests separately guard coverage, authority, and completion semantics.
		expect(report.totalBytes).toBeLessThanOrEqual(Math.floor(15_318 * 0.9))
		expect(report.totalLocalTokenEstimate).toBeLessThanOrEqual(4_247)
		if (process.env.ALPHA_NOR38_PROMPT_REPORT) {
			await fs.writeFile(process.env.ALPHA_NOR38_PROMPT_REPORT, `${JSON.stringify(report, null, 2)}\n`)
		}
	})
})
