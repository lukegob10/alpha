/** All destinations supported by the image response parser, before its MIME type is known. */
export function getImageOutputPaths(requestedPath: string): string[] {
	return /\.(png|jpg|jpeg)$/i.test(requestedPath) ? [requestedPath] : [`${requestedPath}.png`, `${requestedPath}.jpg`]
}
