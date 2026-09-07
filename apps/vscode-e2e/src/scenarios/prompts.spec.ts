import { strict as assert } from "node:assert"
import { test } from "node:test"

import { DEVELOPMENT_PHASES } from "./developmentCatalog"
import { WORKFLOW_COMMANDS, workflowPrompt } from "./prompts"

test("cancellation submits a tool call to the pending approval boundary, not a conversational question", () => {
	const prompt = workflowPrompt("hold")
	assert.ok(prompt.includes(WORKFLOW_COMMANDS.test))
	assert.ok(prompt.includes("execute_command"), "the test must request tool submission before approval")
	assert.ok(prompt.includes("ask_followup_question"), "distinguish the conversational approval boundary")
})

test("bootstrap discloses the controller-file ignore requirement enforced by the independent grader", () => {
	const prompt = DEVELOPMENT_PHASES.devBootstrapBuild.prompt
	assert.ok(prompt.includes(".gitignore"))
	assert.ok(prompt.includes(".alpha-development-*"))
	assert.ok(prompt.includes(".alpha-e2e-owned.json"))
})

test("development prompts describe the exact per-call command boundary", () => {
	for (const phase of Object.values(DEVELOPMENT_PHASES)) {
		assert.ok(phase.prompt.includes("separate execute_command call"))
		assert.ok(phase.prompt.includes("shell operators"))
	}
})

test("bootstrap discloses the package test entrypoint required by its grader", () => {
	const prompt = DEVELOPMENT_PHASES.devBootstrapBuild.prompt
	assert.ok(prompt.includes("scripts.test"))
	assert.ok(prompt.includes("dependency-free"))
	assert.ok(prompt.includes("package.json"))
})

test("clean-worktree workflows permit read-only status without widening mutation authority", () => {
	const status = "git status --short --untracked-files=all"
	for (const phase of [DEVELOPMENT_PHASES.devBootstrapBuild, DEVELOPMENT_PHASES.devRefactorExtract]) {
		assert.ok((phase.commands as readonly string[]).includes(status))
		assert.ok(phase.prompt.includes(status))
		assert.equal((phase.commands as readonly string[]).includes("git add ."), false)
		assert.equal((phase.commands as readonly string[]).includes("git reset --hard"), false)
	}
})
