import { promises as fs } from "node:fs";

export default async function verify({ input, runDir }) {
  const checks = [];
  const filePath = String(input.filePath ?? "");
  const expectedText = String(input.text ?? "");

  let exists = false;
  try {
    await fs.access(filePath);
    exists = true;
    checks.push({
      id: "file-exists",
      ok: true,
      message: `File exists: ${filePath}`,
    });
  } catch {
    checks.push({
      id: "file-exists",
      ok: false,
      message: `File does not exist: ${filePath}`,
    });
  }

  if (!exists) {
    return {
      ok: false,
      summary: "Verifier failed because the expected file was not created.",
      checks,
      runDir,
    };
  }

  let actualText = "";
  try {
    actualText = await fs.readFile(filePath, "utf8");
    const matches = actualText === expectedText;
    checks.push({
      id: "text-match",
      ok: matches,
      message: matches ? "Saved file content matches the expected text." : "Saved file content does not match the expected text.",
      details: {
        expectedText,
        actualText,
      },
    });
  } catch (error) {
    checks.push({
      id: "text-read",
      ok: false,
      message: "Unable to read saved file as UTF-8 text.",
      details: String(error),
    });
  }

  const ok = checks.every((check) => check.ok);
  return {
    ok,
    summary: ok ? "Verifier confirmed that Notepad created the target file with exact content." : "Verifier rejected the run because file contents were missing or incorrect.",
    checks,
    runDir,
  };
}
