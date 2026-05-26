import type { TelemetrySetting } from "@alpha-code/types"

class TelemetryClient {
	private static instance: TelemetryClient
	private static telemetryEnabled: boolean = false

	public updateTelemetryState(_telemetrySetting: TelemetrySetting, _apiKey?: string, _distinctId?: string) {
		TelemetryClient.telemetryEnabled = false
	}

	public static getInstance(): TelemetryClient {
		if (!TelemetryClient.instance) {
			TelemetryClient.instance = new TelemetryClient()
		}

		return TelemetryClient.instance
	}

	public capture(_eventName: string, _properties?: Record<string, any>) {
		return
	}
}

export const telemetryClient = TelemetryClient.getInstance()
