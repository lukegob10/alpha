import { DEVELOPMENT_PHASES, type DevelopmentPhaseId } from "./developmentCatalog"
import { contextProbePrompt } from "./longContextProbe"

export const WORKFLOW_COMMANDS = {
	test: "node --test test/stats.test.cjs",
	status: "git status --short",
	diff: "git diff -- lib/stats.cjs test/stats.test.cjs README.md",
	stage: "git add lib/stats.cjs test/stats.test.cjs README.md",
	commit: 'git -c core.hooksPath=.git/alpha-empty-hooks -c commit.gpgSign=false -c user.name=AlphaWorkflow -c user.email=alpha-workflow@example.invalid commit -m "Fix empty sum"',
} as const

const scope = [
	"Work only in this disposable repository. Do not install dependencies, use network services, delegate, push,",
	"alter Git configuration, or modify the fixture ownership marker or workflow checkpoints/results.",
	"Use file tools for inspection and edits. The harness approves only these exact terminal commands, without",
	"prefixes, shell operators, pipelines, or command substitutions, and only with the workspace as cwd:",
	...Object.values(WORKFLOW_COMMANDS),
].join("\n")

export const WORKFLOW_PROMPTS = {
	contextProbe: "[workflow:context-probe]",
	review: `[workflow:review]\n${scope}\nReview lib/stats.cjs and test/stats.test.cjs. Identify the empty-array bug. Do not edit or commit anything.`,
	enhance: `[workflow:enhance]\n${scope}\nFix sum([]) to return 0 while preserving sum of numbers. Add an empty-array regression test in test/stats.test.cjs if absent. Run ${WORKFLOW_COMMANDS.test} and report its outcome. Do not commit yet.`,
	commit: `[workflow:commit]\n${scope}\nReview the diff, stage the changes and create exactly one local commit with the approved stage and commit commands. Leave the repository clean.`,
	followup: `[workflow:followup]\n${scope}\nAdd a regression test for negative numbers in test/stats.test.cjs and document sum([-2, 1]) = -1 in README.md. Run ${WORKFLOW_COMMANDS.test}. Keep this follow-up uncommitted.`,
	hold: `[workflow:hold]\n${scope}\nSubmit ${WORKFLOW_COMMANDS.test} using execute_command with the workspace as cwd. Do not edit files. This cancellation test needs the tool's pending command-approval boundary: submit the tool call now; the host will withhold execution approval. Do not request conversational approval through ask_followup_question or wait in prose before submitting the command.`,
	verify: `[workflow:verify]\n${scope}\nRecheck the current files and run ${WORKFLOW_COMMANDS.test}. Do not modify or commit anything. Explain the result using the accumulated task context.`,
	completionIdle: `[workflow:completion-idle]\n${scope}\nRecheck the implemented changes and run ${WORKFLOW_COMMANDS.test}. Do not modify or commit anything. Finish using attempt_completion with outcome completed and a concise verification report. This tests the normal completion-tool boundary after an implementation thread.`,
	extend: `[workflow:extend]\n${scope}\nExtend the accumulated regression cases as instructed below, preserving all earlier behavior and tests.`,
} as const

export function longThreadPrompt(step: number): string {
	return `${WORKFLOW_PROMPTS.extend}\nThis is step ${step}. Read test/workflow-cases.json if it exists (initially absent). Append one object with keys step,left,right,sum. Set step and right to ${step}, left to the preceding object's sum (or 0 for step 1), and sum to left + right. Preserve every preceding object exactly. The file is a JSON array. Extend test/stats.test.cjs to read this JSON array and test sum([left,right]) against each sum. Run ${WORKFLOW_COMMANDS.test}. Leave these follow-up changes uncommitted.`
}

export type WorkflowPromptName = keyof typeof WORKFLOW_PROMPTS | DevelopmentPhaseId

export function isDevelopmentPrompt(prompt: WorkflowPromptName): prompt is DevelopmentPhaseId {
	return Object.hasOwn(DEVELOPMENT_PHASES, prompt)
}

export function workflowPrompt(prompt: WorkflowPromptName, step?: number): string {
	if (prompt === "contextProbe") return contextProbePrompt(step ?? 0)
	if (isDevelopmentPrompt(prompt)) return DEVELOPMENT_PHASES[prompt].prompt
	return prompt === "extend" ? longThreadPrompt(step!) : WORKFLOW_PROMPTS[prompt]
}

/** A phase's command authority never inherits commands from another scenario. */
export function workflowCommands(prompt: WorkflowPromptName): readonly string[] {
	if (prompt === "contextProbe") return []
	return isDevelopmentPrompt(prompt) ? DEVELOPMENT_PHASES[prompt].commands : Object.values(WORKFLOW_COMMANDS)
}

export const WORKFLOW_TRACE_COMMANDS: readonly string[] = [
	...new Set([
		...Object.values(WORKFLOW_COMMANDS),
		...Object.values(DEVELOPMENT_PHASES).flatMap((phase) => [...phase.commands]),
	]),
]
