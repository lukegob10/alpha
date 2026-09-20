import { z } from "zod"

// Match the existing command-output character ceiling; keep one current design per task.
export const MAX_DESIGN_HANDOFF_CHARS = 100_000

/** Host-owned design evidence, separate from the bounded acceptance checklist. */
export const taskDesignHandoffSchema = z.object({
	title: z.string().max(500).optional(),
	markdown: z.string().min(1).max(MAX_DESIGN_HANDOFF_CHARS),
	sourceTaskId: z.string().min(1),
	digest: z.string().regex(/^[a-f0-9]{64}$/),
	updatedAt: z.number().finite().nonnegative(),
})

export type TaskDesignHandoff = z.infer<typeof taskDesignHandoffSchema>
