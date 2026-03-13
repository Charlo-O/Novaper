import type { ResponsesClient } from "./responsesClient.js";

export type AgentRoute = "cli" | "desktop" | "planner";

const CLASSIFIER_SYSTEM_PROMPT = [
  "You are a task router. Given a user instruction for a Windows computer, classify it as:",
  "- 'cli' if it can be completed entirely via command line, terminal, code editing, file operations, shell commands, git, or programming tasks.",
  "- 'desktop' if it requires a single GUI interaction such as clicking buttons, visual UI, mouse operations, interacting with app windows, or any visual/screen-based task.",
  "- 'planner' if the instruction is complex and involves multiple distinct steps, multiple applications, or requires task decomposition (e.g., 'open WeChat, find Zhang San, and send him the report from WPS').",
  "- Also choose 'planner' whenever the user asks to open or switch to an app/site and then accomplish another goal inside it, such as searching, playing, sending, downloading, logging in, comparing, or verifying a result.",
  "- Examples that must be 'planner': 'open Apple Music and play Jay Chou', 'open Chrome and search openclaw', 'open WeChat and send a message', 'go to a website and compare two products'.",
  "- Only choose 'desktop' when one short GUI action is sufficient, such as 'click the blue button', 'close this window', or 'open the current app menu'.",
  "",
  "Respond with exactly one word: cli, desktop, or planner.",
].join("\n");

export async function classifyInstruction(
  instruction: string,
  client: ResponsesClient,
  model: string,
): Promise<AgentRoute> {
  try {
    const response = await client.createResponse({
      model,
      input: [
        { role: "developer", content: CLASSIFIER_SYSTEM_PROMPT },
        { role: "user", content: instruction },
      ],
      tools: [],
    });

    const outputText =
      typeof response.output_text === "string"
        ? response.output_text.trim().toLowerCase()
        : "";

    if (outputText === "cli") return "cli";
    if (outputText === "planner") return "planner";
    return "desktop";
  } catch {
    // On any classification failure, fall back to desktop (safer default)
    return "desktop";
  }
}
