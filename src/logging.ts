import pino, { type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: {
      paths: [
        // Engine event card fields
        '*.cards',
        '*.holeCards',
        '*.hole_cards',
        '*.yourHoleCards',
        'event.cards',
        'event.holeCards',
        // Nested arrays/objects
        '*.*.cards',
        '*.*.holeCards',
        'reveals[*].cards',
        'events[*].cards',
        'events[*].holeCards',
        'history[*].cards',
        'table.yourHoleCards',
      ],
      censor: '[REDACTED]',
      remove: false,
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}
