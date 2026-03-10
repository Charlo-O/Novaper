import type { DesktopSidecar } from "../../desktop-runtime/src/sidecar.js";
import type { ResponsesClient } from "./responsesClient.js";

export interface FrameSequence {
  frames: Array<{ base64: string; timestamp: number }>;
  capturedAt: string;
  intervalMs: number;
}

export interface VideoObserver {
  /** Capture N frames at interval, useful for detecting animation/loading states */
  captureSequence(sidecar: DesktopSidecar, frames: number, intervalMs: number): Promise<FrameSequence>;

  /** Compare before/after screenshots and describe changes using LLM */
  describeDelta(before: string, after: string, client: ResponsesClient, model: string): Promise<string>;
}

export function createVideoObserver(): VideoObserver {
  return {
    async captureSequence(sidecar, frameCount, intervalMs) {
      const frames = await sidecar.captureFrameSequence(frameCount, intervalMs);
      return {
        frames,
        capturedAt: new Date().toISOString(),
        intervalMs,
      };
    },

    async describeDelta(beforeBase64, afterBase64, client, model) {
      try {
        const response = await client.createResponse({
          model,
          instructions: "You are a visual change detector. Compare the two screenshots and describe what changed concisely.",
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "Compare these two desktop screenshots. Describe what changed between BEFORE and AFTER in 1-2 sentences." },
                { type: "input_image", image_url: `data:image/png;base64,${beforeBase64}`, detail: "high" as const },
                { type: "input_image", image_url: `data:image/png;base64,${afterBase64}`, detail: "high" as const },
              ],
            },
          ],
        });
        return response.output_text || "No changes detected.";
      } catch {
        return "Unable to analyze visual delta.";
      }
    },
  };
}

/** Manages a live frame stream for a session, pushing JPEG frames via callback */
export class FrameStreamer {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private subscribers = new Set<(frame: { base64: string; timestamp: number; width: number; height: number }) => void>();

  constructor(
    private readonly sidecar: DesktopSidecar,
    private readonly fps: number = 2,
  ) {}

  start(): void {
    if (this.intervalId) return;
    const intervalMs = Math.max(200, Math.round(1000 / this.fps));

    this.intervalId = setInterval(async () => {
      if (this.subscribers.size === 0) return;
      try {
        const screenshot = await this.sidecar.captureScreenshot();
        const frame = {
          base64: screenshot.imageBase64,
          timestamp: Date.now(),
          width: screenshot.width,
          height: screenshot.height,
        };
        for (const sub of this.subscribers) {
          try {
            sub(frame);
          } catch {
            // ignore
          }
        }
      } catch {
        // capture failed, skip frame
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  subscribe(fn: (frame: { base64: string; timestamp: number; width: number; height: number }) => void): () => void {
    this.subscribers.add(fn);
    if (this.subscribers.size === 1) this.start();
    return () => {
      this.subscribers.delete(fn);
      if (this.subscribers.size === 0) this.stop();
    };
  }
}
