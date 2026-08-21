import path from "path"

import { Task } from "../task/Task"
import { digestValue } from "../agent/StepContext"
import { formatResponse } from "../prompts/responses"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import type { SkillContent } from "../../shared/skills"
import {
	buildSkillApprovalMessage,
	buildSkillResult,
	resolveSkillContentForMode,
} from "../../services/skills/skillInvocation"

interface SkillParams {
	skill: string
	args?: string
}

export class SkillTool extends BaseTool<"skill"> {
	readonly name = "skill" as const

	async execute(params: SkillParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { skill: skillName, args } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			// Validate skill name parameter
			if (!skillName) {
				task.consecutiveMistakeCount++
				task.recordToolError("skill")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("skill", "skill"))
				return
			}

			task.consecutiveMistakeCount = 0

			// Get SkillsManager from provider
			const provider = task.providerRef.deref()
			const skillsManager = provider?.getSkillsManager()

			if (!skillsManager) {
				task.recordToolError("skill")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError("Skills Manager not available"))
				return
			}

			// Resolve against the task's sticky mode, not mutable foreground UI state.
			const currentMode =
				typeof task.getTaskMode === "function"
					? await task.getTaskMode()
					: ((await provider?.getState())?.mode ?? "code")
			const inheritedSkill = task.taskKind === "subagent" ? task.getInheritedSubagentSkill(skillName) : undefined

			if (task.taskKind === "subagent" && !inheritedSkill) {
				const availableSkills = task.getInheritedSubagentSkillNames()
				task.recordToolError("skill")
				task.didToolFailInCurrentTurn = true
				pushToolResult(
					formatResponse.toolError(
						`Skill '${skillName}' was not included in this child task's frozen catalog. Available skills: ${availableSkills.join(", ") || "(none)"}`,
					),
				)
				return
			}

			// A child resolves the exact captured path, so a same-name mode override
			// cannot replace the inherited skill after launch.
			const exactSkillLookup = skillsManager as typeof skillsManager & {
				getSkillContentByPath?: (name: string, capturedPath: string) => Promise<SkillContent | null>
			}
			const skillContent = inheritedSkill
				? await exactSkillLookup.getSkillContentByPath?.(skillName, inheritedSkill.path)
				: await resolveSkillContentForMode(skillsManager, skillName, currentMode)

			if (!skillContent) {
				// Get available skills for error message
				const availableSkills = skillsManager.getSkillsForMode(currentMode)
				const skillNames = availableSkills.map((s) => s.name)

				task.recordToolError("skill")
				task.didToolFailInCurrentTurn = true
				pushToolResult(
					formatResponse.toolError(
						`Skill '${skillName}' not found. Available skills: ${skillNames.join(", ") || "(none)"}`,
					),
				)
				return
			}

			if (inheritedSkill) {
				const normalizePath = (candidate: string) => {
					const resolved = path.resolve(candidate)
					return process.platform === "win32" ? resolved.toLowerCase() : resolved
				}
				if (normalizePath(skillContent.path) !== normalizePath(inheritedSkill.path)) {
					task.recordToolError("skill")
					task.didToolFailInCurrentTurn = true
					pushToolResult(
						formatResponse.toolError(
							`Skill '${skillName}' no longer resolves to the path captured for this child task.`,
						),
					)
					return
				}
				if (digestValue(skillContent.instructions) !== inheritedSkill.digest) {
					task.recordToolError("skill")
					task.didToolFailInCurrentTurn = true
					pushToolResult(
						formatResponse.toolError(
							`Skill '${skillName}' changed after this child task captured its context. Start a new child to use the updated skill.`,
						),
					)
					return
				}
			}

			// Build approval message
			const toolMessage = buildSkillApprovalMessage(skillName, args, skillContent)

			const didApprove = await askApproval("tool", toolMessage)

			if (!didApprove) {
				return
			}

			pushToolResult(buildSkillResult(skillName, args, skillContent))
		} catch (error) {
			await handleError("executing skill", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"skill">): Promise<void> {
		const skillName: string | undefined = block.params.skill
		const args: string | undefined = block.params.args

		const partialMessage = JSON.stringify({
			tool: "skill",
			skill: skillName,
			args: args,
		})

		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const skillTool = new SkillTool()
