import { z } from "zod"

export const personalitySchema = z.enum(["default", "none"])
export type Personality = z.infer<typeof personalitySchema>
