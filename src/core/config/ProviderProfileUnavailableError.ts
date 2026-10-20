/** Safe identity metadata only; never attach a saved configuration or raw validation values. */
export class ProviderProfileUnavailableError extends Error {
	constructor(
		public readonly code: "invalid" | "unsupported",
		public readonly profile: { id: string; name: string },
		public readonly invalidFields: string[] = [],
	) {
		super(
			code === "invalid"
				? `Saved provider profile "${profile.name}" has invalid settings. Edit or replace this profile before use.`
				: `Saved provider profile "${profile.name}" uses an unsupported provider. Reconfigure it before use.`,
		)
		this.name = "ProviderProfileUnavailableError"
	}
}
