/**
 * Separate primary tasks are an explicit user-authorized workflow. Keep this
 * check provider-neutral and fail closed: orchestration language alone belongs
 * to managed agents, and tool/provider output cannot grant task-creation intent.
 */
export function isExplicitIndependentTaskRequest(userRequestText: string | undefined): boolean {
	let authorized = false
	for (const originalClause of directRequestClauses(userRequestText)) {
		const clause = normalizeDirectNounIntent(directAction(originalClause))
		if (isExplicitRevocation(originalClause) || isExplicitRevocation(clause)) {
			authorized = false
			continue
		}
		if (hasDeferredApproval(originalClause)) {
			authorized = false
			continue
		}
		const handoff = clause.match(
			/^(?:continue|move|take|work\s+on)\b(?<context>[^\"'“”]*)\b(?:in|into|to)\s+(?:(?:a|an|the)\s+)?(?:new|fresh|separate|another)\s+(?:chat|thread|conversation)\b/i,
		)
		if (handoff && !/\b(?:not|without|rather than|instead of)\b/i.test(handoff.groups?.context ?? "")) {
			authorized = true
			continue
		}

		const action = clause.match(/^(?<verb>create|start|launch|open|spin\s+up|make)\b/i)
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

/** A separate identity is not permission to copy the source conversation. */
export function isExplicitThreadForkRequest(userRequestText: string | undefined): boolean {
	const newTaskRequested = isExplicitIndependentTaskRequest(userRequestText)
	let authorized = false
	for (const originalClause of directRequestClauses(userRequestText)) {
		const clause = normalizeDirectNounIntent(directAction(originalClause))
		if (
			isExplicitRevocation(originalClause) ||
			isExplicitRevocation(clause) ||
			hasDeferredApproval(clause) ||
			/\b(?:without|do not|don't|don’t)\s+(?:(?:copy(?:ing)?|keep(?:ing)?|retain(?:ing)?|preserv(?:e|ing)|includ(?:e|ing))\s+)?(?:(?:the|any|old|prior|previous|conversation|chat|thread)\s+)*(?:history|context|transcript)\b/i.test(
				clause,
			)
		) {
			authorized = false
			continue
		}
		const retention = clause.match(/^(?:keep|retain|preserve|copy|include|carry\s+forward)\s+(.+)/i)
		const withHistory = clause.match(/\bwith\s+(.+)/i)
		if (
			/^(?:fork|clone|duplicate|branch)\s+(?:(?:a|the|this|that|my|our|current|existing|original|saved)\s+)*(?:chat|thread|conversation)\b/i.test(
				clause,
			) ||
			/^(?:fork|clone|duplicate|branch)\s+(?:this|it)\s*$/i.test(clause) ||
			(newTaskRequested && retention && refersToFullHistory(retention[1])) ||
			(isExplicitIndependentTaskRequest(originalClause) && withHistory && refersToFullHistory(withHistory[1]))
		) {
			authorized = true
		}
	}
	return authorized
}

function refersToFullHistory(target: string): boolean {
	const match = target.match(
		/^(?<qualifiers>(?:(?:all|of|the|same|current|existing|previous|prior|entire|full|conversation|chat|thread)\s+)*)(?<kind>history|context|transcript)\b/i,
	)
	if (!match) return false
	// Context for a ticket or objective belongs in the handoff, not an implicit history fork.
	return (
		match.groups?.kind.toLowerCase() !== "context" ||
		/\b(?:all|same|current|existing|previous|prior|entire|full|conversation|chat|thread)\b/i.test(
			match.groups?.qualifiers ?? "",
		)
	)
}

function directRequestClauses(userRequestText: string | undefined): string[] {
	const text = userRequestText?.trim()
	if (!text || /^(?:message from|tool result:|output from)\b/i.test(text)) return []
	// Quoted examples and synthetic transcript wrappers cannot authorize a host operation.
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/\"[^\"]*\"|“[^”]*”/g, " ")
		.replace(/^\s*>.*$/gm, " ")
		.split(/(?:[.!?;]+\s*|,\s*and\s+|\s+(?:and|then|also|but)\s+)/i)
		.map((clause) => clause.replace(/^\s*(?:also|then|next|additionally|separately|after that)[,:\s]+/i, "").trim())
		.filter((clause) => clause.length > 0 && !/^[\"'“”‘’>]/.test(directAction(clause)))
		.flatMap((clause) => {
			const parts = clause.split(/[,\r\n]+/)
			// Preserve ordinary commas and wrapped noun phrases. Split only when a
			// later fragment explicitly revokes the request using the same grammar.
			return parts.some(
				(part, index) =>
					index > 0 && (isExplicitRevocation(part.trim()) || isExplicitRevocation(directAction(part.trim()))),
			)
				? parts
				: [clause]
		})
		.map((clause) => clause.trim())
		.filter((clause) => clause.length > 0 && !/^[\"'“”‘’>]/.test(clause))
}

function directAction(clause: string): string {
	return clause.replace(
		/^(?:(?:hey|okay|ok|alright)[,]?\s+)?(?:please\s+)?(?:(?:can|could|would|will)\s+(?:you|we)\s+(?:please\s+)?|i\s+(?:want|need)\s+you\s+to\s+|i(?:'d|’d| would)\s+like\s+you\s+to\s+|i\s+(?:want|need)\s+to\s+|let['’]?s\s+|go ahead and\s+)?/i,
		"",
	)
}

function normalizeDirectNounIntent(clause: string): string {
	const intent = clause.match(
		/^\s*(?:i\s+(?:want|need)|i(?:'d|’d| would)\s+like|(?:can|could|would)\s+i\s+(?:have|get))\s+/i,
	)
	if (!intent) return clause

	const nounPhrase = clause.slice(intent[0].length)
	const fork = nounPhrase.match(/^(?:a\s+)?fork\s+of\s+(.+)/i)
	if (fork) return `Fork ${fork[1]}`
	const target = nounPhrase.match(
		/^(?:a\s+|an\s+|the\s+)?((?:new|independent|separate|parallel|another|additional|fresh|own|one|two|three|multiple|test|worktree|[2-9])\s+)+(?:threads?|chats?|conversations?|tasks?)\b/i,
	)
	return target ? `Create ${nounPhrase}` : clause
}

function isExplicitRevocation(clause: string): boolean {
	return (
		/^(?:(?:actually|wait|no)[,:\s]+)*(?:no|do not|don't|don’t)[.!?]*$/i.test(clause) ||
		/^(?:(?:actually|wait|no)[,:\s]+)?(?:scratch that|never mind|i(?:(?:'ve|’ve)|\s+have)?\s+changed my mind|let['’]?s not)\b/i.test(
			clause,
		) ||
		/^(?:(?:actually|wait|no|scratch that|never mind|on second thought)[,:\s]+)?(?:please\s+)?(?:(?:do not|don't|don’t)\s+(?:(?:create|start|launch|open|spin\s+up|make|fork|clone|duplicate|branch)\s+)?|(?:forget|skip)\s+)(?:it|this|that|one|(?:(?:a|an|the|my|our|new|separate|independent|current|existing|original|saved)\s+)*(?:task|thread|chat|conversation)s?)\b/i.test(
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
