import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { EventEmitter } from "events";
import { MCPServer, MCPServerConfig, MCPTool } from "@mcp_router/shared";
import {
  getServerService,
  ServerService,
} from "@/main/modules/mcp-server-manager/server-service";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  connectToMCPServer,
  substituteArgsParameters,
} from "../mcp-apps-manager/mcp-apps-manager.service";
import { getLogService } from "@/main/modules/mcp-logger/mcp-logger.service";

// 一定時間使われていない接続だけを ping で生存確認する（呼び出しの連続で毎回往復しない）
const IDLE_CONNECTION_CHECK_MS = 45_000;
const PING_TIMEOUT_MS = 3_000;
// アプリ内部からの再接続であることをログ上で区別するためのクライアント ID
const SYSTEM_CLIENT_ID = "mcp-router-system";

/**
 * Core server lifecycle management
 */
export class MCPServerManager {
  private servers: Map<string, MCPServer> = new Map();
  private clients: Map<string, Client> = new Map();
  private serverNameToIdMap: Map<string, string> = new Map();
  private serverStatusMap: Map<string, boolean> = new Map();
  private clientLastUsedAt: Map<string, number> = new Map();
  private serversDir: string;
  private serverService!: ServerService;
  private eventEmitter = new EventEmitter();

  constructor() {
    this.serversDir = path.join(app.getPath("userData"), "mcp-servers");
    if (!fs.existsSync(this.serversDir)) {
      fs.mkdirSync(this.serversDir, { recursive: true });
    }
    // Set server name to ID map for log service
    getLogService().setServerNameToIdMap(this.serverNameToIdMap);
  }

  /**
   * Initialize async operations
   */
  public async initializeAsync(): Promise<void> {
    try {
      console.log("[MCPServerManager] Initializing...");

      // Initialize server service
      this.serverService = getServerService();

      // Load servers from database
      await this.loadServersFromDatabase();

      console.log("[MCPServerManager] Initialization complete");
    } catch (error) {
      console.error("Failed to initialize Server Manager:", error);
    }
  }

  /**
   * Load servers from database
   */
  private async loadServersFromDatabase(): Promise<void> {
    try {
      console.log("[MCPServerManager] Loading servers from database...");
      const servers = this.serverService.getAllServers();
      console.log(
        `[MCPServerManager] Found ${servers.length} servers in database`,
      );

      const autoStartServerIds: string[] = [];

      for (const server of servers) {
        // Initialize all servers as stopped when loading
        server.status = "stopped";
        server.logs = [];
        server.toolPermissions = server.toolPermissions || {};
        this.servers.set(server.id, server);

        // Update server name to ID mapping
        this.updateServerNameMapping(server);

        // Auto start servers if configured
        if (server.autoStart && !server.disabled) {
          autoStartServerIds.push(server.id);
        }
      }

      if (autoStartServerIds.length > 0) {
        await Promise.all(
          autoStartServerIds.map(async (id) => {
            try {
              await this.startServer(id, undefined, false);
            } catch (error) {
              const server = this.servers.get(id);
              const identifier = server?.name || id;
              console.error(
                `[MCPServerManager] Failed to auto-start server ${identifier}:`,
                error,
              );
            }
          }),
        );
      }

      console.log(`[MCPServerManager] ${servers.length} servers loaded`);
    } catch (error) {
      console.error("Error loading servers:", error);
    }
  }

  /**
   * Update server name to ID mapping
   */
  private updateServerNameMapping(server: MCPServer): void {
    this.serverNameToIdMap.set(server.name, server.id);
  }

  /**
   * Get server ID by name
   */
  public getServerIdByName(name: string): string | undefined {
    return this.serverNameToIdMap.get(name);
  }

  public on(
    event:
      | "server-added"
      | "server-updated"
      | "server-removed"
      | "server-started"
      | "server-stopped",
    handler: (serverId: string) => void,
  ): void {
    this.eventEmitter.on(event, handler);
  }

