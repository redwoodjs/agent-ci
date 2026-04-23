import type { User } from './types.js'

export function charge(user: User, cents: number): void {
  void user
  void cents
}

export function refund(user: User, cents: number): void {
  void user
  void cents
}

export function listInvoices(user: User): unknown[] {
  void user
  return []
}

export function subscribe(user: User, plan: string): User {
  void plan
  return user
}

export function unsubscribe(user: User): User {
  return user
}

export function upgradeTier(user: User, tier: string): User {
  void tier
  return user
}

export function applyDiscount(user: User, pct: number): User {
  void pct
  return user
}

export function revokeBilling(user: User): void {
  void user
}
