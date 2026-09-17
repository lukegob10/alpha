import type { SkillMetadata } from "@alpha-code/types"

export type { SkillMetadata, SkillSource } from "@alpha-code/types"

/** Full skill content, loaded only on invocation. */
export interface SkillContent extends SkillMetadata {
	instructions: string
}
