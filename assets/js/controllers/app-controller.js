import { AppState } from '../models/app-state.js';
import { AppView } from '../views/app-view.js';

import { NavigationController } from './navigation-controller.js';
import { AuthController } from './auth-controller.js';
import { LetterController } from './letter-controller.js';
import { DraftController } from './draft-controller.js';
import { SettingsController } from './settings-controller.js';
import { NotificationController } from './notification-controller.js';
import { AppInitializationController } from './app-initialization-controller.js';
import { AppEventCoordinatorController } from './app-event-coordinator-controller.js';
import { SessionLifecycleController } from './session-lifecycle-controller.js';
import { DraftSyncQueue } from '../services/draft-sync-queue.js';

export class AppController {
  constructor({ root, session, repository }) {
    this.root = root;
    this.session = session;
    this.repository = repository;
    this.state = new AppState();
    this.view = new AppView(root);
    this.previousListRoute = 'inbox';
    this.autosaveTimer = null;
    this.localPersistTimer = null;
    this.draftSyncQueue = new DraftSyncQueue();
    this.draftIdentity = new Map();
    // Un borrador descartado no debe resucitar por una sincronización pendiente.
    this.discardedDraftIds = new Set();
    this.notificationPoller = null;
    this.sessionPoller = null;
    this._sessionRevokedWhileRecoveryPending = false;
    this.setupSessionLifecycle();
    this.localDraftKey = null;
    this._lastRecoveryCode = '';
    this._lastRecoveryCodes = [];
    this._recoveryContinueRoute = 'home';
    this.routeCache = new Map();
    this.seenRoutes = new Set();
    this.routeRequestId = 0;
    this.routeCacheTtl = 60000;
    this.routePrefetches = new Map();
    this.routeCacheVersion = 0;
    this.searchTimer = null;
    this.searchRequestId = 0;
    this.letterThreadCache = new Map();
    this.pendingLetterActions = new Set();
    this.letterStampPreviewCache = new Map();
    this.paginationObserver = null;
    this.editorInputVersion = 0;
    this.systemThemeMedia = window.matchMedia?.('(prefers-color-scheme: dark)') || null;
  }















}

for (const modulePrototype of [
  NavigationController.prototype,
  AuthController.prototype,
  LetterController.prototype,
  DraftController.prototype,
  SettingsController.prototype,
  NotificationController.prototype,
  AppInitializationController.prototype,
  AppEventCoordinatorController.prototype,
  SessionLifecycleController.prototype
]) {
  const descriptors = Object.getOwnPropertyDescriptors(modulePrototype);
  delete descriptors.constructor;
  Object.defineProperties(AppController.prototype, descriptors);
}
