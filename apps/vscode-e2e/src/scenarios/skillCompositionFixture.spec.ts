import { strict as assert } from "node:assert"
import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"

import {
	SKILL_COMPOSITION_FILES,
	SKILL_COMPOSITION_PROMPT,
	SKILL_COMPOSITION_READ_COMMANDS,
	SKILL_COMPOSITION_READ_PATHS,
	SKILL_COMPOSITION_READ_SCRIPT,
} from "./skillCompositionFixture"

const execute = promisify(execFile)

async function withFixture(operation: (root: string) => Promise<void>): Promise<void> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-skill-composition-")))
	try {
		for (const [relative, content] of Object.entries(SKILL_COMPOSITION_FILES)) {
			const file = path.join(root, relative)
			await fs.mkdir(path.dirname(file), { recursive: true })
			await fs.writeFile(file, content, { flag: "wx" })
		}
		await operation(root)
	} finally {
		assert.equal(await fs.realpath(root), root)
		assert.match(path.basename(root), /^alpha-skill-composition-/)
		await fs.rm(root, { recursive: true, force: true })
	}
}

test("both skills expose the patch and read contracts enforced by live verification", () => {
	assert.match(
		SKILL_COMPOSITION_PROMPT,
		/Use apply_patch to create both live-skills\/prepared\.txt and live-skills\/final\.txt/,
	)
	for (const [skill, output] of [
		["harness-prepare", "prepared.txt"],
		["harness-finish", "final.txt"],
	]) {
		const instructions = SKILL_COMPOSITION_FILES[`.alpha/skills/${skill}/SKILL.md`]!
		assert.ok(instructions.includes(`Use apply_patch to create live-skills/${output}`))
		assert.match(instructions, /relative to the workspace root/)
		assert.match(instructions, /Do not create or modify outputs through exec_command/)
	}
	assert.deepEqual(SKILL_COMPOSITION_READ_COMMANDS, [
		`node ${SKILL_COMPOSITION_READ_SCRIPT} .alpha/skills/harness-prepare/seed.txt`,
		`node ${SKILL_COMPOSITION_READ_SCRIPT} live-skills/prepared.txt`,
		`node ${SKILL_COMPOSITION_READ_SCRIPT} live-skills/final.txt`,
	])
	for (const [index, command] of SKILL_COMPOSITION_READ_COMMANDS.entries())
		assert.ok(
			Object.values(SKILL_COMPOSITION_FILES).some((content) => content.includes(command)),
			String(index),
		)
})

test("the prepared read script returns each approved file's exact bytes without changing fixture sources", async () => {
	await withFixture(async (root) => {
		const outputs = {
			"live-skills/prepared.txt": "ALPHA_WORKFLOW_SEED\n",
			"live-skills/final.txt": "ALPHA_WORKFLOW_SEED\nFINISHED\n",
		}
		for (const [relative, content] of Object.entries(outputs))
			await fs.writeFile(path.join(root, relative), content, { flag: "wx" })
		for (const file of SKILL_COMPOSITION_READ_PATHS) {
			const result = await execute(process.execPath, [SKILL_COMPOSITION_READ_SCRIPT, file], {
				cwd: root,
				windowsHide: true,
			})
			assert.equal(result.stderr, "")
			assert.equal(result.stdout, await fs.readFile(path.join(root, file), "utf8"))
		}
		for (const [relative, content] of Object.entries({ ...SKILL_COMPOSITION_FILES, ...outputs }))
			assert.equal(await fs.readFile(path.join(root, relative), "utf8"), content)
	})
})

test("the read script rejects missing, extra, traversal, absolute, and unrelated arguments", async () => {
	await withFixture(async (root) => {
		await fs.writeFile(path.join(root, "private.txt"), "MUST_NOT_BE_READ", { flag: "wx" })
		for (const args of [
			[],
			[".alpha/skills/harness-prepare/seed.txt", "private.txt"],
			["../private.txt"],
			[path.join(root, "private.txt")],
			["private.txt"],
		]) {
			await assert.rejects(
				execute(process.execPath, [SKILL_COMPOSITION_READ_SCRIPT, ...args], { cwd: root, windowsHide: true }),
				(error: unknown) => {
					const result = error as { code?: unknown; stdout?: string; stderr?: string }
					assert.equal(result.code, 2)
					assert.equal(result.stdout, "")
					assert.equal(result.stderr?.trim(), "Expected exactly one approved skill fixture file")
					return true
				},
			)
		}
	})
})

test("the read script rejects missing and oversized approved outputs", async () => {
	await withFixture(async (root) => {
		await assert.rejects(
			execute(process.execPath, [SKILL_COMPOSITION_READ_SCRIPT, "live-skills/final.txt"], {
				cwd: root,
				windowsHide: true,
			}),
			{ code: 2, stdout: "", stderr: "Skill fixture read could not complete\n" },
		)
		await fs.writeFile(path.join(root, "live-skills/final.txt"), "x".repeat(4097), { flag: "wx" })
		await assert.rejects(
			execute(process.execPath, [SKILL_COMPOSITION_READ_SCRIPT, "live-skills/final.txt"], {
				cwd: root,
				windowsHide: true,
			}),
			{ code: 2, stdout: "", stderr: "Skill fixture read must be a file of at most 4096 bytes\n" },
		)
	})
})