  public off(
    event:
      | "server-added"
      | "server-updated"
      | "server-removed"
      | "server-started"
      | "server-stopped",
    handler: (serverId: string) => void,
  ): void {
    this.eventEmitter.off(event, handler);
  }

  /**
   * Clear all servers from memory (used when switching workspaces)
   */
  public clearAllServers(): void {
    // Stop all running servers
    for (const [id] of this.clients) {
      try {
        this.stopServer(id);
      } catch (error) {
        console.error(`Failed to stop server ${id}:`, error);
      }
    }

    // Clear all maps
    this.servers.clear();
    this.clients.clear();
    this.serverNameToIdMap.clear();
    this.serverStatusMap.clear();
    this.clientLastUsedAt.clear();
  }

  /**
   * Get a list of all MCP servers
   */
  public getServers(): MCPServer[] {
    // Get latest server info from database
    const dbServers = this.serverService.getAllServers();

    // Add servers from database that aren't in memory
    dbServers.forEach((server: any) => {
      if (!this.servers.has(server.id)) {
        this.servers.set(server.id, {
          ...server,
          status: "stopped",
          logs: [],
        });
        this.updateServerNameMapping(server);
      }
    });

    // Return servers with their current runtime status preserved
    return Array.from(this.servers.values()).map((server) => {
      const currentServer = this.servers.get(server.id);
      return currentServer || server;
    });
  }

  /**
   * Add a new MCP server
   */
  public addServer(config: MCPServerConfig): MCPServer {
    const newServer = this.serverService.addServer(config);
    this.servers.set(newServer.id, newServer);
    this.updateServerNameMapping(newServer);
    this.eventEmitter.emit("server-added", newServer.id);
    return newServer;
  }

  /**
   * Remove an MCP server
   */
  public removeServer(id: string): boolean {
    const server = this.servers.get(id);

    // Stop the server if it's running
    if (this.clients.has(id)) {
      this.stopServer(id);
    }

    // Remove server from all tokens
    this.removeServerFromTokens(id);

    // Remove from database
    const removed = this.serverService.deleteServer(id);

    // Remove from memory if successful
    if (removed && server) {
      this.serverNameToIdMap.delete(server.name);
      this.servers.delete(id);
      this.eventEmitter.emit("server-removed", id);
    }

    return removed;
  }

  /**
   * Remove server ID from all tokens
   */
  private removeServerFromTokens(serverId: string): void {
    try {
      const {
        TokenManager,
      } = require("@/main/modules/mcp-apps-manager/token-manager");
      const tokenManager = new TokenManager();
      const allTokens = tokenManager.listTokens();

      for (const token of allTokens) {
        if (serverId in (token.serverAccess || {})) {
          const updatedServerAccess = { ...(token.serverAccess || {}) };
          delete updatedServerAccess[serverId];
          tokenManager.updateTokenServerAccess(token.id, updatedServerAccess);
        }
      }
    } catch (error) {
      console.error(
        `Failed to update tokens for server removal ${serverId}:`,
        error,
      );
    }
  }

  /**
   * Start an MCP server
   */
  public async startServer(
    id: string,
    clientId?: string,
    persist: boolean = true,
  ): Promise<boolean> {
    const server = this.servers.get(id);
    if (!server || server.disabled) {
      throw new Error(server ? "Server is disabled" : "Server not found");
    }

    // If already running, do nothing
    if (this.clients.has(id)) {
      return true;
    }

    server.status = "starting";
    const result = await this.connectToServerWithResult(id);

    if (result.status === "error") {
      server.status = "error";
      server.errorMessage = result.error;
      throw new Error(result.error);
    }

    this.clients.set(id, result.client);
    server.status = "running";
    server.errorMessage = undefined;

    // Register the client
    this.serverStatusMap.set(server.name, true);

    // Update autoStart if persist is true
    if (persist) {
      this.updateServer(id, { autoStart: true });
    }

    // Record log
    getLogService().recordMcpRequestLog({
      timestamp: new Date().toISOString(),
      requestType: "StartServer",
      params: { serverName: server.name },
      result: "success",
      duration: 0,
      clientId: clientId || "unknownClient",
    });

    this.eventEmitter.emit("server-started", id);

    return true;
  }

