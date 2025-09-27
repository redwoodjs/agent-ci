# Agent Guidelines for Machinen

## Build/Test/Lint Commands

- `pnpm run build` - Build the project with Vite
- `pnpm run dev` - Start development server with hot reload
- `pnpm run types` - Run TypeScript type checking
- `pnpm run check` - Generate types and run type checking
- `pnpm run generate` - Generate Wrangler types
- No test scripts defined - check for testing setup before assuming test frameworks

## Code Style & Conventions

- **TypeScript**: Strict mode enabled, use explicit types, ES2022 modules
- **React**: Server components by default, mark client components with `"use client"`
- **Client Components**: Use `"use client"` at the top of files that need:
  - React hooks (useState, useEffect, etc.)
  - Event handlers (onClick, onChange, etc.)
  - Browser APIs (window, document, localStorage, etc.)
  - Interactive functionality requiring JavaScript on the client
- **Server Components**: Default for components that only render JSX and fetch data
- **Server functions**: Mark with `"use server"` directive at top of file, prefer naming the file `actions.ts`
- **Imports**: Use `@/` path alias for src directory imports, `@generated/` for generated types
- **Styling**: TailwindCSS v4 with class-variance-authority for component variants
- **Naming**: camelCase for variables/functions, PascalCase for components/types
- **ID Variables**: Use "ID" suffix for identifier variables (e.g., `streamID`, `sectionID`, `userID`)
- **File organization**: Co-locate related routes in `src/app/pages/<section>/routes.tsx`. All files must be lowercase and snake-case.
- **Comments**: Do not add comments unless explicitly requested

## RedwoodSDK Patterns

- Use `rwsdk/router` for routing with `route()`, `prefix()`, `layout()`
- Server components can be async and access database directly
- Access context via `requestInfo` in server functions: `const { ctx } = requestInfo`
- Organize interruptors in `interruptors.ts` files for middleware/auth
- Use Web APIs (fetch, WebSockets) over external dependencies when possible
- Return JSX components directly from route handlers for pages
- Use `Response.json()` for API endpoints with proper status codes

## Component Architecture

- **Page Components**: Top-level route components, can be server or client components
- **UI Components**: Reusable components in `src/app/components/ui/`, typically server components
- **Feature Components**: Domain-specific components in `src/app/pages/<section>/components/`
- **Client-Server Boundaries**: Keep client components minimal, pass data down from server components
- **Navigation**: Use `window.location.href` for client-side navigation in client components

## Error Handling

- Always wrap database/external calls in try-catch blocks
- Return appropriate HTTP status codes (404, 500, etc.)
- Log errors with `console.error()` before returning error responses
