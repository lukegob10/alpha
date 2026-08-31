import { execFile } from "child_process"
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

type GitHubProxyConfig = {
	proxyUrl?: string
	proxyAuthorization?: string
	strictSSL: boolean
	source: "vscode" | "environment" | "none"
	useProxyNegotiate: boolean
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
		const headers = {
			Authorization: `Bearer ${this.token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		}
		const bodyText = body === undefined ? undefined : JSON.stringify(body)
		const proxyConfig = getGitHubProxyConfig(url)

		if (proxyConfig.proxyUrl) {
			return requestWithCurl<T>(url, method, headers, bodyText, proxyConfig)
		}

		let response: Response

		try {
			response = await fetch(url, {
				method,
				headers,
				body: bodyText,
			})
		} catch (error) {
			throw new GitHubApiError(formatNetworkError(url, error, proxyConfig))
		}

		if (!response.ok) {
			throw new GitHubApiError(await getFetchErrorMessage(response), response.status)
		}
		return (await response.json()) as T
	}
}

async function requestWithCurl<T>(
	url: string,
	method: string,
	headers: Record<string, string>,
	body: string | undefined,
	proxyConfig: GitHubProxyConfig,
): Promise<T> {
	const statusMarker = "__ALPHA_GITHUB_HTTP_STATUS__:"
	const args = [
		"--silent",
		"--show-error",
		"--request",
		method,
		"--url",
		url,
		"--write-out",
		`\n${statusMarker}%{http_code}`,
	]

	for (const [name, value] of Object.entries(headers)) {
		args.push("--header", `${name}: ${value}`)
	}

	if (body !== undefined) {
		args.push("--data", body)
	}

	if (proxyConfig.proxyUrl) {
		args.push("--proxy", proxyConfig.proxyUrl)
	}

	if (proxyConfig.proxyAuthorization) {
		args.push("--proxy-header", `Proxy-Authorization: ${proxyConfig.proxyAuthorization}`)
	} else if (proxyConfig.useProxyNegotiate) {
		args.push("--proxy-user", ":", "--proxy-negotiate")
	}

	if (process.platform === "win32") {
		args.push("--ssl-no-revoke")
	}

	if (!proxyConfig.strictSSL) {
		args.push("--insecure")
	}

	let stdout: string
	try {
		stdout = await runCurl(args)
	} catch (error) {
		throw new GitHubApiError(formatCurlNetworkError(error, proxyConfig))
	}

	const markerIndex = stdout.lastIndexOf(statusMarker)
	if (markerIndex === -1) {
		throw new GitHubApiError("GitHub API curl request failed before returning an HTTP status.")
	}

	const responseBody = stdout.slice(0, markerIndex).trim()
	const status = Number(stdout.slice(markerIndex + statusMarker.length).trim())

	if (!Number.isFinite(status)) {
		throw new GitHubApiError("GitHub API curl request returned an invalid HTTP status.")
	}

	if (status < 200 || status >= 300) {
		throw new GitHubApiError(getCurlErrorMessage(responseBody, status), status)
	}

	try {
		return JSON.parse(responseBody) as T
	} catch {
		throw new GitHubApiError(`GitHub API curl request returned invalid JSON with status ${status}.`)
	}
}

function runCurl(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"curl",
			args,
			{
				encoding: "utf8",
				maxBuffer: 10 * 1024 * 1024,
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				if (error) {
					// ExecFile errors include the complete argv in their message. Curl argv
					// contains Authorization headers, so never propagate that raw error.
					const detail = stderr.trim() || `curl exited with code ${error.code ?? "unknown"}`
					reject(new Error(detail))
					return
				}

				resolve(stdout)
			},
		)
	})
}

export function getGitHubProxyConfig(targetUrl: string): GitHubProxyConfig {
	const targetHost = new URL(targetUrl).hostname
	const httpConfig = vscode.workspace.getConfiguration("http")
	const proxySupport = httpConfig.get<string>("proxySupport")
	const vscodeNoProxy = httpConfig.get<string | string[]>("noProxy")

	if (matchesNoProxy(targetHost, vscodeNoProxy)) {
		return { strictSSL: true, source: "none", useProxyNegotiate: false }
	}

	if (proxySupport === "off") {
		return { strictSSL: true, source: "none", useProxyNegotiate: false }
	}

	const vscodeProxy = normalizeSettingString(httpConfig.get<string>("proxy"))
	if (vscodeProxy) {
		return {
			proxyUrl: vscodeProxy,
			proxyAuthorization: normalizeSettingString(httpConfig.get<string>("proxyAuthorization")),
			strictSSL: httpConfig.get<boolean>("proxyStrictSSL", true) !== false,
			source: "vscode",
			useProxyNegotiate: true,
		}
	}

	const environmentProxy = normalizeSettingString(
		process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy,
	)

	return environmentProxy
		? { proxyUrl: environmentProxy, strictSSL: true, source: "environment", useProxyNegotiate: false }
		: { strictSSL: true, source: "none", useProxyNegotiate: false }
}

function matchesNoProxy(host: string, vscodeNoProxy?: string | string[]): boolean {
	const entries = normalizeNoProxyEntries(vscodeNoProxy).concat(
		normalizeNoProxyEntries(process.env.NO_PROXY || process.env.no_proxy),
	)
	if (entries.length === 0) {
		return false
	}

	const normalizedHost = host.toLowerCase()
	return entries.some((entry) => {
		const normalizedEntry = entry.toLowerCase().replace(/^\*\./, "").replace(/^\./, "")
		return entry === "*" || normalizedHost === normalizedEntry || normalizedHost.endsWith(`.${normalizedEntry}`)
	})
}

function normalizeNoProxyEntries(value?: string | string[]): string[] {
	const rawEntries = Array.isArray(value) ? value : (value ?? "").split(",")
	return rawEntries
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => entry.split(":")[0])
}

function normalizeSettingString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function formatNetworkError(url: string, error: unknown, proxyConfig = getGitHubProxyConfig(url)): string {
	const detail = error instanceof Error ? error.message : String(error)

	if (proxyConfig.proxyUrl) {
		return `GitHub API request failed using ${proxyConfig.source} proxy ${redactProxyUrl(proxyConfig.proxyUrl)}. ${detail}`
	}

	return `GitHub API request failed without a configured proxy. ${detail}`
}

function formatCurlNetworkError(error: unknown, proxyConfig: GitHubProxyConfig): string {
	const detail = error instanceof Error ? error.message : String(error)

	if (proxyConfig.proxyUrl) {
		const authMode = proxyConfig.useProxyNegotiate ? " with proxy negotiate authentication" : ""
		return `GitHub API curl request failed using ${proxyConfig.source} proxy ${redactProxyUrl(proxyConfig.proxyUrl)}${authMode}. ${detail}`
	}

	return `GitHub API curl request failed without a configured proxy. ${detail}`
}

function redactProxyUrl(proxyUrl: string): string {
	try {
		const url = new URL(proxyUrl)
		url.username = ""
		url.password = ""
		return url.toString()
	} catch {
		return proxyUrl.replace(/\/\/[^@/]+@/g, "//REDACTED@")
	}
}

async function getFetchErrorMessage(response: Response): Promise<string> {
	const fallback = `GitHub API request failed with status ${response.status}`
	try {
		const payload = (await response.json()) as { message?: string; errors?: unknown }
		const errors = payload.errors ? ` Errors: ${JSON.stringify(payload.errors)}` : ""
		return `${payload.message ?? fallback}.${errors}`
	} catch {
		return fallback
	}
}

function getCurlErrorMessage(responseBody: string, status: number): string {
	const fallback = `GitHub API request failed with status ${status}`
	try {
		const payload = JSON.parse(responseBody) as { message?: string; errors?: unknown }
		const errors = payload.errors ? ` Errors: ${JSON.stringify(payload.errors)}` : ""
		return `${payload.message ?? fallback}.${errors}`
	} catch {
		return responseBody ? `${fallback}: ${responseBody}` : fallback
	}
}
