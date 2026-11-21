export class AppState {
  constructor() {
    this.user = null;
    this.route = 'home';
    this.dashboard = { received: 0, unread: 0, sent: 0, drafts: 0, recent: [] };
    this.letters = [];
    this.pagination = { offset: 0, nextOffset: 0, total: 0, limit: 40, hasMore: false, loading: false };
    this.selectedLetter = null;
    this.notifications = [];
    this.notificationPagination = { offset: 0, nextOffset: 0, total: 0, limit: 30, hasMore: false, loading: false };
    this.settings = { theme: 'system', time_zone: 'America/Bogota', in_app_notifications_enabled: true };
    this.sessions = [];
    this.invitation = null;
    this.search = '';
    this.editor = null;
    this.mobileNavOpen = false;
    this.loading = false;
    this.routeLoading = false;
    this.routeError = null;
    this.routeNotice = null;
  }
}
