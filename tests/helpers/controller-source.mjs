import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const files = [
  'assets/js/controllers/app-controller.js',
  'assets/js/controllers/app-initialization-controller.js',
  'assets/js/controllers/app-event-coordinator-controller.js',
  'assets/js/controllers/session-lifecycle-controller.js',
  'assets/js/controllers/app-submit-handler.js',
  'assets/js/controllers/app-click-handler.js',
  'assets/js/controllers/navigation-controller.js',
  'assets/js/controllers/auth-controller.js',
  'assets/js/controllers/letter-controller.js',
  'assets/js/controllers/draft-controller.js',
  'assets/js/controllers/settings-controller.js',
  'assets/js/controllers/notification-controller.js',
  'assets/js/services/draft-sync-queue.js',
  'assets/js/services/adaptive-poller.js'
];

export async function readControllerSource() {
  const sources = await Promise.all(files.map(file => readFile(resolve(root, file), 'utf8')));
  return sources.join('\n\n/* --- controller module boundary --- */\n\n');
}

export async function readControllerModule(fileName) {
  if (!/^(?:app|auth|navigation|letter|draft|settings|notification)-controller\.js$|^app-(?:submit|click)-handler\.js$|^(?:app-initialization|app-event-coordinator|session-lifecycle)-controller\.js$/.test(fileName)) {
    throw new Error('CONTROLLER_MODULE_NOT_ALLOWED');
  }
  return readFile(resolve(root, 'assets/js/controllers', fileName), 'utf8');
}
