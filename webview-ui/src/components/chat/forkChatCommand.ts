export const forkChatCommandName = "fork"

export function parseForkChatCommand(text: string): { displayName?: string } | undefined {
	const match = /^\/fork(?:[^\S\r\n]+([^\r\n]+))?$/.exec(text.trim())
	return match ? { displayName: match[1]?.trim() || undefined } : undefined
}
