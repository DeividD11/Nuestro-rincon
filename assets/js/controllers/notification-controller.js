import { readPendingRecovery } from '../services/recovery-handoff.js';
import { AdaptivePoller } from '../services/adaptive-poller.js';

export class NotificationController {
    async refreshNotifications() {
      if (readPendingRecovery() || !this.session?.user) return;
      const result = await this.repository.notifications();
      const currentPagination = this.state.notificationPagination || {};
      const existing = Array.isArray(this.state.notifications) ? this.state.notifications : [];
      // El sondeo puede ocurrir después de que el usuario haya cargado páginas
      // antiguas. Fusiona por ID para no vaciar esas páginas con la primera.
      const merged = new Map();
      for (const item of [...(result.items || []), ...existing]) {
        if (item?.id != null && !merged.has(String(item.id))) merged.set(String(item.id), item);
      }
      this.state.notifications = [...merged.values()].sort((a, b) => {
        const dateDelta = new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
        return dateDelta || String(b.id).localeCompare(String(a.id));
      });
      this.state.notificationPagination = {
        cursor: result.nextCursor || null,
        loadedCount: this.state.notifications.length,
        limit: result.limit || currentPagination.limit || 30,
        hasMore: Boolean(result.hasMore),
        loading: false
      };
      if (this.state.route === 'notifications') this.renderCurrentRoute();
      else this.updateNotificationIndicator();
    }

    updateNotificationIndicator() {
      const button = this.root?.querySelector?.('[data-action="open-notifications"]');
      if (!button) return;
      const unreadCount = (this.state.notifications || []).filter(item => !item.read_at).length;
      let dot = button.querySelector('.notification-dot');
      if (unreadCount && !dot) {
        dot = document.createElement('span');
        dot.className = 'notification-dot';
        dot.setAttribute('aria-hidden', 'true');
        button.append(dot);
      } else if (!unreadCount && dot) {
        dot.remove();
      }
      button.setAttribute('aria-label', unreadCount ? `Notificaciones, ${unreadCount} sin leer` : 'Notificaciones');
    }

    startNotificationPolling() {
      this.stopNotificationPolling();
      if (readPendingRecovery() || !this.session?.user) return;
      this.notificationPoller = new AdaptivePoller({
        enabled: () => Boolean(this.session?.user) && !readPendingRecovery(),
        activeIntervalMs: 30_000,
        idleIntervalMs: 2 * 60_000,
        idleAfterMs: 90_000,
        minRefreshGapMs: 15_000,
        maxBackoffMs: 15 * 60_000,
        task: async () => {
          await this.refreshNotifications();
          return true;
        },
        onError: error => {
          if (error?.status === 401) this.forceLogout();
        }
      });
      this.notificationPoller.start();
    }

    stopNotificationPolling() {
      this.notificationPoller?.stop();
      this.notificationPoller = null;
    }
}
