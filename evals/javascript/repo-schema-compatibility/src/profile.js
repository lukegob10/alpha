export function encodeProfile(profile) {
	return { id: profile.id, displayName: profile.displayName }
}
export function decodeProfile(row) {
	return { id: row.id, displayName: row.displayName }
}
