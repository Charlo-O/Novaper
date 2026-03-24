import type { InstalledSkill } from "./pluginTypes.js";
import type { ResponsesClient } from "./responsesClient.js";

export interface SkillExecutionResult {
  success: boolean;
  output: string;
  skillUsed: string;
  error?: string;
}

/**
 * Execute a task using a resolved skill.
 * The skill's content is injected as a developer prompt, and the task
 * description is sent as the user message.
 */
export async function executeWithSkill(
  skill: InstalledSkill,
  taskDescription: string,
  client: ResponsesClient,
  model: string,
  tools?: any[],
): Promise<SkillExecutionResult> {
  try {
    const response = await client.createResponse({
      model,
      input: [
        { role: "developer", content: skill.content },
        { role: "user", content: taskDescription },
      ],
      tools: tools ?? [],
    });

    const outputText =
      typeof response.output_text === "string"
        ? response.output_text.trim()
        : "";

    return {
      success: true,
      output: outputText,
      skillUsed: skill.name,
    };
  } catch (error) {
    return {
      success: false,
      output: "",
      skillUsed: skill.name,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
