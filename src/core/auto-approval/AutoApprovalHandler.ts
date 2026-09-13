import { GlobalState, ClineMessage, ClineAsk } from "@alpha-code/types"

import { getApiMetrics } from "../../shared/getApiMetrics"
import { ClineAskResponse } from "../../shared/WebviewMessage"

export interface AutoApprovalResult {
	shouldProceed: boolean
	requiresApproval: boolean
	approvalType?: "requests" | "cost"
	approvalCount?: number | string
}

export class AutoApprovalHandler {
	private lastResetMessageIndex: number = 0
	private consecutiveAutoApprovedRequestsCount: number = 0
	private consecutiveAutoApprovedCost: number = 0

	/**
	 * Check if auto-approval limits have been reached and handle user approval if needed
	 */
	async checkAutoApprovalLimits(
		state: GlobalState | undefined,
		messages: ClineMessage[],
		askForApproval: (
			type: ClineAsk,
			data: string,
		) => Promise<{ response: ClineAskResponse; text?: string; images?: string[] }>,
		options: { currentRequestRecorded?: boolean } = {},
	): Promise<AutoApprovalResult> {
		// Check request count limit
		const requestResult = await this.checkRequestLimit(
			state,
			messages,
			askForApproval,
			options.currentRequestRecorded,
		)
		if (!requestResult.shouldProceed || requestResult.requiresApproval) {
			return requestResult
		}

		// Check cost limit
		const costResult = await this.checkCostLimit(state, messages, askForApproval, options.currentRequestRecorded)
		return costResult
	}

	/**
	 * Calculate request count and check if limit is exceeded
	 */
	private async checkRequestLimit(
		state: GlobalState | undefined,
		messages: ClineMessage[],
		askForApproval: (
			type: ClineAsk,
			data: string,
		) => Promise<{ response: ClineAskResponse; text?: string; images?: string[] }>,
		currentRequestRecorded = false,
	): Promise<AutoApprovalResult> {
		const maxRequests = state?.allowedMaxRequests || Infinity

		// Calculate request count from messages after the last reset point
		const messagesAfterReset = messages.slice(this.lastResetMessageIndex)
		// The owning Task loop records the current start before preflight; direct callers may not.
		this.consecutiveAutoApprovedRequestsCount =
			messagesAfterReset.filter((msg) => msg.type === "say" && msg.say === "api_req_started").length +
			(currentRequestRecorded ? 0 : 1)

		if (this.consecutiveAutoApprovedRequestsCount > maxRequests) {
			const { response } = await askForApproval(
				"auto_approval_max_req_reached",
				JSON.stringify({ count: maxRequests, type: "requests" }),
			)

			// If we get past the promise, it means the user approved and did not start a new task
			if (response === "yesButtonClicked") {
				// Reset tracking by recording the current message count
				this.resetAllowance(messages, currentRequestRecorded)
				return {
					shouldProceed: true,
					requiresApproval: true,
					approvalType: "requests",
					approvalCount: maxRequests,
				}
			}

			return {
				shouldProceed: false,
				requiresApproval: true,
				approvalType: "requests",
				approvalCount: maxRequests,
			}
		}

		return { shouldProceed: true, requiresApproval: false }
	}

	/**
	 * Calculate current cost and check if limit is exceeded
	 */
	private async checkCostLimit(
		state: GlobalState | undefined,
		messages: ClineMessage[],
		askForApproval: (
			type: ClineAsk,
			data: string,
		) => Promise<{ response: ClineAskResponse; text?: string; images?: string[] }>,
		currentRequestRecorded = false,
	): Promise<AutoApprovalResult> {
		const maxCost = state?.allowedMaxCost || Infinity

		// Calculate total cost from messages after the last reset point
		const messagesAfterReset = messages.slice(this.lastResetMessageIndex)
		this.consecutiveAutoApprovedCost = getApiMetrics(messagesAfterReset).totalCost

		// Use epsilon for floating-point comparison to avoid precision issues
		const EPSILON = 0.0001
		if (this.consecutiveAutoApprovedCost > maxCost + EPSILON) {
			const { response } = await askForApproval(
				"auto_approval_max_req_reached",
				JSON.stringify({ count: maxCost.toFixed(2), type: "cost" }),
			)

			// If we get past the promise, it means the user approved and did not start a new task
			if (response === "yesButtonClicked") {
				// Reset tracking by recording the current message count
				// Future calculations will only include messages after this point
				this.resetAllowance(messages, currentRequestRecorded)
				return {
					shouldProceed: true,
					requiresApproval: true,
					approvalType: "cost",
					approvalCount: maxCost.toFixed(2),
				}
			}

			return {
				shouldProceed: false,
				requiresApproval: true,
				approvalType: "cost",
				approvalCount: maxCost.toFixed(2),
			}
		}

		return { shouldProceed: true, requiresApproval: false }
	}

	private resetAllowance(messages: ClineMessage[], currentRequestRecorded: boolean): void {
		this.lastResetMessageIndex = messages.length
		if (!currentRequestRecorded) return
		// Preflight can publish messages after the request start. Retain that request
		// itself, including the cost that will be attached when it settles.
		for (let index = messages.length - 1; index >= 0; index--) {
			if (messages[index].type === "say" && messages[index].say === "api_req_started") {
				this.lastResetMessageIndex = index
				return
			}
		}
	}

	/** Reset the tracking (typically called when starting a new task). */
	resetRequestCount(): void {
		this.lastResetMessageIndex = 0
		this.consecutiveAutoApprovedRequestsCount = 0
		this.consecutiveAutoApprovedCost = 0
	}

	/**
	 * Get current approval state for debugging/testing
	 */
	getApprovalState(): { requestCount: number; currentCost: number } {
		return {
			requestCount: this.consecutiveAutoApprovedRequestsCount,
			currentCost: this.consecutiveAutoApprovedCost,
		}
	}
}