  /**
   * Stop an MCP server
   */
  public stopServer(
    id: string,
    clientId?: string,
    persist: boolean = true,
  ): boolean {
    const server = this.servers.get(id);
    if (!server) {
      return false;
    }

    const client = this.clients.get(id);
    if (!client) {
      server.status = "stopped";
      this.clientLastUsedAt.delete(id);
      return true;
    }

    try {
      server.status = "stopping";

      // Unregister the client
      this.serverStatusMap.set(server.name, false);

      // Update autoStart if persist is true
      if (persist) {
        this.updateServer(id, { autoStart: false });
      }

      // Record log
      getLogService().recordMcpRequestLog({
        timestamp: new Date().toISOString(),
        requestType: "StopServer",
        params: { serverName: server.name },
        result: "success",
        duration: 0,
        clientId: clientId || "unknownClient",
      });

      // Disconnect the client
      client.close();
      this.clients.delete(id);
      this.clientLastUsedAt.delete(id);
      server.status = "stopped";
      this.eventEmitter.emit("server-stopped", id);
      return true;
    } catch (error) {
      server.status = "error";
      return false;
    }
  }

  /**
   * Update an MCP server's configuration
   */
  public updateServer(
    id: string,
    config: Partial<MCPServerConfig>,
  ): MCPServer | undefined {
    const oldServer = this.servers.get(id);
    if (oldServer && config.name && oldServer.name !== config.name) {
      this.serverNameToIdMap.delete(oldServer.name);
    }

    const updatedServer = this.serverService.updateServer(id, config);
    if (!updatedServer) {
      return undefined;
    }

    const server = this.servers.get(id);
    if (server) {
      const status = server.status;
      const logs = server.logs || [];
      Object.assign(server, updatedServer, { status, logs });
      server.toolPermissions = server.toolPermissions || {};
      this.updateServerNameMapping(server);
    }

    this.eventEmitter.emit("server-updated", id);

    return updatedServer;
  }

  /**
   * Update tool permissions for a server
   */
  public updateServerToolPermissions(
    id: string,
    toolPermissions: Record<string, boolean>,
  ): MCPServer {
    const server = this.servers.get(id);
    if (!server) {
      throw new Error(`Server not found: ${id}`);
    }

    const updatedConfig: Partial<MCPServerConfig> = { toolPermissions };
    const updatedServer = this.serverService.updateServer(id, updatedConfig);

    if (!updatedServer) {
      throw new Error(
        `Failed to update tool permissions for server: ${server.name}`,
      );
    }

    server.toolPermissions = { ...toolPermissions };

    if (Array.isArray(server.tools)) {
      server.tools = server.tools.map((tool) => ({
        ...tool,
        enabled: toolPermissions[tool.name] !== false,
      }));
    }

    this.eventEmitter.emit("server-updated", id);

    return server;
  }

  /**
   * List tools for a specific server
   */
  public async listServerTools(id: string): Promise<MCPTool[]> {
    const server = this.servers.get(id);
    if (!server) {
      throw new Error("Server not found");
    }

    const client = this.clients.get(id);
    const isRunning =
      !!client &&
      (server.status === "running" || this.serverStatusMap.get(server.name));

    if (!isRunning || !client) {
      throw new Error("Server must be running to list tools");
    }

    const response = await client.listTools();
    const tools = response?.tools ?? [];
    const permissions = server.toolPermissions || {};
    const toolsWithStatus = tools.map((tool) => ({
      ...tool,
      enabled: permissions[tool.name] !== false,
    }));

    server.tools = toolsWithStatus;
    return toolsWithStatus;
  }

  /**
   * Get the status of a specific MCP server
   */
  public getServerStatus(
    id: string,
  ): "running" | "starting" | "stopping" | "stopped" | "error" {
    const server = this.servers.get(id);
    return server?.status || "error";
  }

