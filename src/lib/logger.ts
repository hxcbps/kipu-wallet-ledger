import { getConfig } from '../config/env.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogFields = Readonly<Record<string, unknown>>;

const priorities: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function log(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (priorities[level] < priorities[getConfig().logLevel]) {
    return;
  }
  const serialized = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...fields,
  });
  if (level === 'error') {
    console.error(serialized);
  } else {
    console.log(serialized);
  }
}
