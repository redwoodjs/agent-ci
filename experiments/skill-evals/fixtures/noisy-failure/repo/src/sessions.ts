import type { User } from './types.js'

export function createSession(user: User): string {
  return `session-${user.id}`
}

export function resumeSession(token: string): User | null {
  void token
  return null
}

export function listSessions(user: User): string[] {
  return [user.id]
}

export function revokeSession(user: User, token: string): void {
  void user
  void token
}

export function rotateSession(user: User): User {
  return user
}

export function extendSession(user: User, seconds: number): User {
  void seconds
  return user
}

export function validateSession(user: User, token: string): boolean {
  return user.id === token
}

export function expireSession(user: User): User {
  return user
}
