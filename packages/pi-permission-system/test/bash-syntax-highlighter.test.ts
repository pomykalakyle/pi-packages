import { describe, expect, it } from "vitest";
import { highlightBashCommand } from "#src/bash-syntax-highlighter";

const theme = {
  fg(color: string, text: string) {
    return `<${color}>${text}</${color}>`;
  },
};

describe("highlightBashCommand", () => {
  it("highlights command positions without treating Git subcommands as shell built-ins", () => {
    const highlighted = highlightBashCommand(
      "git status --short --branch && git log -3 --oneline",
      theme,
    );

    expect(highlighted).toBe(
      [
        "<accent>git</accent>",
        "<text> status </text>",
        "<syntaxType>--short</syntaxType>",
        "<text> </text>",
        "<syntaxType>--branch</syntaxType>",
        "<text> </text>",
        "<syntaxOperator>&&</syntaxOperator>",
        "<text> </text>",
        "<accent>git</accent>",
        "<text> log </text>",
        "<syntaxType>-3</syntaxType>",
        "<text> </text>",
        "<syntaxType>--oneline</syntaxType>",
      ].join(""),
    );
    expect(highlighted).not.toContain("<accent>log</accent>");
  });

  it("uses standard Bash captures for syntax elements", () => {
    const highlighted = highlightBashCommand(
      `for item in alpha; do printf '%s\\n' "$item"; done # comment`,
      theme,
    );

    expect(highlighted).toContain("<syntaxKeyword>for</syntaxKeyword>");
    expect(highlighted).toContain("<accent>printf</accent>");
    expect(highlighted).toContain("<syntaxString>'%s\\n'</syntaxString>");
    expect(highlighted).toContain("<syntaxVariable>item</syntaxVariable>");
    expect(highlighted).toContain("<syntaxComment># comment</syntaxComment>");
  });
});
