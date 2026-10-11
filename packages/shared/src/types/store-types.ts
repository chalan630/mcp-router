import type { AppSettings } from "./settings-types";
import type { AuthStoreState, ServerState, Theme } from "./ui";
import type { UserInfo } from "./auth";
import type { MCPServer, MCPServerConfig } from "./mcp-types";

export interface AuthStoreInterface extends AuthStoreState {
  setAuthenticated: (authenticated: boolean) => void;
  setUserData: (
    userData: Partial<Pick<AuthStoreState, "userId" | "authToken">>,
  ) => void;
  setUserInfo: (userInfo: UserInfo | null) => void;
  setLoggingIn: (loading: boolean) => void;
  setLoginError: (error: string | null) => void;
  clearErrors: () => void;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  checkAuthStatus: (forceRefresh?: boolean) => Promise<void>;
  subscribeToAuthChanges: () => () => void;
  initializeFromSettings: (settings: AppSettings) => void;
  clearStore: () => void;
}

export interface ServerStoreState extends ServerState {
  setServers: (servers: MCPServer[]) => void;
  addServer: (server: MCPServer) => void;
  updateServer: (id: string, updates: Partial<MCPServer>) => void;
  removeServer: (id: string) => void;
  setServerStatus: (id: string, status: MCPServer["status"]) => void;
  setLoading: (loading: boolean) => void;
  setUpdating: (serverId: string, updating: boolean) => void;
  setError: (error: string | null) => void;
  setSearchQuery: (query: string) => void;
  setExpandedServerId: (id: string | null) => void;
  setSelectedServerId: (id: string | null) => void;
  startServer: (id: string) => Promise<void>;
  stopServer: (id: string) => Promise<void>;
  refreshServers: () => Promise<void>;
  createServer: (config: MCPServerConfig) => Promise<void>;
  updateServerConfig: (
    id: string,
    config: Partial<MCPServerConfig>,
  ) => Promise<void>;
  updateServerToolPermissions: (
    id: string,
    permissions: Record<string, boolean>,
  ) => Promise<void>;
  deleteServer: (id: string) => Promise<void>;
  clearStore: () => void;
}

export interface ThemeStoreState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}
