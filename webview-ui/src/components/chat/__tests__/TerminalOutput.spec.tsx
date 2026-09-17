import { render } from "@testing-library/react";
import Convert from "ansi-to-html";
import { TerminalOutput } from "../TerminalOutput";

describe("TerminalOutput", () => {
    it("renders plain text without ANSI codes", () => {
        const { container } = render(<TerminalOutput content="hello world" />);
        expect(container.textContent).toBe("hello world");
    });

    it("converts ANSI color codes to styled spans", () => {
        const { container } = render(
            <TerminalOutput content={"\x1B[32mgreen\x1B[0m"} />
        );
        const span = container.querySelector("span");
        expect(span).toBeTruthy();
        expect(span?.textContent).toBe("green");
    });

    it("escapes HTML in terminal output to prevent XSS", () => {
        const { container } = render(
            <TerminalOutput content={'<script>alert("xss")</script>'} />
        );
        expect(container.innerHTML).not.toContain("<script>");
        expect(container.textContent).toContain('<script>alert("xss")</script>');
    });

    it("escapes raw terminal content when ANSI conversion fails", () => {
        vi.spyOn(Convert.prototype, "toHtml").mockImplementationOnce(() => {
            throw new Error("converter failure");
        });

        const { container } = render(
            <TerminalOutput content={'\x1B[31m<img src=x onerror="alert(1)">'} />
        );

        expect(container.querySelector("img")).not.toBeInTheDocument();
        expect(container.textContent).toBe('<img src=x onerror="alert(1)">');
    });

    it("handles empty content", () => {
        const { container } = render(<TerminalOutput content="" />);
        expect(container.textContent).toBe("");
    });
});
