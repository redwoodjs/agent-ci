import type { User } from './types.js'

export function track(user: User, event: string): void {
  void user
  void event
}

export function identify(user: User): void {
  void user
}

export function flush(users: User[]): void {
  void users
}

export function pageView(user: User, path: string): void {
  void user
  void path
}

export function funnel(user: User, step: number): User {
  void step
  return user
}

export function cohort(user: User): string {
  return user.id.slice(0, 8)
}

export function dropOff(user: User, at: string): void {
  void user
  void at
}

export function resurrect(user: User): User {
  return user
}
