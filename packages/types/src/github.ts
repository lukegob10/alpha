import { z } from "zod"

/**
 * Historical fields retained for GitHub tool approval transcripts and their webview projection.
 * Native GitHub API execution is retired; this contract remains readable for saved history.
 */
export const githubToolApprovalSchema = z.object({
	action: z
		.enum(["create_pull_request", "get_pull_request", "list_checks", "merge_pull_request", "comment"])
		.optional(),
	owner: z.string(),
	repo: z.string(),
	pull_number: z.number().int().optional(),
	issue_number: z.number().int().optional(),
	head: z.string().optional(),
	base: z.string().optional(),
	title: z
		.string()
		.nullish()
		.transform((value) => value ?? undefined),
	body: z.string().optional(),
	sha: z.string().optional(),
	merge_method: z
		.enum(["merge", "squash", "rebase"])
		.nullish()
		.transform((value) => value ?? undefined),
	message: z.string().optional(),
})

export type GitHubToolApproval = z.infer<typeof githubToolApprovalSchema>
