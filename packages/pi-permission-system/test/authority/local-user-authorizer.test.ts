import { describe, expect, it, vi } from "vitest";
import { LocalUserAuthorizer } from "#src/authority/local-user-authorizer";
import type { PermissionPromptDecision } from "#src/authority/permission-dialog";
import type { requestPermissionDecision } from "#src/authority/permission-prompt-component";
import type { PromptPermissionDetails } from "#src/authority/permission-prompter";
import type { BashCommandReviewer } from "#src/bash-command-reviewer";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeDetails(
  overrides?: Partial<PromptPermissionDetails>,
): PromptPermissionDetails {
  return {
    requestId: "req-123",
    source: "tool_call",
    agentName: "test-agent",
    message: "Allow read?",
    toolName: "read",
    ...overrides,
  };
}

/** A `PermissionPromptUi` double; the tool-expansion accessors go unused here. */
function makePromptUi() {
  return {
    select: vi.fn(),
    input: vi.fn(),
    custom: vi.fn(),
    getToolsExpanded: vi.fn(() => false),
    setToolsExpanded: vi.fn(),
  };
}

function makeDeps(
  overrides: {
    requestPermissionDecision?: typeof requestPermissionDecision;
    commandReviewer?: BashCommandReviewer;
  } = {},
) {
  const events = {
    emit: vi.fn(),
    on: vi.fn().mockReturnValue(() => undefined),
  };
  const ui = makePromptUi();
  const decisionFn =
    overrides.requestPermissionDecision ??
    vi
      .fn<typeof requestPermissionDecision>()
      .mockResolvedValue({ approved: true, state: "approved" });
  return {
    deps: {
      ui,
      mode: "tui" as const,
      events,
      getPromptPreferences: () => ({ doublePressToConfirm: true }),
      requestPermissionDecision: decisionFn,
      commandReviewer: overrides.commandReviewer,
    },
    events,
    ui,
    decisionFn,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("LocalUserAuthorizer", () => {
  it("emits a UI prompt event with normalized surface and value", async () => {
    const { deps, events } = makeDeps();
    const authorizer = new LocalUserAuthorizer(deps);

    await authorizer.authorize(
      makeDetails({
        toolName: "bash",
        command: "git push",
        toolInputPreview: "git push",
      }),
    );

    expect(events.emit).toHaveBeenCalledWith("permissions:ui_prompt", {
      requestId: "req-123",
      source: "tool_call",
      surface: "bash",
      value: "git push",
      agentName: "test-agent",
      message: "Allow read?",
      forwarding: null,
    });
  });

  it("normalizes skill prompt events to the skill surface", async () => {
    const { deps, events } = makeDeps();
    const authorizer = new LocalUserAuthorizer(deps);

    await authorizer.authorize(
      makeDetails({
        source: "skill_input",
        toolName: undefined,
        skillName: "deploy-helper",
      }),
    );

    expect(events.emit).toHaveBeenCalledWith("permissions:ui_prompt", {
      requestId: "req-123",
      source: "skill_input",
      surface: "skill",
      value: "deploy-helper",
      agentName: "test-agent",
      message: "Allow read?",
      forwarding: null,
    });
  });

  it("calls requestPermissionDecision with the threaded view, title, and message", async () => {
    const { deps, ui, decisionFn } = makeDeps();
    const authorizer = new LocalUserAuthorizer(deps);

    await authorizer.authorize(makeDetails());

    expect(decisionFn).toHaveBeenCalledWith(
      { mode: "tui", ui, doublePressToConfirm: true },
      "Permission Required",
      "Allow read?",
      undefined,
    );
  });

  describe("bash command review", () => {
    it("adds the explanation and security review after the full command", async () => {
      const commandReviewer: BashCommandReviewer = {
        review: vi.fn(async () => ({
          explanation: "Reads input and prints each item.",
          securityAssessment: "no-obvious-concerns" as const,
          securitySummary: "No concrete security concerns are visible.",
        })),
      };
      const { deps, events, decisionFn } = makeDeps({ commandReviewer });
      const authorizer = new LocalUserAuthorizer(deps);
      const message = [
        "Command requiring approval:",
        "xargs echo",
        "",
        "Why this needs approval:",
        "This part uses a command wrapper.",
        "",
        "Full command:",
        `printf 'test' | xargs echo`,
        "",
        "Allow this command?",
      ].join("\n");

      await authorizer.authorize(
        makeDetails({
          toolName: "bash",
          command: "xargs echo",
          fullCommand: `printf 'test' | xargs echo`,
          message,
          accessIntent: {
            surface: "bash",
            matchValues: ["xargs echo"],
            boundaryValue: null,
          },
        }),
      );

      expect(commandReviewer.review).toHaveBeenCalledWith({
        command: "xargs echo",
        fullCommand: `printf 'test' | xargs echo`,
      });
      const reviewedMessage = [
        "Command requiring approval:",
        "xargs echo",
        "",
        "Why this needs approval:",
        "This part uses a command wrapper.",
        "",
        "Full command:",
        `printf 'test' | xargs echo`,
        "",
        "What it does:",
        "Reads input and prints each item.",
        "",
        "Security review:",
        "No obvious concerns — No concrete security concerns are visible.",
        "",
        "Allow this command?",
      ].join("\n");
      expect(decisionFn).toHaveBeenCalledWith(
        expect.anything(),
        "Permission Required",
        reviewedMessage,
        undefined,
      );
      expect(events.emit).toHaveBeenCalledWith(
        "permissions:ui_prompt",
        expect.objectContaining({ message: reviewedMessage }),
      );
    });

    it("does not review a command attached to a non-bash gate", async () => {
      const commandReviewer: BashCommandReviewer = {
        review: vi.fn(async () => null),
      };
      const { deps } = makeDeps({ commandReviewer });
      const authorizer = new LocalUserAuthorizer(deps);

      await authorizer.authorize(
        makeDetails({
          command: "cat /tmp/secret",
          accessIntent: {
            surface: "external_directory",
            matchValues: ["/tmp/secret"],
            boundaryValue: "/tmp/secret",
          },
        }),
      );

      expect(commandReviewer.review).not.toHaveBeenCalled();
    });

    it("continues to the original prompt when the review fails", async () => {
      const commandReviewer: BashCommandReviewer = {
        review: vi.fn(async () => {
          throw new Error("review unavailable");
        }),
      };
      const { deps, decisionFn } = makeDeps({ commandReviewer });
      const authorizer = new LocalUserAuthorizer(deps);

      await authorizer.authorize(
        makeDetails({
          toolName: "bash",
          command: "git push",
          message: "Original prompt",
          accessIntent: {
            surface: "bash",
            matchValues: ["git push"],
            boundaryValue: null,
          },
        }),
      );

      expect(decisionFn).toHaveBeenCalledWith(
        expect.anything(),
        "Permission Required",
        "Original prompt",
        undefined,
      );
    });
  });

  it("passes the sessionLabel option when present", async () => {
    const { deps, decisionFn } = makeDeps();
    const authorizer = new LocalUserAuthorizer(deps);

    await authorizer.authorize(
      makeDetails({ sessionLabel: "Yes, for 'read' tool" }),
    );

    expect(decisionFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.any(String),
      { sessionLabel: "Yes, for 'read' tool" },
    );
  });

  it("emits the UI event before calling requestPermissionDecision", async () => {
    const calls: string[] = [];
    const events = {
      emit: vi.fn(() => {
        calls.push("emit");
      }),
      on: vi.fn().mockReturnValue(() => undefined),
    };
    const ui = makePromptUi();
    const decisionFn = vi.fn<typeof requestPermissionDecision>(() => {
      calls.push("dialog");
      return Promise.resolve({ approved: true, state: "approved" });
    });
    const authorizer = new LocalUserAuthorizer({
      ui,
      mode: "tui",
      events,
      getPromptPreferences: () => ({ doublePressToConfirm: true }),
      requestPermissionDecision: decisionFn,
    });

    await authorizer.authorize(makeDetails());

    expect(calls).toEqual(["emit", "dialog"]);
  });

  describe("forwarded provenance", () => {
    it("emits a non-degraded forwarded event with populated forwarding and the child's display projection", async () => {
      const { deps, events } = makeDeps();
      const authorizer = new LocalUserAuthorizer(deps);

      await authorizer.authorize(
        makeDetails({
          source: "tool_call",
          agentName: "Explore",
          message:
            "Subagent 'Explore' requested permission.\n\nAllow git push?",
          surface: "bash",
          value: "git push",
          forwarding: {
            requesterAgentName: "Explore",
            requesterSessionId: "child-session",
          },
        }),
      );

      expect(events.emit).toHaveBeenCalledWith("permissions:ui_prompt", {
        requestId: "req-123",
        source: "tool_call",
        surface: "bash",
        value: "git push",
        agentName: "Explore",
        message: "Subagent 'Explore' requested permission.\n\nAllow git push?",
        forwarding: {
          requesterAgentName: "Explore",
          requesterSessionId: "child-session",
        },
      });
    });

    it("uses the '(Subagent)' dialog title when the ask is forwarded", async () => {
      const { deps, ui, decisionFn } = makeDeps();
      const authorizer = new LocalUserAuthorizer(deps);

      await authorizer.authorize(
        makeDetails({
          forwarding: {
            requesterAgentName: "Explore",
            requesterSessionId: "child-session",
          },
        }),
      );

      expect(decisionFn).toHaveBeenCalledWith(
        { mode: "tui", ui, doublePressToConfirm: true },
        "Permission Required (Subagent)",
        "Allow read?",
        undefined,
      );
    });

    it("offers a sessionScope when the forwarded ask carries a suggestion", async () => {
      const { deps, decisionFn } = makeDeps();
      const authorizer = new LocalUserAuthorizer(deps);

      await authorizer.authorize(
        makeDetails({
          toolName: "bash",
          command: "git push",
          forwarding: {
            requesterAgentName: "Explore",
            requesterSessionId: "child-session",
          },
          sessionApproval: { surface: "bash", patterns: ["git *"] },
        }),
      );

      expect(decisionFn).toHaveBeenCalledWith(
        expect.anything(),
        "Permission Required (Subagent)",
        expect.any(String),
        {
          sessionScope: {
            subagentLabel: "This subagent ('Explore') only",
            servingSessionLabel:
              'The whole session — allow bash "git *" for parent and all subagents',
          },
        },
      );
    });

    it("offers no sessionScope for a forwarded ask without a suggestion", async () => {
      const { deps, decisionFn } = makeDeps();
      const authorizer = new LocalUserAuthorizer(deps);

      await authorizer.authorize(
        makeDetails({
          forwarding: {
            requesterAgentName: "Explore",
            requesterSessionId: "child-session",
          },
        }),
      );

      expect(decisionFn).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.any(String),
        undefined,
      );
    });
  });

  it("returns the decision from requestPermissionDecision", async () => {
    const decision: PermissionPromptDecision = {
      approved: false,
      state: "denied",
    };
    const { deps } = makeDeps({
      requestPermissionDecision: vi
        .fn<typeof requestPermissionDecision>()
        .mockResolvedValue(decision),
    });
    const authorizer = new LocalUserAuthorizer(deps);

    const result = await authorizer.authorize(makeDetails());

    expect(result).toEqual(decision);
  });
});
