export let PRESENCE: {
  [userId: string]: string;
} = {};

export function setPresence(userId: string, containerId: string) {
  PRESENCE[userId] = containerId;
}
