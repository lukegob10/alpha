import { z } from "zod"

// Friendly and pragmatic retain their configured identity but use the default
// built-in instructions, matching Codex CLI 970111f6 (2026-10-25).
export const personalitySchema = z.enum(["default", "friendly", "pragmatic", "none"])
export type Personality = z.infer<typeof personalitySchema>
