import type OpenAI from "openai";
import type { Response, ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";

export interface ResponsesClient {
  supportsComputerTool?: boolean;
  supportsImageInput?: boolean;
  createResponse(input: ResponseCreateParamsNonStreaming): Promise<Response>;
}

export function createResponsesClient(getClient: () => Promise<OpenAI>): ResponsesClient {
  return {
    supportsComputerTool: true,
    supportsImageInput: true,
    async createResponse(input: ResponseCreateParamsNonStreaming) {
      const client = await getClient();
      return client.responses.create(input);
    },
  };
}
