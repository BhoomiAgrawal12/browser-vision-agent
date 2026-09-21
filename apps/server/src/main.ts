import { makeServer } from "./server.js";

const port = Number(process.env["PORT"] ?? 8787);
makeServer().listen(port, () => {
  console.log(`kavach planner listening on http://127.0.0.1:${port}`);
  console.log(
    process.env["OLLAMA_URL"]
      ? `planner: ollama at ${process.env["OLLAMA_URL"]}`
      : "planner: deterministic heuristic (set OLLAMA_URL for a model)",
  );
});
