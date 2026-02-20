function ts(): string {
  return new Date().toISOString();
}

export function log(...args: unknown[]) {
  console.log(`[${ts()}]`, ...args);
}

export function logError(...args: unknown[]) {
  console.error(`[${ts()}]`, ...args);
}
