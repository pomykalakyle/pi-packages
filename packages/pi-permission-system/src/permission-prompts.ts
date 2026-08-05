import { classifyToolKind, isMcpCheck } from "./access-intent/tool-kind";
import { matchQualifier } from "./denial-messages";
import type { SkillPromptEntry } from "./skill-prompt-sanitizer";
import type { ToolPreviewFormatter } from "./tool-preview-formatter";
import type { PermissionCheckResult } from "./types";
import { getNonEmptyString, toRecord } from "./value-guards";

// NOTE: formatDenyReason, formatUserDeniedReason, and
// formatPermissionHardStopHint have been moved to denial-messages.ts.
// This module retains only pre-check messages and user-facing ask prompts.

export function formatMissingToolNameReason(): string {
  return "Tool call was blocked because no tool name was provided. Use a registered tool name from pi.getAllTools().";
}

export function formatUnknownToolReason(
  toolName: string,
  availableToolNames: readonly string[],
): string {
  const preview = availableToolNames.slice(0, 10);
  const suffix = availableToolNames.length > preview.length ? ", ..." : "";
  const availableList =
    preview.length > 0 ? `${preview.join(", ")}${suffix}` : "none";

  const mcpHint =
    classifyToolKind(toolName) === "mcp"
      ? ""
      : ' If this was intended as an MCP server tool, call the registered \'mcp\' tool when available (for example: {"tool":"server:tool"}).';

  return `Tool '${toolName}' is not registered in this runtime and was blocked before permission checks.${mcpHint} Registered tools: ${availableList}.`;
}

export function formatAskPrompt(
  result: PermissionCheckResult,
  agentName?: string,
  input?: unknown,
  formatter?: ToolPreviewFormatter,
): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";

  if (classifyToolKind(result.toolName) === "bash") {
    const subCommand = result.command ?? "";
    const commandContext = matchQualifier(undefined, result.commandContext);
    const fullCommand = getNonEmptyString(toRecord(input).command);
    const sections = [
      formatBashAskReason(result),
      `Command requiring approval${commandContext ? ` ${commandContext}` : ""}:\n${subCommand}`,
    ];
    if (fullCommand && fullCommand !== subCommand) {
      sections.push(`Full command:\n${fullCommand}`);
    }
    if (agentName) {
      sections.push(`Requested by:\n${subject}`);
    }
    sections.push("Allow this command?");
    return sections.join("\n\n");
  }

  if (isMcpCheck(result) && result.target) {
    const patternInfo = result.matchedPattern
      ? ` (matched '${result.matchedPattern}')`
      : "";
    const mcpPreview = formatter
      ? formatter.formatToolInputForPrompt("mcp", input)
      : "";
    const previewSuffix = mcpPreview ? ` ${mcpPreview}` : "";
    return `${subject} requested MCP target '${result.target}'${patternInfo}${previewSuffix}. Allow this call?`;
  }

  const patternInfo = result.matchedPattern
    ? ` (matched '${result.matchedPattern}')`
    : "";
  const inputPreview = formatter
    ? formatter.formatToolInputForPrompt(result.toolName, input)
    : "";
  const inputSuffix = inputPreview ? ` ${inputPreview}` : "";
  return `${subject} requested tool '${result.toolName}'${patternInfo}${inputSuffix}. Allow this call?`;
}

function formatBashAskReason(result: PermissionCheckResult): string {
  switch (result.matchedPattern) {
    case "<indirection-bash-wrapper>":
      return "Reason: This part uses a command wrapper that can run another command indirectly.";
    case "<opaque-bash-wrapper>":
      return "Reason: This part contains a shell payload the permission system cannot inspect separately.";
    case "<unparseable-bash-command>":
      return "Reason: The permission system could not reliably parse this into checkable command parts.";
    case undefined:
      return "Reason: The active bash policy requires confirmation for this part of the command.";
    default:
      return `Reason: Bash rule '${result.matchedPattern}' requires confirmation for this part of the command.`;
  }
}

export function formatSkillAskPrompt(
  skillName: string,
  agentName?: string,
): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  return `${subject} requested skill '${skillName}'. Allow loading this skill?`;
}

export function formatSkillPathAskPrompt(
  skill: SkillPromptEntry,
  readPath: string,
  agentName?: string,
): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  return `${subject} requested access to skill '${skill.name}' via '${readPath}'. Allow this read?`;
}

// formatSkillPathDenyReason has been moved to denial-messages.ts.
