export interface DisplayProfile {
  width: number;
  height: number;
  scale: number;
  single_monitor: boolean;
}

export interface DesktopPreconditions {
  machine_online: boolean;
  interactive_session: boolean;
  foreground_guard: boolean;
}

export interface ScenarioManifest {
  id: string;
  title: string;
  owner: string;
  description?: string;
  target_apps: string[];
  display_profile: DisplayProfile;
  desktop_preconditions: DesktopPreconditions;
  execution_order: Array<"uia" | "code" | "vision">;
  autonomous_mode: boolean;
  tool_profiles: {
    code: string[];
    vision_actions: string[];
  };
  input_schema: Record<string, unknown>;
  success_criteria: string[];
  verifiers: Array<Record<string, unknown>>;
}

export interface VerifierCheck {
  id: string;
  ok: boolean;
  message: string;
  details?: unknown;
}

export interface VerifierResult {
  ok: boolean;
  summary: string;
  checks: VerifierCheck[];
}

export interface ScenarioDefinition {
  manifest: ScenarioManifest;
  prompt: string;
  verify: (context: {
    input: Record<string, unknown>;
    runDir: string;
  }) => Promise<VerifierResult>;
}
