# TypeScript Type Definition Guidelines

## Overview

This document describes how to centralize exported types that form cross-module contracts while keeping implementation-only types close to the code that uses them. This avoids duplicate shared contracts without scattering public types.

## Type Definition Locations

### Shared and exported types

Exported types that define cross-module contracts should be defined in the following locations:

1. **`packages/shared/src/types/`** - Primary location for shared domain and API types
2. **`packages/remote-api-types/src/`** - Remote API schemas and generated types
3. **`packages/ui/src/`** - Types that belong to the shared UI package
4. **Type definition files (`*.d.ts`)** - Global type declarations
5. **`tools/eslint-rules/`** - Types used by the lint-rule implementation

Module-private implementation types may remain next to their use, but should not be exported from feature modules. Component Props and imperative Handle interfaces may remain in `.tsx` files, and test-specific types may remain in test code.

## Organization Structure

```
packages/shared/src/types/
├── domains/          # Domain entities
│   ├── mcp.ts       # MCP server, tool, resource types
│   ├── auth.service.ts      # Authentication types
│   └── workspace.ts # Workspace types
├── api/             # API-related types
│   ├── requests.ts  # API request types
│   ├── responses.ts # API response types
│   └── errors.ts    # API error types
├── ui/              # UI component patterns
│   ├── props.ts     # Common prop interfaces
│   └── state.ts     # Common state patterns
├── store/           # Store state types
│   └── ipc.ts     # Store state interfaces
└── ipc.ts         # Main export file
```

## Type Definition Rules

### 1. Component Props

Component Props and imperative Handle interfaces are allowed in `.tsx` files and should follow this pattern:

```typescript
// ✅ Allowed
interface MyComponentProps {
  title: string;
  onClose: () => void;
}

// ❌ Not allowed - use shared UI types for common patterns
interface MyComponentProps extends DialogProps {
  customField: string;
}
```

### 2. Import Shared Contract Types

Import existing domain and API contracts from `@mcp_router/shared` instead of redeclaring them. Types used only inside one implementation module may remain local and non-exported.

```typescript
// ✅ Shared contract
import type { MCPServer } from "@mcp_router/shared";

// ✅ Module-private implementation detail
type SearchContext = { projectId: string | null };
```

### 3. Extend Shared Types for Shared Contracts

When defining a type that is exported across modules, extend or compose the existing shared type rather than duplicating it. Keep one-file implementation details local and non-exported.

```typescript
import type { MCPServer } from "@mcp_router/shared";

// Module-private implementation detail: keep it local and unexported.
type ExtendedMCPServer = MCPServer & { customField: string };
```

### 4. Database Types

Keep database types with the schema but map to domain types:

```typescript
// In database schema
export interface DBUser {
  id: number;
  email: string;
  created_at: Date;
}

// In mapper
import { User } from '@mcp_router/shared/types';

export function mapDBUserToUser(dbUser: DBUser): User {
  // mapping logic
}
```

## ESLint Enforcement

The project uses `custom/no-scattered-types` to enforce these guidelines. The rule will:

- Error on exported type definitions outside allowed shared locations
- Allow module-private, non-exported implementation types
- Allow component Props and imperative Handle interfaces in `.tsx` files
- Allow types in test files and `.d.ts` files

## Migration Guide

When migrating existing types:

1. Decide whether the type is a shared contract or a module-private implementation detail.
2. Put exported cross-module contracts in the appropriate shared type package; keep private types local and unexported.
3. Update imports of shared contracts to use their owning package.
4. Remove duplicate definitions while preserving module-specific behavior.
5. Run `pnpm lint:fix` and `pnpm typecheck` to verify the change.

Note: The ESLint rule will automatically catch any types defined outside of allowed locations, ensuring compliance.

## Examples

### Before (Scattered)
```typescript
// apps/electron/src/services/mcp-service.ts
interface MCPServerConfig {
  id: string;
  name: string;
}

// apps/web/src/components/ServerList.tsx
interface MCPServerConfig {
  id: string;
  name: string;
  status?: string;
}
```

### After (Centralized)
```typescript
// packages/shared/src/types/domains/mcp.ts
export interface MCPServerConfig {
  id: string;
  name: string;
  status?: string;
}

// apps/electron/src/services/mcp-service.ts
import { MCPServerConfig } from '@mcp_router/shared/types';

// apps/web/src/components/ServerList.tsx
import { MCPServerConfig } from '@mcp_router/shared/types';
```

## Benefits

1. **Single Source of Truth**: No more duplicate type definitions
2. **Better IntelliSense**: IDEs can better understand and suggest types
3. **Easier Refactoring**: Change types in one place
4. **Type Safety**: Consistent types across frontend and backend
5. **Reduced Bundle Size**: No duplicate type definitions in build output
