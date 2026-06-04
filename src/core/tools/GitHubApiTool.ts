import type { SecretState } from "@alpha-code/types"

import { formatResponse } from "../prompts/responses"
import { GitHubApiClient, type GitHubMergeMethod } from "../../services/github/GitHubApiClient"
import type { NativeToolArgs, ToolUse } from "../../shared/tools"
import { Task } from "../task/Task"

import { BaseTool, ToolCallbacks } from "./BaseTool"

type GitHubApiParams = NativeToolArgs["github_api"]

export class GitHubApiTool extends BaseTool<"github_api"> {
	readonly name = "github_api" as const

	async execute(params: GitHubApiParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			const validationError = await this.validateParams(params, task)
			if (validationError) {
				pushToolResult(validationError)
				return
			}

			const approvalMessage = JSON.stringify(buildApprovalMessage(params))
			const didApprove = await askApproval("tool", approvalMessage, undefined, isWriteAction(params.action))

			if (!didApprove) {
				pushToolResult(formatResponse.toolDenied())
				return
			}

			const token = this.resolveToken(task)
			if (!token) {
				pushToolResult(
					formatResponse.toolError(
						"GitHub token is not configured. Add one in Settings > GitHub or set GITHUB_TOKEN/GH_TOKEN in the extension environment.",
					),
				)
				return
			}

			const client = new GitHubApiClient(token)
			const result = await executeGitHubAction(client, params)
			task.consecutiveMistakeCount = 0
			pushToolResult(JSON.stringify(result, null, 2))
		} catch (error) {
			await handleError("using GitHub API", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"github_api">): Promise<void> {
		const args = block.nativeArgs ?? (block.params as unknown as Partial<GitHubApiParams>)
		await task.ask("tool", JSON.stringify(buildApprovalMessage(args)), true).catch(() => {})
	}

	private resolveToken(task: Task): string | undefined {
		const provider = task.providerRef.deref()
		const secretToken = provider?.contextProxy.getSecret("githubToken" as keyof SecretState)
		return secretToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN
	}

	private async validateParams(params: Partial<GitHubApiParams>, task: Task): Promise<string | undefined> {
		for (const paramName of ["action", "owner", "repo"] as const) {
			if (!params[paramName]) {
				task.consecutiveMistakeCount++
				task.recordToolError("github_api")
				task.didToolFailInCurrentTurn = true
				return task.sayAndCreateMissingParamError("github_api", paramName)
			}
		}

		switch (params.action) {
			case "create_pull_request":
				return this.requireParams(params, task, ["head", "base", "title"])
			case "get_pull_request":
			case "merge_pull_request":
				return this.requireNumberParam(params, task, "pull_number")
			case "list_checks":
				return this.requireParams(params, task, ["sha"])
			case "comment": {
				const missingNumber = await this.requireNumberParam(params, task, "issue_number")
				if (missingNumber) return missingNumber
				return this.requireParams(params, task, ["body"])
			}
			default:
				task.consecutiveMistakeCount++
				task.recordToolError("github_api")
				task.didToolFailInCurrentTurn = true
				return formatResponse.toolError(`Invalid github_api action: ${String(params.action)}`)
		}
	}

	private async requireParams(
		params: Partial<Record<string, unknown>>,
		task: Task,
		paramNames: string[],
	): Promise<string | undefined> {
		for (const paramName of paramNames) {
			if (!params[paramName]) {
				task.consecutiveMistakeCount++
				task.recordToolError("github_api")
				task.didToolFailInCurrentTurn = true
				return task.sayAndCreateMissingParamError("github_api", paramName)
			}
		}

		return undefined
	}

	private async requireNumberParam(
		params: Partial<Record<string, unknown>>,
		task: Task,
		paramName: string,
	): Promise<string | undefined> {
		if (typeof params[paramName] !== "number" || !Number.isInteger(params[paramName])) {
			task.consecutiveMistakeCount++
			task.recordToolError("github_api")
			task.didToolFailInCurrentTurn = true
			return formatResponse.toolError(`Missing or invalid github_api parameter: ${paramName}`)
		}

		return undefined
	}
}

function buildApprovalMessage(params: Partial<GitHubApiParams>) {
	return {
		tool: "githubApi",
		action: params.action ?? "",
		owner: params.owner ?? "",
		repo: params.repo ?? "",
		pull_number: "pull_number" in params ? params.pull_number : undefined,
		issue_number: "issue_number" in params ? params.issue_number : undefined,
		head: "head" in params ? params.head : undefined,
		base: "base" in params ? params.base : undefined,
		title: "title" in params ? params.title : undefined,
		sha: "sha" in params ? params.sha : undefined,
		merge_method: "merge_method" in params ? params.merge_method : undefined,
	}
}

function isWriteAction(action: string): boolean {
	return action === "create_pull_request" || action === "merge_pull_request" || action === "comment"
}

async function executeGitHubAction(client: GitHubApiClient, params: GitHubApiParams) {
	switch (params.action) {
		case "create_pull_request":
			return client.createPullRequest(params)
		case "get_pull_request":
			return client.getPullRequest(params)
		case "list_checks":
			return client.listChecks(params)
		case "merge_pull_request":
			return client.mergePullRequest({
				...params,
				merge_method: params.merge_method as GitHubMergeMethod | null | undefined,
			})
		case "comment":
			return client.comment(params)
	}
}

export const githubApiTool = new GitHubApiTool()
