import type { User } from './types.js'

export function createAccount(email: string): User {
  return { id: crypto.randomUUID(), email, createdAt: new Date() }
}

export function getAccount(id: string): User | null {
  return null
}

export function listAccounts(): User[] {
  return []
}

export function updateAccount(user: User, email: string): User {
  return { ...user, email }
}

export function deleteAccount(user: User): void {
  void user
}

export function archiveAccount(user: User): User {
  return user
}

export function mergeAccounts(a: User, b: User): User {
  return { ...a, email: b.email }
}

export function compareAccounts(a: User, b: User): boolean {
  return a.id === b.id
}
