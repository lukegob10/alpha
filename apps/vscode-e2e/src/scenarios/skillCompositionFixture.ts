export const SKILL_COMPOSITION_READ_SCRIPT = "live-skills/read-fixture.cjs"
export const SKILL_COMPOSITION_READ_PATHS = [
	".alpha/skills/harness-prepare/seed.txt",
	"live-skills/prepared.txt",
	"live-skills/final.txt",
] as const
export const SKILL_COMPOSITION_READ_COMMANDS = SKILL_COMPOSITION_READ_PATHS.map(
	(file) => `node ${SKILL_COMPOSITION_READ_SCRIPT} ${file}`,
)

const readScript = `const fs = require("node:fs")
const path = require("node:path")
const allowed = ${JSON.stringify(SKILL_COMPOSITION_READ_PATHS)}
function fail(message) {
  console.error(message)
  process.exitCode = 2
}
if (process.argv.length !== 3 || !allowed.includes(process.argv[2])) {
  fail("Expected exactly one approved skill fixture file")
} else {
  try {
    const root = fs.realpathSync(path.resolve(__dirname, ".."))
    const target = fs.realpathSync(path.resolve(root, process.argv[2]))
    const relative = path.relative(root, target)
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      fail("Skill fixture read escaped the workspace")
    } else {
      const stat = fs.statSync(target)
      if (!stat.isFile() || stat.size > 4096) fail("Skill fixture read must be a file of at most 4096 bytes")
      else process.stdout.write(fs.readFileSync(target))
    }
  } catch {
    fail("Skill fixture read could not complete")
  }
}
`

export const SKILL_COMPOSITION_FILES: Record<string, string> = {
	".alpha/skills/harness-prepare/SKILL.md": [
		"---",
		"name: harness-prepare",
		"description: First stage of the harness workflow fixture",
		"---",
		"All live-skills paths and commands below are relative to the workspace root, not this skill directory.",
		`Read seed.txt beside this skill by running exactly: ${SKILL_COMPOSITION_READ_COMMANDS[0]}`,
		"Use apply_patch to create live-skills/prepared.txt with the seed's exact content, including its final newline.",
		"Do not create or modify outputs through exec_command, shell writes, copy commands, or inline code. Do not modify the read script.",
		"Then use harness-finish for the next stage.",
		"",
	].join("\n"),
	".alpha/skills/harness-prepare/seed.txt": "ALPHA_WORKFLOW_SEED\n",
	".alpha/skills/harness-finish/SKILL.md": [
		"---",
		"name: harness-finish",
		"description: Final stage of the harness workflow fixture",
		"---",
		"All live-skills paths and commands below are relative to the workspace root, not this skill directory.",
		`Read the prepared output by running exactly: ${SKILL_COMPOSITION_READ_COMMANDS[1]}`,
		"Use apply_patch to create live-skills/final.txt containing the prepared content followed by FINISHED on the next line and a final newline.",
		"Do not create or modify outputs through exec_command, shell writes, copy commands, or inline code. Do not modify the read script.",
		`Read the final file before reporting completion by running exactly: ${SKILL_COMPOSITION_READ_COMMANDS[2]}`,
		"",
	].join("\n"),
	[SKILL_COMPOSITION_READ_SCRIPT]: readScript,
}

export const SKILL_COMPOSITION_PROMPT = [
	"Complete both stages of the harness workflow using harness-prepare then harness-finish.",
	"Use update_plan to track preparing the first output, creating the final output, and verifying final.txt; mark every step completed.",
	"Follow both skills. Use apply_patch to create both live-skills/prepared.txt and live-skills/final.txt; exec_command is only for the three prepared read commands listed by the skills.",
	"Run those commands from the workspace root without adding shell operators, changing their arguments, or using inline code. Do not modify the fixture read script or skill sources.",
	"Read live-skills/final.txt with its prepared exec_command before finishing.",
].join("\n")
