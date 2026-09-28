/**
 * Separate primary tasks are an explicit user-authorized workflow. Keep this
 * check provider-neutral and fail closed: orchestration language alone belongs
 * to managed agents, and tool/provider output cannot grant task-creation intent.
 */
export function isExplicitIndependentTaskRequest(userRequestText: string | undefined): boolean {
	const text = userRequestText?.trim()
	if (!text || /^(?:message from|tool result:|output from)\b/i.test(text)) return false

	// Only consider direct clauses. In particular, do not turn a quoted command,
	// code sample, or a later transcript line into authorization.
	const clauses = text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/^\s*>.*$/gm, " ")
		.split(/(?:[.!?;]+\s*|,\s*and\s+|\s+(?:and|then|also|but)\s+)/i)

	let authorized = false
	for (const rawClause of clauses) {
		const originalClause = rawClause
			.replace(/^\s*(?:also|then|next|additionally|separately|after that)[,:\s]+/i, "")
			.trim()
		const clause = normalizeDirectNounIntent(originalClause)
		if (!clause || /^[\"'“”‘’>]/.test(clause)) continue

		if (isExplicitRevocation(originalClause)) {
			authorized = false
			continue
		}
		if (hasDeferredApproval(originalClause)) {
			authorized = false
			continue
		}

		const action = clause.match(
			/^\s*(?:hey[,]?\s+)?(?:please\s+)?(?:(?:can|could|would|will)\s+(?:you|we)\s+(?:please\s+)?|i\s+(?:want|need)\s+you\s+to\s+|i(?:'d|’d| would)\s+like\s+you\s+to\s+|i\s+(?:want|need)\s+to\s+|let'?s\s+|go ahead and\s+)?(?<verb>create|start|launch|open|spin\s+up|make)\b/i,
		)
		if (!action) continue

		const target = clause
			.slice(action[0].length)
			.match(/^((?:\s+[\p{L}\p{N}_-]+){0,8})\s+(threads?|chats?|conversations?|tasks?)\b/iu)
		if (!target) continue

		const noun = target[2].toLowerCase().replace(/s$/, "")
		const qualifiers = target[1]
		const remainder = clause.slice(action[0].length + target[0].length)
		const verb = action.groups?.verb?.toLowerCase()
		if (isTrackerRecordRequest(remainder)) continue
		if (hasDeferredApproval(remainder)) continue

		if (noun === "task") {
			if (
				!/\b(?:new|independent|separate|parallel|another|additional|fresh|own|one|two|three|multiple|test|worktree|[2-9])\b/i.test(
					qualifiers,
				)
			) {
				continue
			}
			authorized = true
			continue
		}

		// "Open a chat/thread" can refer to an existing item; require an explicit
		// new/separate marker for open, while creation verbs are unambiguous.
		if (verb === "open" && !/\b(?:new|separate|another|additional|fresh|independent)\b/i.test(qualifiers)) {
			continue
		}
		authorized = true
	}

	return authorized
}

function normalizeDirectNounIntent(clause: string): string {
	const intent = clause.match(
		/^\s*(?:i\s+(?:want|need)|i(?:'d|’d| would)\s+like|(?:can|could|would)\s+i\s+(?:have|get))\s+/i,
	)
	if (!intent) return clause

	const nounPhrase = clause.slice(intent[0].length)
	const target = nounPhrase.match(
		/^(?:a\s+|an\s+|the\s+)?((?:new|independent|separate|parallel|another|additional|fresh|own|one|two|three|multiple|test|worktree|[2-9])\s+)+(?:threads?|chats?|conversations?|tasks?)\b/i,
	)
	return target ? `Create ${nounPhrase}` : clause
}

function isExplicitRevocation(clause: string): boolean {
	return (
		/^(?:(?:actually|wait|no)[,:\s]+)*(?:no|do not|don't|don’t)[.!?]*$/i.test(clause) ||
		/^(?:(?:actually|wait|no)[,:\s]+)?(?:scratch that|never mind|i(?:(?:'ve|’ve)|\s+have)?\s+changed my mind|let'?s not)\b/i.test(
			clause,
		) ||
		/^(?:(?:actually|wait|no|scratch that|never mind|on second thought)[,:\s]+)?(?:please\s+)?(?:(?:do not|don't|don’t)\s+(?:(?:create|start|launch|open|spin\s+up|make)\s+)?|(?:forget|skip)\s+)(?:it|that|one|(?:the\s+)?(?:new\s+|separate\s+|independent\s+)?(?:task|thread|chat|conversation)s?)\b/i.test(
			clause,
		)
	)
}

function isTrackerRecordRequest(remainder: string): boolean {
	return (
		/^\s+(?:(?:as\s+)?(?:a\s+)?)?(?:ticket|issue|item|record|entry)\b/i.test(remainder) ||
		/\b(?:in|on|to|within|inside)\s+(?:(?:the|a|an|our)\s+)?(?:issue|task|ticket|bug|work[- ]item)\s+(?:tracker|management system|board|backlog)\b/i.test(
			remainder,
		) ||
		/\b(?:in|on|to)\s+(?:jira|linear|asana|trello|clickup|youtrack|shortcut|gitlab|github(?:\s+projects)?|azure devops)\b/i.test(
			remainder,
		)
	)
}

function hasDeferredApproval(remainder: string): boolean {
	return /\b(?:only\s+if|only\s+after|unless|until|after|when|once)\s+(?:i|we)\s+(?:explicitly\s+)?(?:approve|confirm|authorize|authorise|sign off)\b/i.test(
		remainder,
	)
}
