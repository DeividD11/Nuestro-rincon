import { ApiClient } from './services/api-client.js';
import { SessionService } from './services/session-service.js';
import { LetterRepository } from './repositories/letter-repository.js';
import { AppController } from './controllers/app-controller.js';

const root = document.querySelector('#app');
const session = new SessionService(null);
const api = new ApiClient(session);
session.api = api;
const repository = new LetterRepository(api);
const app = new AppController({ root, session, repository });
app.init().catch(error => {
  console.error('Error al iniciar Nuestro Rincón:', error);
  root.innerHTML = '<div class="boot-screen"><span class="brand-seal">N</span><p>No se pudo iniciar la aplicación. Comprueba la configuración y recarga.</p></div>';
});
