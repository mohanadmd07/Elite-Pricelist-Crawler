/**
 * Production Structured Logger with Automatic PHI Redaction.
 * Enforces zero-demographics logging across cloud workers, CLI tools, and API handlers.
 */

import { redactPhiFromText } from './deidentifier';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogPayload {
  level: LogLevel;
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

class StructuredLogger {
  private isProduction: boolean;
  private isJson: boolean;

  constructor() {
    this.isProduction = process.env.NODE_ENV === 'production';
    this.isJson = process.env.LOG_FORMAT === 'json' || this.isProduction;
  }

  private sanitize(input: unknown): unknown {
    if (typeof input === 'string') {
      return redactPhiFromText(input);
    }
    if (input instanceof Error) {
      return {
        name: input.name,
        message: redactPhiFromText(input.message),
        stack: this.isProduction ? undefined : redactPhiFromText(input.stack || ''),
      };
    }
    if (Array.isArray(input)) {
      return input.map((item) => this.sanitize(item));
    }
    if (typeof input === 'object' && input !== null) {
      const sanitizedObj: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input)) {
        // Redact known sensitive field names immediately
        if (/^(patientName|mrn|nationalId|phone|rawBody|bodyHtml|bodyText)$/i.test(key)) {
          sanitizedObj[key] = '[REDACTED_PHI]';
        } else {
          sanitizedObj[key] = this.sanitize(value);
        }
      }
      return sanitizedObj;
    }
    return input;
  }

  private emit(level: LogLevel, rawMessage: string, rawContext?: Record<string, unknown>, err?: Error) {
    const sanitizedMsg = redactPhiFromText(rawMessage);
    const sanitizedCtx = rawContext ? (this.sanitize(rawContext) as Record<string, unknown>) : undefined;
    const sanitizedErr = err ? (this.sanitize(err) as LogPayload['error']) : undefined;

    const payload: LogPayload = {
      level,
      message: sanitizedMsg,
      timestamp: new Date().toISOString(),
      context: sanitizedCtx,
      error: sanitizedErr,
    };

    if (this.isJson) {
      const jsonStr = JSON.stringify(payload);
      if (level === 'error') {
        process.stderr.write(jsonStr + '\n');
      } else {
        process.stdout.write(jsonStr + '\n');
      }
    } else {
      const time = payload.timestamp.slice(11, 19);
      const prefix = `[${time}] [${level.toUpperCase()}]`;
      const contextStr = sanitizedCtx ? ` ${JSON.stringify(sanitizedCtx)}` : '';
      const errStr = sanitizedErr ? `\n  Error: ${sanitizedErr.name}: ${sanitizedErr.message}` : '';

      switch (level) {
        case 'debug':
          console.debug(`\x1b[90m${prefix} ${sanitizedMsg}${contextStr}\x1b[0m`);
          break;
        case 'info':
          console.info(`\x1b[36m${prefix}\x1b[0m ${sanitizedMsg}${contextStr}`);
          break;
        case 'warn':
          console.warn(`\x1b[33m${prefix} ${sanitizedMsg}${contextStr}\x1b[0m`);
          break;
        case 'error':
          console.error(`\x1b[31m${prefix} ${sanitizedMsg}${contextStr}${errStr}\x1b[0m`);
          break;
      }
    }
  }

  debug(msg: string, context?: Record<string, unknown>) {
    this.emit('debug', msg, context);
  }

  info(msg: string, context?: Record<string, unknown>) {
    this.emit('info', msg, context);
  }

  warn(msg: string, context?: Record<string, unknown>) {
    this.emit('warn', msg, context);
  }

  error(msg: string, err?: Error | unknown, context?: Record<string, unknown>) {
    const errorObj = err instanceof Error ? err : undefined;
    const extraCtx = !(err instanceof Error) && typeof err === 'object' && err !== null ? { ...context, ...(err as Record<string, unknown>) } : context;
    this.emit('error', msg, extraCtx, errorObj);
  }
}

export const logger = new StructuredLogger();
