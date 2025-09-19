# Agent Guidelines for Machinen

## Build/Test/Lint Commands

- `npm run build` - Build the project with Vite
- `npm run dev` - Start development server with hot reload
- `npm run types` - Run TypeScript type checking
- `npm run check` - Generate types and run type checking
- No test scripts defined - check for testing setup before assuming test frameworks

## Code Style & Conventions

- **TypeScript**: Strict mode enabled, use explicit types
- **React**: Server components by default, mark client components with `"use client"`
- **Server functions**: Mark with `"use server"` directive at top of file
- **Imports**: Use `@/` path alias for src directory imports
- **Styling**: TailwindCSS with class-variance-authority for component variants
- **Naming**: camelCase for variables/functions, PascalCase for components/types
- **File organization**: Co-locate related routes in `src/app/pages/<section>/routes.ts`

## RedwoodSDK Patterns

- Use `rwsdk/router` for routing with `route()`, `prefix()`, `layout()`
- Server components can be async and access database directly
- Access context via `requestInfo` in server functions: `const { ctx } = requestInfo`
- Organize interruptors in `interruptors.ts` files for middleware/auth
- Use Web APIs (fetch, WebSockets) over external dependencies when possible
- Return JSX components directly from route handlers for pages
- Use `Response.json()` for API endpoints with proper status codes

## Error Handling

- Always wrap database/external calls in try-catch blocks
- Return appropriate HTTP status codes (404, 500, etc.)
- Log errors with `console.error()` before returning error responses
