import path from "path"

import type { SkillContent } from "../../shared/skills"

export interface SkillLookup {
	getSkillContent(name: string, currentMode?: string): Promise<SkillContent | null>
}

export async function resolveSkillContentForMode(
	skillsManager: SkillLookup | undefined,
	skillName: string,
	currentMode: string,
): Promise<SkillContent | null> {
	if (!skillsManager) {
		return null
	}

	return skillsManager.getSkillContent(skillName, currentMode)
}

type SkillContentForFormatting = Pick<SkillContent, "source" | "description" | "path" | "instructions">

export function buildSkillApprovalMessage(
	skillName: string,
	args: string | undefined,
	skillContent: Pick<SkillContent, "source" | "description">,
): string {
	return JSON.stringify({
		tool: "skill",
		skill: skillName,
		args,
		source: skillContent.source,
		description: skillContent.description,
	})
}

export function buildSkillResult(
	skillName: string,
	args: string | undefined,
	skillContent: SkillContentForFormatting,
): string {
	let result = `Skill: ${skillName}`

	if (skillContent.description) {
		result += `\nDescription: ${skillContent.description}`
	}

	if (args) {
		result += `\nProvided arguments: ${args}`
	}

	result += `\nSource: ${skillContent.source}`
	// Keep the selected location (including mode overrides and symlinks) rather than reconstructing it from the name.
	const skillPath = skillContent.path
	const pathApi = path.win32.isAbsolute(skillPath) && !path.posix.isAbsolute(skillPath) ? path.win32 : path.posix
	result += `\nSkill file: ${skillPath}`
	result += `\nBase directory: ${pathApi.dirname(skillPath)}`
	result +=
		"\nResolve relative file references against this directory unless the skill explicitly specifies another base. Use absolute paths in file tools; do not guess a workspace-relative skills/ path."
	result += `\n\n--- Skill Instructions ---\n\n${skillContent.instructions}`

	return result
}
