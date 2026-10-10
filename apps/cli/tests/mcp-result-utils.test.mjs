import assert from "node:assert/strict";
import test from "node:test";

const { normalizeProxiedToolResult } =
  await import("../src/mcp-result-utils.ts");

test("normalizes Memory read_graph structured entity types", () => {
  const result = {
    content: [{ type: "text", text: "unchanged" }],
    structuredContent: {
      entities: [{ name: "alice", type: "person", observations: ["uses MCP"] }],
      relations: [],
    },
  };

  const normalized = normalizeProxiedToolResult("read_graph", result, {
    serverId: "memory",
  });

  assert.deepEqual(normalized.structuredContent.entities, [
    { name: "alice", observations: ["uses MCP"] },
  ]);
  assert.equal(normalized.content, result.content);
  assert.equal(result.structuredContent.entities[0].type, "person");
});

test("leaves unrelated tool results unchanged", () => {
  const result = {
    structuredContent: { entities: [{ name: "alice", type: "person" }] },
  };

  assert.equal(
    normalizeProxiedToolResult("tools/list", result, { serverId: "memory" }),
    result,
  );
  assert.equal(
    normalizeProxiedToolResult("read_graph", result, { serverId: "other" }),
    result,
  );
});
