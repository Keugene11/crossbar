import type Anthropic from "@anthropic-ai/sdk";
import { CrossbarError } from "../../errors.js";
import type { Endpoint } from "../../registry/catalog.js";
import type {
  ChatCompletionRequest,
  ContentPart,
  Message,
  ToolChoice,
} from "../../schemas/openai.js";
import { isUnsupported, normalizeStop, resolveMaxTokens, toolChoiceVariant } from "../common.js";

type MessageParam = Anthropic.Messages.MessageParam;
type ContentBlockParam = Anthropic.Messages.ContentBlockParam;
type TextBlockParam = Anthropic.Messages.TextBlockParam;

/** A `data:` URI becomes a base64 source; anything else is passed by url. */
function imageBlock(part: Extract<ContentPart, { type: "image_url" }>): ContentBlockParam {
  const url = part.image_url.url;
  const dataUri = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (dataUri) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: dataUri[1] as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
        data: dataUri[2] ?? "",
      },
    };
  }
  return { type: "image", source: { type: "url", url } };
}

function partsToBlocks(content: string | ContentPart[]): ContentBlockParam[] {
  if (typeof content === "string") {
    return content.length ? [{ type: "text", text: content }] : [];
  }
  return content.map((p) => (p.type === "text" ? { type: "text", text: p.text } : imageBlock(p)));
}

function textParts(content: string | Array<{ type: "text"; text: string }>): TextBlockParam[] {
  if (typeof content === "string") {
    return content.length ? [{ type: "text", text: content }] : [];
  }
  return content.map((p) => ({ type: "text", text: p.text }));
}

/**
 * Splits system prompts out of `messages` and converts the rest.
 *
 * Anthropic has no `system` role inside `messages`, and no `tool` role at all:
 * tool results are `tool_result` blocks carried by a *user* message. Consecutive
 * tool results must land in ONE user message -- splitting them across several
 * teaches the model to stop emitting parallel tool calls.
 */
export function convertMessages(messages: Message[]): {
  system: TextBlockParam[];
  messages: MessageParam[];
} {
  const system: TextBlockParam[] = [];
  const out: MessageParam[] = [];

  const push = (role: "user" | "assistant", blocks: ContentBlockParam[]): void => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    // Merging same-role neighbours keeps the alternation Anthropic requires.
    if (last && last.role === role && Array.isArray(last.content)) {
      (last.content as ContentBlockParam[]).push(...blocks);
      return;
    }
    out.push({ role, content: blocks });
  };

  for (const m of messages) {
    switch (m.role) {
      case "system":
      case "developer":
        system.push(...textParts(m.content));
        break;

      case "user":
        push("user", partsToBlocks(m.content));
        break;

      case "assistant": {
        const blocks: ContentBlockParam[] = [];
        if (m.content != null) blocks.push(...partsToBlocks(m.content));
        for (const call of m.tool_calls ?? []) {
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.function.name,
            input: parseToolArguments(call.function.arguments),
          });
        }
        push("assistant", blocks);
        break;
      }

      case "tool":
        push("user", [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id,
            content: textParts(m.content),
          },
        ]);
        break;
    }
  }

  return { system, messages: out };
}

/**
 * Tool arguments arrive as a JSON *string* from the client. Malformed JSON is a
 * client bug, so surface it as a 400 rather than shipping a broken block
 * upstream and getting an opaque provider error back.
 */
function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new CrossbarError({
      status: 400,
      code: "invalid_request",
      message: `tool_calls[].function.arguments is not valid JSON: ${raw.slice(0, 200)}`,
      retryable: false,
    });
  }
}

function convertToolChoice(
  choice: ToolChoice,
  endpoint: Endpoint,
  parallel: boolean | undefined,
): Anthropic.Messages.ToolChoice | undefined {
  if (isUnsupported(endpoint, "tool_choice", toolChoiceVariant(choice))) return undefined;
  const disable = parallel === false ? { disable_parallel_tool_use: true } : {};

  if (choice === "none") return { type: "none" };
  if (choice === "auto") return { type: "auto", ...disable };
  if (choice === "required") return { type: "any", ...disable };
  return { type: "tool", name: choice.function.name, ...disable };
}

function convertTools(tools: ChatCompletionRequest["tools"]): Anthropic.Messages.ToolUnion[] {
  return (tools ?? []).map((t) => ({
    name: t.function.name,
    ...(t.function.description ? { description: t.function.description } : {}),
    input_schema: (t.function.parameters ?? {
      type: "object",
      properties: {},
    }) as Anthropic.Messages.Tool.InputSchema,
    ...(t.function.strict ? { strict: true } : {}),
  }));
}

function mapEffort(effort: string | undefined): Anthropic.Messages.OutputConfig["effort"] {
  switch (effort) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "max":
      return "max";
    default:
      return undefined;
  }
}

/** Translate a canonical request into Anthropic Messages API parameters. */
export function toMessageCreateParams(
  request: ChatCompletionRequest,
  endpoint: Endpoint,
): Anthropic.Messages.MessageCreateParams {
  const { system, messages } = convertMessages(request.messages);

  const params: Anthropic.Messages.MessageCreateParams = {
    model: endpoint.upstreamModelId,
    max_tokens: resolveMaxTokens(request, endpoint),
    messages,
  };

  if (system.length) params.system = system;

  const stop = normalizeStop(request.stop);
  if (stop) params.stop_sequences = stop;

  // Sampling params are a hard 400 on the current Anthropic tier, so the
  // endpoint quirk list gates them rather than the request.
  if (request.temperature !== undefined && !isUnsupported(endpoint, "temperature"))
    params.temperature = request.temperature;
  if (request.top_p !== undefined && !isUnsupported(endpoint, "top_p"))
    params.top_p = request.top_p;
  if (request.top_k !== undefined && !isUnsupported(endpoint, "top_k"))
    params.top_k = request.top_k;

  if (request.tools?.length && endpoint.supportsTools) {
    params.tools = convertTools(request.tools);
    if (request.tool_choice !== undefined) {
      const choice = convertToolChoice(request.tool_choice, endpoint, request.parallel_tool_calls);
      if (choice) params.tool_choice = choice;
    } else if (request.parallel_tool_calls === false) {
      params.tool_choice = { type: "auto", disable_parallel_tool_use: true };
    }
  }

  const outputConfig: Anthropic.Messages.OutputConfig = {};
  if (request.response_format?.type === "json_schema") {
    outputConfig.format = {
      type: "json_schema",
      schema: request.response_format.json_schema.schema,
    };
  }
  const effort = mapEffort(request.reasoning_effort);
  if (effort) outputConfig.effort = effort;
  if (Object.keys(outputConfig).length) params.output_config = outputConfig;

  // Adaptive is the only thinking mode on current models; `budget_tokens` is
  // rejected outright, so it is never emitted.
  if (endpoint.supportsReasoning) {
    params.thinking = { type: "adaptive", display: "summarized" };
  }

  if (request.user !== undefined) params.metadata = { user_id: request.user };

  return params;
}
