const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const Module = require("node:module");
const path = require("node:path");
const os = require("node:os");

process.env.TS_NODE_PROJECT = path.join(__dirname, "../tsconfig.json");

// このテストは本物の @modelcontextprotocol/sdk と本物の express を使う。
// electron に依存する周辺（ロガー・プロジェクト解決・リクエストハンドラ本体）だけを差し替え、
// HTTP 層・AggregatorServer・SDK transport は実物を通す。
const originalLoad = Module._load;
// SDK 1.29.0 の exports はワイルドカード `./*` のみで、拡張子なしの
// `.../server/streamableHttp` は素の Node 解決では見つからない（webpack は解決できる）。
// テストからは実体パスへ明示的に橋渡しする。
const SDK_DIST = path.join(
  __dirname,
  "../../../node_modules/@modelcontextprotocol/sdk/dist/cjs",
);

Module._load = function loadWithRuntimeStubs(request, parent, isMain) {
  const sdkSubpath = /^@modelcontextprotocol\/sdk\/(.+)$/.exec(request);
  if (sdkSubpath) {
    const sub = sdkSubpath[1].endsWith(".js")
      ? sdkSubpath[1]
      : `${sdkSubpath[1]}.js`;
    return originalLoad.call(this, path.join(SDK_DIST, sub), parent, isMain);
  }
  if (request === "electron") {
    return {
      app: {
        getPath: () => path.join(os.tmpdir(), "mcp-router-http-test"),
      },
    };
  }
  if (request === "@mcp_router/shared") {
    return {
      PROJECT_HEADER: "x-mcpr-project",
      UNASSIGNED_PROJECT_ID: "__unassigned__",
    };
  }
  if (request === "../../mcp-server-manager/mcp-server-manager") {
    return { MCPServerManager: class MCPServerManager {} };
  }
  if (request === "../../workspace/platform-api-manager") {
    return {
      getPlatformAPIManager: () => ({ isRemoteWorkspace: () => false }),
    };
  }
  if (request === "../token-validator") {
    return {
      TokenValidator: class TokenValidator {
        validateToken() {
          return { isValid: true, clientId: "test-client" };
        }
      },
    };
  }
  if (request === "../../projects/projects.repository") {
    return {
      ProjectRepository: {
        getInstance: () => ({ findByName: () => null }),
      },
    };
  }
  if (request === "./request-handlers") {
    return {
      RequestHandlers: class RequestHandlers {
        async handleListTools() {
          return { tools: [] };
        }
        async handleCallTool() {
          return { content: [] };
        }
      },
    };
  }
  if (request === "@/main/modules/mcp-logger/mcp-logger.service") {
    return { getLogService: () => ({ recordMcpRequestLog: () => {} }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};

require("ts-node/register/transpile-only");

const {
  MCPHttpServer,
} = require("../src/main/modules/mcp-server-runtime/http/mcp-http-server.ts");
const {
  AggregatorServer,
} = require("../src/main/modules/mcp-server-runtime/aggregator-server.ts");

const postMcp = (port, payload) =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer mcpr_test",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: text }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });

const initializeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "real-sdk-test", version: "0" },
  },
};

const listToolsRequest = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/list",
  params: {},
};

describe("MCPHttpServer with the real MCP SDK", () => {
  let server;

  after(async () => {
    if (server) {
      await server.stop();
    }
    Module._load = originalLoad;
  });

  it("serves a second request on a fresh transport instead of returning 500", async () => {
    const aggregator = new AggregatorServer({});
    server = new MCPHttpServer({}, 0, aggregator);

    await server.start();
    const port = server.server.address().port;

    const first = await postMcp(port, initializeRequest);
    const second = await postMcp(port, listToolsRequest);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);

    // 2 つ目の応答が空の 500 になっていないこと（再利用時の SDK の挙動）
    assert.ok(second.body.length > 0);
    assert.match(second.body, /"jsonrpc"\s*:\s*"2\.0"/);
  });

  // 「修正前」の対照実験: 無状態 transport を使い回すと 2 回目が空の 500 になる。
  // これが実際に起きていた障害そのもの。
  it("reproduces the old failure when one stateless transport is reused", async () => {
    const { StreamableHTTPServerTransport } = require(
      path.join(SDK_DIST, "server/streamableHttp.js"),
    );
    const { Server: McpServer } = require(
      path.join(SDK_DIST, "server/index.js"),
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const mcpServer = new McpServer(
      { name: "reuse-repro", version: "1" },
      { capabilities: { tools: {} } },
    );
    await mcpServer.connect(transport);

    const reuseServer = http.createServer((req, res) => {
      void transport.handleRequest(req, res);
    });
    await new Promise((resolve) => reuseServer.listen(0, "127.0.0.1", resolve));
    const port = reuseServer.address().port;

    try {
      const first = await postMcp(port, initializeRequest);
      const second = await postMcp(port, listToolsRequest);

      assert.equal(first.status, 200);
      assert.equal(second.status, 500);
      assert.equal(second.body, "");
    } finally {
      reuseServer.close();
    }
  });
});
