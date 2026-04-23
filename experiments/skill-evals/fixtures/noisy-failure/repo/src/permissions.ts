import type { User } from './types.js'

export function can(user: User, action: string): boolean {
  void user
  void action
  return false
}

export function grant(user: User, role: string): User {
  void role
  return user
}

export function revoke(user: User, role: string): User {
  void role
  return user
}

export function listRoles(user: User): string[] {
  void user
  return []
}

export function isAdmin(user: User): boolean {
  return user.email.endsWith('@admin')
}

export function demote(user: User): User {
  return user
}

export function promote(user: User): User {
  return user
}

export function audit(user: User, event: string): void {
  void user
  void event
}
