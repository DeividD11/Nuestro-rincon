export class AppState {
  constructor() {
    this.user = null;
    this.route = 'home';
    this.dashboard = { received: 0, unread: 0, sent: 0, drafts: 0, recent: [] };
    this.letters = [];
    this.selectedLetter = null;
    this.notifications = [];
    this.settings = { theme: 'system', time_zone: 'America/Bogota', in_app_notifications_enabled: true };
    this.sessions = [];
    this.search = '';
    this.editor = null;
    this.mobileNavOpen = false;
    this.loading = false;
    this.routeLoading = false;
    this.routeError = null;
    this.routeNotice = null;
  }
}
