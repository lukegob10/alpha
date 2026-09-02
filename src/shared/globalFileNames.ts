export const GlobalFileNames = {
	apiConversationHistory: "api_conversation_history.json",
	uiMessages: "ui_messages.json",
	mcpSettings: "mcp_settings.json",
	customModes: "custom_modes.yaml",
	taskMetadata: "task_metadata.json",
	historyItem: "history_item.json",
	historyIndex: "_index.json",
	agentTurnEvents: "agent_turn_events.jsonl",
	/** Provider-neutral lifecycle journal; legacy agentTurnEvents is retained. */
	agentLifecycleEvents: "agent_lifecycle_events.jsonl",
	agentLifecycleSnapshot: "agent_lifecycle_snapshot.json",
	/** Versioned provider transcript; legacy apiConversationHistory is retained. */
	providerTranscript: "provider_transcript.json",
	subagentInstructionSnapshot: "subagent_instruction_snapshot.json",
	agentControl: "agent_control.json",
	scheduledTasks: "scheduled_tasks.json",
	scheduledTaskRuns: "scheduled_task_runs.json",
	goalSeekJobs: "goal_seek_jobs.json",
	goalSeekRuns: "goal_seek_runs.json",
	goalSeekAttempts: "goal_seek_attempts.json",
}
