import type { User } from './types.js'

export function sendWelcome(user: User): void {
  void user
}

export function sendPasswordReset(user: User): void {
  void user
}

export function sendReceipt(user: User, amount: number): void {
  void user
  void amount
}

export function broadcast(users: User[], msg: string): void {
  void users
  void msg
}

export function digest(user: User): string {
  return user.email
}

export function mutePush(user: User): User {
  return user
}

export function unmutePush(user: User): User {
  return user
}

export function schedule(user: User, at: Date): void {
  void user
  void at
}
