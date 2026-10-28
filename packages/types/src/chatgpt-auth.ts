/** Safe account projection; registrations and OAuth tokens remain in SecretStorage. */
export type ChatGptAuthStatus = {
	connected: boolean
	connecting: boolean
	email?: string
	availableModelIds?: string[]
	accountId?: string
	accounts?: Array<{ id: string; email?: string; connected: boolean }>
}
