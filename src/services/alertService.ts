/**
 * Production Alerting Service.
 * Dispatches operational incident alerts to Webhook endpoints (Telegram, Slack, Discord, etc.)
 * with automatic PHI redaction and rate limiting.
 */

import { redactPhiFromText } from '../lib/deidentifier';
import { logger } from '../lib/logger';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertPayload {
  title: string;
  message: string;
  severity: AlertSeverity;
  context?: Record<string, unknown>;
  timestamp?: string;
}

class AlertService {
  private webhookUrl: string | undefined;
  private lastAlertTime: Map<string, number> = new Map();
  private throttleMs = 5 * 60 * 1000; // 5-minute deduplication throttle per alert type

  constructor() {
    this.webhookUrl = process.env.ALERT_WEBHOOK_URL;
  }

  async sendAlert(alert: AlertPayload): Promise<boolean> {
    const alertKey = `${alert.severity}:${alert.title}`;
    const now = Date.now();
    const last = this.lastAlertTime.get(alertKey) || 0;

    if (now - last < this.throttleMs) {
      logger.debug(`Throttling alert "${alert.title}" (sent within last 5 minutes)`);
      return false;
    }
    this.lastAlertTime.set(alertKey, now);

    // Sanitize title and message to guarantee zero PHI leaks
    const cleanTitle = redactPhiFromText(alert.title);
    const cleanMessage = redactPhiFromText(alert.message);
    const timestamp = alert.timestamp || new Date().toISOString();

    const icons = {
      info: 'ℹ️',
      warning: '⚠️',
      critical: '🚨',
    };

    logger.warn(`[ALERT] [${alert.severity.toUpperCase()}] ${cleanTitle}: ${cleanMessage}`);

    if (!this.webhookUrl) {
      return true; // Local log only if webhook is not configured
    }

    try {
      const payload = {
        text: `${icons[alert.severity]} *[${alert.severity.toUpperCase()}] ${cleanTitle}*\n${cleanMessage}\n_Timestamp: ${timestamp}_`,
        severity: alert.severity,
        title: cleanTitle,
        message: cleanMessage,
        context: alert.context,
        timestamp,
      };

      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        logger.error(`Failed to dispatch alert webhook: HTTP ${res.status}`);
        return false;
      }
      return true;
    } catch (err) {
      logger.error('Error dispatching alert webhook', err);
      return false;
    }
  }

  async alertHeartbeatStale(minutes: number, lastSeen: string) {
    await this.sendAlert({
      title: 'Mail Worker Heartbeat Stale',
      message: `The cloud mail worker heartbeat is stale by ${minutes} minutes. Last recorded sync was ${lastSeen}.`,
      severity: 'critical',
      context: { minutesStale: minutes, lastSeen },
    });
  }

  async alertDeadLetterSpike(count: number, recentErrors: string[]) {
    await this.sendAlert({
      title: 'Dead-Letter Queue Spike Detected',
      message: `Quarantined messages in public.dead_letter_queue reached ${count}. Recent errors: ${recentErrors.slice(0, 3).join('; ')}`,
      severity: 'critical',
      context: { count, recentErrors },
    });
  }

  async alertOutboxLag(pendingCount: number, oldestAgeMinutes: number) {
    await this.sendAlert({
      title: 'Outbox Event Processing Lag',
      message: `Outbox queue has ${pendingCount} pending events. Oldest event is ${oldestAgeMinutes} minutes old.`,
      severity: oldestAgeMinutes > 30 ? 'critical' : 'warning',
      context: { pendingCount, oldestAgeMinutes },
    });
  }

  async alertSyncFailure(errorMessage: string) {
    await this.sendAlert({
      title: 'EWS Sync Execution Failure',
      message: `Automated 20-minute EWS sync encountered an unhandled exception: ${errorMessage}`,
      severity: 'warning',
      context: { error: errorMessage },
    });
  }
}

export const alertService = new AlertService();
