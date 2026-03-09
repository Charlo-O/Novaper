import path from "node:path";
import { createServer } from "./server.js";
import { configureNetworkProxy } from "./networkProxy.js";

const port = Number(process.env.PORT ?? 3333);
const host = process.env.HOST ?? "127.0.0.1";
const model = process.env.OPENAI_MODEL ?? "gpt-5.4";
const rootDir = path.resolve(process.cwd());
const proxy = configureNetworkProxy();

const app = await createServer({
  rootDir,
  port,
  host,
  model,
  openAIApiKey: process.env.OPENAI_API_KEY,
});

app.listen(port, host, () => {
  console.log(`Novaper Runner listening on http://${host}:${port}`);
  if (proxy.enabled) {
    console.log(`Novaper Runner proxy enabled via ${proxy.source}: ${proxy.url}`);
  } else {
    console.log("Novaper Runner proxy disabled.");
  }
});
