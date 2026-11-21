export class LetterRepository {
  constructor(api) { this.api = api; }
  dashboard() { return this.api.letters('dashboard'); }
  list(folder = 'inbox', search = '', offset = 0, limit = 40) { return this.api.letters('list', { folder, search, offset, limit }); }
  get(letterId, threadOffset = 0, threadLimit = 40) { return this.api.letters('get', { letterId, threadOffset, threadLimit }); }
  createDraft(data, options = {}) { return this.api.letters('draft:create', data, options); }
  saveDraft(data, options = {}) { return this.api.letters('draft:save', data, options); }
  sendDraft(data) { return this.api.letters('draft:send', data); }
  reply(data) { return this.api.letters('reply', data); }
  markRead(threadId) { return this.api.letters('read', { threadId }); }
  setFavorite(letterId, favorite) { return this.api.letters('favorite', { letterId, favorite }); }
  setArchive(letterId, archived) { return this.api.letters('archive', { letterId, archived }); }
  moveToTrash(letterId) { return this.api.letters('trash', { letterId }); }
  restore(letterId) { return this.api.letters('restore', { letterId }); }
  purge(letterId) { return this.api.letters('purge', { letterId }); }
  notifications(offset = 0, limit = 30) { return this.api.letters('notifications', { offset, limit }); }
  markNotificationRead(notificationId) { return this.api.letters('notification:read', { notificationId }); }
  settings() { return this.api.letters('settings:get'); }
  saveSettings(settings) { return this.api.letters('settings:update', settings); }
  sessions() { return this.api.letters('sessions'); }
  revokeSession(sessionId) { return this.api.letters('session:revoke', { sessionId }); }
  renameProfile(displayName) { return this.api.letters('profile:rename', { displayName }); }
  updateAccount(data) { return this.api.auth('account:update', data); }
  updatePassword(data) { return this.api.auth('password:update', data); }
}
