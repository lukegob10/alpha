import path from "node:path"
export function isAllowed(root, candidate) {
	return path.resolve(candidate).startsWith(path.resolve(root))
}
