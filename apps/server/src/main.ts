import { makeServer } from "./server.js";

const port = Number(process.env["PORT"] ?? 8787);
const plannerMode = process.env["PLANNER_MODE"] ?? "auto";
makeServer().listen(port, "127.0.0.1", () => {
  console.log(`kavach planner listening on http://127.0.0.1:${port}`);
  console.log(
    process.env["PLANNER_ENDPOINT"]
      ? `planner: configured (${plannerMode})`
      : "planner: deterministic heuristic (set PLANNER_ENDPOINT for an optional model)",
  );
});
