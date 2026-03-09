import { spawn } from "node:child_process";
import path from "node:path";

const sidecarScript = path.resolve(process.cwd(), "agents/sidecar-win/Invoke-Sidecar.ps1");

interface RpcEnvelope<TArgs> {
  command: string;
  args?: TArgs;
}

interface RpcResult<TData> {
  ok: boolean;
  data?: TData;
  error?: {
    message: string;
    stack?: string;
  };
}

export async function invokePowerShell<TArgs, TData>(command: string, args?: TArgs): Promise<TData> {
  const envelope: RpcEnvelope<TArgs> = { command, args };
  const payloadBase64 = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");

  return new Promise<TData>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", sidecarScript, "-PayloadBase64", payloadBase64],
      {
        cwd: process.cwd(),
        windowsHide: true,
      },
    );

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));

    child.on("error", reject);
    child.on("close", (code) => {
      const rawStdout = Buffer.concat(stdout).toString("utf8").trim();
      const rawStderr = Buffer.concat(stderr).toString("utf8").trim();

      if (code !== 0) {
        reject(new Error(rawStderr || rawStdout || `PowerShell exited with code ${code}`));
        return;
      }

      if (!rawStdout) {
        reject(new Error("PowerShell sidecar returned no output."));
        return;
      }

      let parsed: RpcResult<TData>;
      try {
        parsed = JSON.parse(rawStdout) as RpcResult<TData>;
      } catch (error) {
        reject(new Error(`Unable to parse PowerShell output: ${rawStdout}\n${String(error)}`));
        return;
      }

      if (!parsed.ok) {
        reject(new Error(parsed.error?.message ?? "Unknown sidecar error."));
        return;
      }

      resolve(parsed.data as TData);
    });
  });
}
