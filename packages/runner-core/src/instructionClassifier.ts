import type { ResponsesClient } from "./responsesClient.js";

const CLASSIFIER_SYSTEM_PROMPT = [
  "You are a task router. Given a user instruction for a Windows computer, classify it as:",
  "- 'cli' if it can be completed entirely via command line, terminal, code editing, file operations, shell commands, git, or programming tasks.",
  "- 'desktop' if it requires GUI interaction such as clicking buttons, visual UI, mouse operations, interacting with app windows, or any visual/screen-based task.",
  "",
  "Respond with exactly one word: cli or desktop.",
].join("\n");

export async function classifyInstruction(
  instruction: string,
  client: ResponsesClient,
  model: string,
): Promise<"cli" | "desktop"> {
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

    if (outputText === "cli") {
      return "cli";
    }

    return "desktop";
  } catch {
    // On any classification failure, fall back to desktop (safer default)
    return "desktop";
  }
}
