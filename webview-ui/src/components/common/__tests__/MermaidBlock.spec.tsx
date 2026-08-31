const mermaidMocks = vi.hoisted(() => ({
	initialize: vi.fn(),
	parse: vi.fn(),
	render: vi.fn(),
}))

vi.mock("mermaid", () => ({
	default: mermaidMocks,
}))

vi.mock("../CodeBlock", () => ({
	default: () => null,
}))

vi.mock("../MermaidButton", () => ({
	MermaidButton: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

describe("MermaidBlock security configuration", () => {
	it("initializes Mermaid with strict sanitization", async () => {
		await import("../MermaidBlock")

		expect(mermaidMocks.initialize).toHaveBeenCalledWith(
			expect.objectContaining({
				startOnLoad: false,
				securityLevel: "strict",
			}),
		)
	})
})
