import * as vscode from "vscode"

export type GitHubMergeMethod = "merge" | "squash" | "rebase"

export type GitHubApiResult =
	| {
			action: "create_pull_request"
			html_url: string
			number: number
			state: string
			title: string
			head: string
			base: string
	  }
	| {
			action: "get_pull_request"
			html_url: string
			number: number
			state: string
			merged: boolean
			title: string
			head: string
			base: string
			user?: string
	  }
	| {
			action: "list_checks"
			total_count: number
			check_runs: Array<{
				name: string
				status: string
				conclusion: string | null
				html_url: string | null
			}>
	  }
	| {
			action: "merge_pull_request"
			merged: boolean
			message: string
			sha?: string
	  }
	| {
			action: "comment"
			html_url: string
			id: number
	  }

export class GitHubApiError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
	) {
		super(message)
		this.name = "GitHubApiError"
	}
}

export class GitHubApiClient {
	private readonly baseUrl = "https://api.github.com"

	constructor(private readonly token: string) {}

	async createPullRequest(input: {
		owner: string
		repo: string
		head: string
		base: string
		title: string
		body?: string | null
	}): Promise<GitHubApiResult> {
		const response = await this.request<any>("POST", `/repos/${input.owner}/${input.repo}/pulls`, {
			head: input.head,
			base: input.base,
			title: input.title,
			body: input.body ?? "",
		})

		return {
			action: "create_pull_request",
			html_url: response.html_url,
			number: response.number,
			state: response.state,
			title: response.title,
			head: response.head?.ref,
			base: response.base?.ref,
		}
	}

	async getPullRequest(input: { owner: string; repo: string; pull_number: number }): Promise<GitHubApiResult> {
		const response = await this.request<any>(
			"GET",
			`/repos/${input.owner}/${input.repo}/pulls/${input.pull_number}`,
		)

		return {
			action: "get_pull_request",
			html_url: response.html_url,
			number: response.number,
			state: response.state,
			merged: response.merged,
			title: response.title,
			head: response.head?.ref,
			base: response.base?.ref,
			user: response.user?.login,
		}
	}

	async listChecks(input: { owner: string; repo: string; sha: string }): Promise<GitHubApiResult> {
		const response = await this.request<any>(
			"GET",
			`/repos/${input.owner}/${input.repo}/commits/${input.sha}/check-runs`,
		)

		return {
			action: "list_checks",
			total_count: response.total_count ?? 0,
			check_runs: (response.check_runs ?? []).map((run: any) => ({
				name: run.name,
				status: run.status,
				conclusion: run.conclusion ?? null,
				html_url: run.html_url ?? null,
			})),
		}
	}

	async mergePullRequest(input: {
		owner: string
		repo: string
		pull_number: number
		merge_method?: GitHubMergeMethod | null
		title?: string | null
		message?: string | null
	}): Promise<GitHubApiResult> {
		const body: Record<string, string> = {}
		if (input.merge_method) body.merge_method = input.merge_method
		if (input.title) body.commit_title = input.title
		if (input.message) body.commit_message = input.message

		const response = await this.request<any>(
			"PUT",
			`/repos/${input.owner}/${input.repo}/pulls/${input.pull_number}/merge`,
			body,
		)

		return {
			action: "merge_pull_request",
			merged: Boolean(response.merged),
			message: response.message,
			sha: response.sha,
		}
	}

	async comment(input: {
		owner: string
		repo: string
		issue_number: number
		body: string
	}): Promise<GitHubApiResult> {
		const response = await this.request<any>(
			"POST",
			`/repos/${input.owner}/${input.repo}/issues/${input.issue_number}/comments`,
			{ body: input.body },
		)

		return {
			action: "comment",
			html_url: response.html_url,
			id: response.id,
		}
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const url = `${this.baseUrl}${path}`
		const response = await fetchWithProxy(url, {
			method,
			headers: {
				Authorization: `Bearer ${this.token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		})

		if (!response.ok) {
			throw new GitHubApiError(await getErrorMessage(response), response.status)
		}

		return (await response.json()) as T
	}
}

async function fetchWithProxy(url: string, init: RequestInit): Promise<Response> {
	const proxyUrl = getProxyUrl(url)
	if (!proxyUrl) {
		return fetch(url, init)
	}

	const { fetch: undiciFetch, ProxyAgent } = (await import("undici")) as any
	return undiciFetch(url, {
		...init,
		dispatcher: new ProxyAgent(proxyUrl),
	}) as Promise<Response>
}

function getProxyUrl(targetUrl: string): string | undefined {
	const targetHost = new URL(targetUrl).hostname
	if (matchesNoProxy(targetHost)) {
		return undefined
	}

	const vscodeProxy = vscode.workspace.getConfiguration("http").get<string>("proxy")
	return (
		vscodeProxy ||
		process.env.HTTPS_PROXY ||
		process.env.https_proxy ||
		process.env.HTTP_PROXY ||
		process.env.http_proxy
	)
}

function matchesNoProxy(host: string): boolean {
	const noProxy = process.env.NO_PROXY || process.env.no_proxy
	if (!noProxy) {
		return false
	}

	return noProxy
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean)
		.some((entry) => entry === "*" || host.toLowerCase() === entry || host.toLowerCase().endsWith(`.${entry}`))
}

async function getErrorMessage(response: Response): Promise<string> {
	const fallback = `GitHub API request failed with status ${response.status}`
	try {
		const payload = (await response.json()) as { message?: string; errors?: unknown }
		const errors = payload.errors ? ` Errors: ${JSON.stringify(payload.errors)}` : ""
		return `${payload.message ?? fallback}.${errors}`
	} catch {
		return fallback
	}
}
