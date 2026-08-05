import type {
  Api,
  AssistantMessage,
  Context,
  Model,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  type BashCommandReviewerDependencies,
  createBashCommandReviewer,
} from "#src/bash-command-reviewer";

const MODEL = {
  provider: "openai-codex",
  id: "gpt-5.6-luna",
} as unknown as Model<Api>;

function assistantToolCall(args: Record<string, unknown>): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "review-1",
        name: "provider_rewritten_name",
        arguments: args,
      },
    ],
    stopReason: "toolUse",
    timestamp: Date.now(),
  } as AssistantMessage;
}

function makeDependencies(
  reply: AssistantMessage = assistantToolCall({
    explanation: "Prints each input item.",
    securityAssessment: "no-obvious-concerns",
    securitySummary: "No concrete security concerns are visible.",
  }),
): BashCommandReviewerDependencies & {
  complete: Mock<BashCommandReviewerDependencies["complete"]>;
  registry: {
    find: Mock<(provider: string, modelId: string) => Model<Api> | undefined>;
    getApiKeyAndHeaders: Mock<
      (model: Model<Api>) => Promise<{
        ok: true;
        apiKey: string;
        headers: Record<string, string>;
        env: Record<string, string>;
      }>
    >;
  };
} {
  const complete = vi.fn<BashCommandReviewerDependencies["complete"]>(
    async () => reply,
  );
  const registry = {
    find: vi.fn((_: string, __: string): Model<Api> | undefined => MODEL),
    getApiKeyAndHeaders: vi.fn(async (_: Model<Api>) => ({
      ok: true as const,
      apiKey: "codex-oauth-token",
      headers: { "x-test": "1" },
      env: { PI_TEST: "yes" },
    })),
  };
  return { registry, complete, cwd: "/repo", timeoutMs: 5000 };
}

describe("createBashCommandReviewer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reviews the selected and full commands with Luna", async () => {
    const deps = makeDependencies();
    const onOutcome = vi.fn();
    deps.onOutcome = onOutcome;
    const reviewer = createBashCommandReviewer(deps);

    const review = await reviewer.review({
      command: "xargs echo",
      fullCommand: `printf 'test\\n' | xargs echo`,
    });

    expect(review).toEqual({
      explanation: "Prints each input item.",
      securityAssessment: "no-obvious-concerns",
      securitySummary: "No concrete security concerns are visible.",
    });
    expect(onOutcome).toHaveBeenCalledWith({
      status: "completed",
      latencyMs: expect.any(Number),
    });
    expect(deps.registry.find).toHaveBeenCalledWith(
      "openai-codex",
      "gpt-5.6-luna",
    );
    expect(deps.complete).toHaveBeenCalledTimes(1);
    const [model, context, options] = deps.complete.mock.calls[0] as [
      unknown,
      Context,
      {
        apiKey?: string;
        headers?: Record<string, string>;
        env?: Record<string, string>;
        reasoningEffort?: string;
        toolChoice?: string;
      },
    ];
    expect(model).toBe(MODEL);
    expect(context.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "Working directory: /repo",
              "",
              "Command requiring approval:",
              "xargs echo",
              "",
              "Full command:",
              `printf 'test\\n' | xargs echo`,
            ].join("\n"),
          },
        ],
        timestamp: expect.any(Number),
      },
    ]);
    expect(context.tools).toHaveLength(1);
    expect(context.tools?.[0]?.name).toBe("report_command_review");
    expect(options).toEqual({
      apiKey: "codex-oauth-token",
      headers: { "x-test": "1" },
      env: { PI_TEST: "yes" },
      reasoningEffort: "low",
      signal: expect.any(AbortSignal),
      toolChoice: "any",
    });
  });

  it("returns null when Luna cannot be resolved", async () => {
    const deps = makeDependencies();
    deps.registry.find.mockReturnValue(undefined);
    const reviewer = createBashCommandReviewer(deps);

    await expect(reviewer.review({ command: "git push" })).resolves.toBeNull();
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it("returns null for an invalid or free-text response", async () => {
    const reply = {
      role: "assistant",
      content: [{ type: "text", text: "Looks fine." }],
      stopReason: "stop",
      timestamp: Date.now(),
    } as AssistantMessage;
    const reviewer = createBashCommandReviewer(makeDependencies(reply));

    await expect(reviewer.review({ command: "git push" })).resolves.toBeNull();
  });

  it("returns null when the model call fails", async () => {
    const deps = makeDependencies();
    deps.complete.mockRejectedValue(new Error("unavailable"));
    const reviewer = createBashCommandReviewer(deps);

    await expect(reviewer.review({ command: "git push" })).resolves.toBeNull();
  });

  it("aborts a slow review and returns null", async () => {
    vi.useFakeTimers();
    const deps = makeDependencies();
    deps.timeoutMs = 1000;
    const onOutcome = vi.fn();
    deps.onOutcome = onOutcome;
    deps.complete.mockImplementation(
      (_model: unknown, _context: unknown, options: { signal?: AbortSignal }) =>
        new Promise<AssistantMessage>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    const reviewer = createBashCommandReviewer(deps);

    const result = reviewer.review({ command: "git push" });
    await vi.advanceTimersByTimeAsync(1000);

    await expect(result).resolves.toBeNull();
    expect(onOutcome).toHaveBeenCalledWith({
      status: "timeout",
      latencyMs: 1000,
    });
  });
});
