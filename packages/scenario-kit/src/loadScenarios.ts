import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ScenarioDefinition, ScenarioManifest, VerifierResult } from "./types.js";

async function defaultVerifier(): Promise<VerifierResult> {
  return {
    ok: true,
    summary: "No verifier module provided.",
    checks: [
      {
        id: "default-verifier",
        ok: true,
        message: "Skipped explicit verification because no verifier was configured.",
      },
    ],
  };
}

export async function loadScenarios(rootDir: string): Promise<ScenarioDefinition[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const scenarios: ScenarioDefinition[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const scenarioDir = path.join(rootDir, entry.name);
    const manifestPath = path.join(scenarioDir, "manifest.json");
    const promptPath = path.join(scenarioDir, "prompt.md");
    const verifierPath = path.join(scenarioDir, "verifier.mjs");

    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as ScenarioManifest;
    const prompt = await fs.readFile(promptPath, "utf8");
    let verify = defaultVerifier;

    try {
      await fs.access(verifierPath);
      const verifierModule = await import(pathToFileURL(verifierPath).href);
      if (typeof verifierModule.default === "function") {
        verify = verifierModule.default;
      }
    } catch {
      verify = defaultVerifier;
    }

    scenarios.push({ manifest, prompt, verify });
  }

  return scenarios.sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
}
