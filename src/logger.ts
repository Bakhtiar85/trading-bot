import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

/**
 * Shared logger. Starts console-only so config errors are still logged; `configureLogger` adds the
 * rotating file transport once the log directory and level are known.
 */
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.errors({ stack: true })),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf((info) => {
          const { timestamp, level, message, stack, ...meta } = info;
          const extra = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
          const trace = typeof stack === 'string' ? `\n${stack}` : '';
          return `${String(timestamp)} ${level}: ${String(message)}${extra}${trace}`;
        }),
      ),
    }),
  ],
});

export function configureLogger(level: string, logDir: string): void {
  logger.level = level;
  logger.add(
    new DailyRotateFile({
      dirname: logDir,
      filename: 'gridbot-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '30d',
      format: winston.format.json(),
    }),
  );
}

/** Normalise an unknown thrown value into a message string. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}
