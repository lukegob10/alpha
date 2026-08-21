export interface ListAgentsParams {
	path_prefix?: string
}

export interface WaitAgentParams {
	timeout_ms?: number
}

export interface SendMessageParams {
	target: string
	message: string
}

export interface ReportProgressParams {
	message: string
}

export interface FollowupTaskParams {
	target: string
	message: string
}

export interface InterruptAgentParams {
	target: string
}

export interface CancelAgentParams {
	target: string
	reason?: string
}

export interface CloseAgentParams {
	target: string
}
