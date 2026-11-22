export class AppInitializationController {
  async init() {
    this.applyTheme(this.readLastTheme() || 'system');
    this.view.renderBoot();
    this.bindEvents();
    await this.restoreInitialSession();
  }
}
