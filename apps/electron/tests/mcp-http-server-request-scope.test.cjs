const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const Module = require("node:module");
const path = require("node:path");
const os = require("node:os");

process.env.TS_NODE_PROJECT = path.join(__dirname, "../tsconfig.json");

// リクエストごとに新しい transport が使われることを検証するため、
// SDK の Streamable HTTP transport を「使い回すと 500 を返す」代替実装に差し替える。
// 実際の SDK も無状態 transport の再利用を拒否する。
const createdTransports = [];

class FakeStreamableHTTPServerTransport {
  constructor(options) {
    this.options = options;
    this.handledCount = 0;
    createdTransports.push(this);
  }

  async handleRequest(_req, res) {
    this.handledCount += 1;

    if (this.handledCount > 1) {
      res.writeHead(500);
      res.end();
      return;
    }

    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end();
  }

  async close() {
    this.closed = true;
  }
}

class FakeServer {
  constructor() {
    this.handlers = new Map();
  }

  setRequestHandler(schema, handler) {
    this.handlers.set(schema, handler);
  }

  async connect() {}

  async close() {
    this.closed = true;
  }
}

const placeholderSchema = (name) => ({ name });

const originalLoad = Module._load;
Module._load = function loadWithRuntimeStubs(request, parent, isMain) {
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
  if (request === "@modelcontextprotocol/sdk/server/sse") {
    return { SSEServerTransport: class SSEServerTransport {} };
  }
  if (request === "@modelcontextprotocol/sdk/server/index.js") {
    return { Server: FakeServer };
  }
  if (request === "@modelcontextprotocol/sdk/server/streamableHttp") {
    return { StreamableHTTPServerTransport: FakeStreamableHTTPServerTransport };
  }
  if (request === "@modelcontextprotocol/sdk/types.js") {
    return {
      ListToolsRequestSchema: placeholderSchema("tools/list"),
      CallToolRequestSchema: placeholderSchema("tools/call"),
      ListResourcesRequestSchema: placeholderSchema("resources/list"),
      ListResourceTemplatesRequestSchema: placeholderSchema(
        "resources/templates/list",
      ),
      ReadResourceRequestSchema: placeholderSchema("resources/read"),
      ListPromptsRequestSchema: placeholderSchema("prompts/list"),
      GetPromptRequestSchema: placeholderSchema("prompts/get"),
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
    return { RequestHandlers: class RequestHandlers {} };
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

const sendMcpRequest = (port, id) =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0" },
      },
    });

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
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );

    req.on("error", reject);
    req.end(body);
  });

describe("MCPHttpServer request scope", () => {
  let server;

  after(async () => {
    if (server) {
      await server.stop();
    }
    Module._load = originalLoad;
  });

  it("never reuses a stateless transport across requests", async () => {
    const aggregator = new AggregatorServer({});
    server = new MCPHttpServer({}, 0, aggregator);

    await server.start();
    const port = server.server.address().port;

    const firstStatus = await sendMcpRequest(port, 1);
    const secondStatus = await sendMcpRequest(port, 2);

    assert.equal(firstStatus, 200);
    assert.equal(secondStatus, 200);

    // 2 リクエストに対して 2 つの transport が作られ、それぞれ 1 回だけ使われる
    assert.equal(createdTransports.length, 2);
    assert.deepEqual(
      createdTransports.map((transport) => transport.handledCount),
      [1, 1],
    );
    assert.equal(createdTransports[0].options.sessionIdGenerator, undefined);
    assert.equal(createdTransports[1].options.sessionIdGenerator, undefined);
  });
});