  /**
   * Connect to an MCP server
   */
  private async connectToServerWithResult(
    id: string,
  ): Promise<
    { status: "success"; client: Client } | { status: "error"; error: string }
  > {
    const server = this.servers.get(id);
    if (!server) {
      return { status: "error", error: "Server not found" };
    }

    try {
      const result = await connectToMCPServer(
        {
          id: server.id,
          name: server.name,
          serverType: server.serverType,
          command: server.command,
          args: server.args
            ? substituteArgsParameters(
                server.args,
                server.env || {},
                server.inputParams || {},
              )
            : undefined,
          remoteUrl: server.remoteUrl,
          bearerToken: server.bearerToken,
          env: server.env,
          inputParams: server.inputParams,
        },
        "mcp-router",
      );

      return result;
    } catch (error) {
      return {
        status: "error",
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }

  /**
   * Verify that a cached client is still usable, reconnecting it when it is not.
   *
   * The connection is only probed after a period of inactivity: a suspended
   * machine tears down pipes and sockets while the app keeps the stale clients
   * cached, and probing on every call would add a round trip to each request.
   */
  public async ensureClientAlive(id: string): Promise<Client | undefined> {
    const client = this.clients.get(id);
    if (!client) {
      return undefined;
    }

    const now = Date.now();
    const lastUsedAt = this.clientLastUsedAt.get(id);
    if (
      lastUsedAt !== undefined &&
      now - lastUsedAt < IDLE_CONNECTION_CHECK_MS
    ) {
      this.clientLastUsedAt.set(id, now);
      return client;
    }

    try {
      await this.pingWithTimeout(client, PING_TIMEOUT_MS);
      this.clientLastUsedAt.set(id, now);
      return client;
    } catch (error) {
      if (
        error instanceof McpError &&
        error.code === ErrorCode.MethodNotFound
      ) {
        // サーバーは応答しているが ping 未対応。生存扱いにする
        this.clientLastUsedAt.set(id, now);
        return client;
      }

      console.warn(
        `[MCPServerManager] Server ${id} did not respond to ping, reconnecting`,
      );
      return await this.reconnectServer(id, "ping timeout");
    }
  }

  private pingWithTimeout(client: Client, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Ping timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );

      client.ping().then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /**
   * Reconnect every server that is currently running.
   *
   * Called after the machine resumes from sleep: the cached clients may point
   * at closed pipes or dead sockets, so they are dropped and re-established.
   * Persisted settings are left untouched.
   */
  public async reconnectRunningServers(reason: string): Promise<void> {
    const runningIds: string[] = [];
    for (const [id, server] of this.servers) {
      if (this.clients.has(id) || this.serverStatusMap.get(server.name)) {
        runningIds.push(id);
      }
    }

    if (runningIds.length === 0) {
      return;
    }

    console.log(
      `[MCPServerManager] Reconnecting ${runningIds.length} running server(s) after ${reason}`,
    );

    for (const id of runningIds) {
      await this.reconnectServer(id, reason);
    }
  }

  /**
   * Reconnect a single server without modifying persisted settings.
   */
  private async reconnectServer(
    id: string,
    reason: string,
  ): Promise<Client | undefined> {
    try {
      // persist = false: 再接続はユーザー設定（autoStart）を変更しない
      this.stopServer(id, SYSTEM_CLIENT_ID, false);
      await this.startServer(id, SYSTEM_CLIENT_ID, false);
      return this.clients.get(id);
    } catch (error) {
      console.error(
        `[MCPServerManager] Failed to reconnect server ${id} after ${reason}:`,
        error,
      );
      return undefined;
    }
  }

  /**
   * Get all maps for sharing with other components
   */
  public getMaps() {
    return {
      servers: this.servers,
      clients: this.clients,
      serverNameToIdMap: this.serverNameToIdMap,
      serverStatusMap: this.serverStatusMap,
    };
  }

  /**
   * Shutdown all servers
   */
  public async shutdown(): Promise<void> {
    for (const [id] of this.clients) {
      // Don't persist state changes when shutting down - this is just cleanup
      this.stopServer(id, undefined, false);
    }
  }
}
