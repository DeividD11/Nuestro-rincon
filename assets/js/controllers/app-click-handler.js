import { showToast, showConfirmDialog } from '../utils/dom.js';
import { readPendingRecovery } from '../services/recovery-handoff.js';

export async function handleClick(event) {
const routeTarget = event.target.closest('[data-route]');
if (routeTarget) {
  event.preventDefault();
  await this.openRoute(routeTarget.dataset.route, true, { focus: true });
  return;
}
const actionTarget = event.target.closest('[data-action]');
if (!actionTarget) {
  const card = event.target.closest('[data-letter-id]');
  if (card?.dataset.letterId) await this.openLetter(card.dataset.letterId);
  return;
}
const action = actionTarget.dataset.action;
const guardedLetterActions = new Set(['toggle-favorite','toggle-archive','trash-letter','restore-letter','purge-letter','reply-letter','edit-draft','preview-send-draft']);
const guardedLetterId = guardedLetterActions.has(action) ? String(actionTarget.dataset.letterId || '') : '';
const guardedButtons = guardedLetterId
  ? [...this.root.querySelectorAll('button[data-letter-id]')].filter(button => button.dataset.letterId === guardedLetterId)
  : [];
if (guardedLetterId && this.pendingLetterActions.has(guardedLetterId)) return;
const previousDisabled = guardedButtons.map(button => [button, button.disabled]);
if (guardedLetterId) {
  this.pendingLetterActions.add(guardedLetterId);
  guardedButtons.forEach(button => { button.disabled = true; button.setAttribute('aria-busy', 'true'); });
}
try {
  switch (action) {
    case 'enable-push-notifications': await this.enablePushNotifications(); break;
    case 'disable-push-notifications': await this.disablePushNotifications(); break;
    case 'show-register': { const pending = readPendingRecovery(); this.view.renderRegister('', ['registration', 'registration_bundle'].includes(pending?.purpose) ? pending : null); break; }
    case 'show-login': this.view.renderLogin(); break;
    case 'show-recovery': this.view.renderRecovery(); break;
    case 'copy-recovery': {
      if (!this._lastRecoveryCode) throw new Error('No hay un código disponible para copiar.');
      let copied = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(this._lastRecoveryCode);
          copied = true;
        }
      } catch { /* Se intenta la copia compatible con navegadores antiguos. */ }
      if (!copied) {
        const field = document.createElement('textarea');
        field.value = this._lastRecoveryCode;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.opacity = '0';
        this.root.append(field);
        field.select();
        try { copied = document.execCommand('copy') === true; } catch { copied = false; }
        field.remove();
      }
      if (!copied) {
        const codeElement = this.root.querySelector('.recovery-list');
        if (codeElement) {
          const range = document.createRange();
          range.selectNodeContents(codeElement);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
        throw new Error('No se pudo copiar automáticamente. El código quedó seleccionado para copiarlo manualmente.');
      }
      showToast('Código copiado. Guárdalo fuera de este dispositivo.', 'success');
      break;
    }
    case 'continue-after-recovery': await this.continueAfterRecoverySaved(); break;
    case 'retry-recovery-operation': await this.retryRecoveryOperation(); break;
    case 'open-mobile-nav': this.state.mobileNavOpen = true; this.render(); this.root.querySelector('.mobile-nav-close')?.focus?.({ preventScroll: true }); break;
    case 'close-mobile-nav': this.state.mobileNavOpen = false; this.render(); this.root.querySelector('.mobile-menu')?.focus?.({ preventScroll: true }); break;
    case 'logout': {
      const approved = await showConfirmDialog({
        tone: 'neutral', title: 'Cerrar sesión',
        message: '¿Quieres cerrar tu sesión en este dispositivo?',
        detail: 'Podrás volver a entrar con tu nombre de usuario y contraseña.',
        confirmLabel: 'Cerrar sesión', cancelLabel: 'Seguir aquí', icon: '↗'
      });
      if (approved) { await this.session.logout(); this.stopNotificationPolling(); this.stopSessionRefreshPolling(); this.resetPrivateSessionState(null); this.view.renderLogin(); }
      break;
    }
    case 'create-invitation': {
      actionTarget.disabled = true;
      const result = await this.session.api.auth('invitation:create');
      this.state.invitation = {
        ...(this.state.invitation || {}),
        canCreate: false,
        pending: true,
        expiresAt: result.expiresAt,
        revealedCode: result.code
      };
      this.invalidateRouteCache();
      this.render();
      showToast('Invitación generada. Copia y comparte el código en privado.', 'success');
      break;
    }
    case 'revoke-invitation': {
      const approved = await showConfirmDialog({
        tone: 'warning', title: 'Revocar invitación',
        message: 'El código dejará de ser válido inmediatamente.',
        detail: 'Si ya lo compartiste, la otra persona no podrá utilizarlo. Después podrás generar uno nuevo.',
        confirmLabel: 'Revocar código', cancelLabel: 'Conservar invitación'
      });
      if (!approved) break;
      await this.session.api.auth('invitation:revoke');
      this.state.invitation = { ...(this.state.invitation || {}), pending: false, canCreate: true, expiresAt: null, revealedCode: '' };
      this.invalidateRouteCache();
      this.render();
      showToast('La invitación fue revocada.', 'success');
      break;
    }
    case 'copy-invitation': {
      const code = this.state.invitation?.revealedCode;
      if (!code) throw new Error('El código ya no está disponible en esta pantalla.');
      await navigator.clipboard.writeText(code);
      showToast('Código de invitación copiado.', 'success');
      break;
    }
    case 'dismiss-invitation-code': {
      this.state.invitation = { ...(this.state.invitation || {}), revealedCode: '' };
      this.render();
      break;
    }
    case 'open-notifications': await this.openRoute('notifications', true, { focus: true }); break;
    case 'open-letter': {
      const targetId = actionTarget.dataset.letterId;
      const inThread = this.state.route === 'letter'
        ? this.state.selectedLetter?.thread?.find(item => String(item.id) === String(targetId))
        : null;
      await this.openLetter(targetId, true, inThread || this.letterSummary(targetId));
      break;
    }
    case 'retry-route': await this.openRoute(this.state.route, false); break;
    case 'retry-letter': await this.openLetter(this.state.selectedLetter?.letter?.id, false, this.state.selectedLetter?.letter); break;
    case 'back-to-list': await this.openRoute(this.previousListRoute, true, { focus: true }); break;
    case 'cancel-editor': await this.openRoute(this.previousListRoute || 'drafts', true, { focus: true }); break;
    case 'save-draft': await this.saveDraft(false); break;
    case 'preview-send': await this.previewSend(); break;
    case 'preview-send-draft': await this.openLetterForSend(actionTarget.dataset.letterId); break;
    case 'confirm-send': await this.confirmSend(); break;
    case 'dismiss-modal': this.closeModal(); break;
    case 'edit-draft': await this.editDraft(actionTarget.dataset.letterId); break;
    case 'reply-letter': await this.startReply(actionTarget.dataset.letterId); break;
    case 'format-bold': this.execFormat('bold'); break;
    case 'format-italic': this.execFormat('italic'); break;
    case 'format-underline': this.execFormat('underline'); break;
    case 'format-left': this.execFormat('justifyLeft'); break;
    case 'format-center': this.execFormat('justifyCenter'); break;
    case 'format-right': this.execFormat('justifyRight'); break;
    case 'toggle-favorite': {
      const letterId = String(actionTarget.dataset.letterId || '');
      const source = this.state.selectedLetter?.letter?.id === letterId
        ? this.state.selectedLetter.letter
        : (this.state.letters || []).find(item => String(item.id) === letterId);
      if (!source) throw new Error('No encontramos la carta para actualizar el favorito.');
      const before = this.snapshotLetterState();
      const next = !Boolean(source.isFavorite);
      this.patchLetterState(letterId, { isFavorite: next }, { removeFromList: this.state.route === 'favorites' && !next });
      this.renderCurrentRoute();
      try {
        const result = await this.repository.setFavorite(letterId, next);
        if (result?.status !== 'updated') throw new Error('No se pudo actualizar el favorito. La carta puede estar en Papelera o ya no estar disponible.');
        this.invalidateRouteCache();
        showToast(next ? 'Añadida a Favoritos.' : 'Quitada de Favoritos.', 'success');
      } catch (error) {
        this.restoreLetterState(before);
        throw error;
      }
      break;
    }
    case 'toggle-archive': {
      const letterId = String(actionTarget.dataset.letterId || '');
      const source = this.state.selectedLetter?.letter?.id === letterId
        ? this.state.selectedLetter.letter
        : (this.state.letters || []).find(item => String(item.id) === letterId);
      if (!source) throw new Error('No encontramos la carta para actualizar el Archivo.');
      const before = this.snapshotLetterState();
      const next = !Boolean(source.isArchived);
      const removeFromList = (['inbox','sent'].includes(this.state.route) && next)
        || (this.state.route === 'archive' && !next);
      this.patchLetterState(letterId, { isArchived: next }, { removeFromList });
      this.renderCurrentRoute();
      try {
        const result = await this.repository.setArchive(letterId, next);
        if (result?.status !== 'updated') throw new Error('No se pudo actualizar el Archivo. La carta puede estar en Papelera o ya no estar disponible.');
        this.invalidateRouteCache();
        showToast(next ? 'Carta guardada en Archivo.' : 'Carta retirada del Archivo.', 'success');
      } catch (error) {
        this.restoreLetterState(before);
        throw error;
      }
      break;
    }
    case 'trash-letter': {
      const letterId = actionTarget.dataset.letterId;
      const currentItem = this.state.letters.find(item => item.id === letterId);
      const selectedItem = this.state.selectedLetter?.letter?.id === letterId ? this.state.selectedLetter.letter : null;
      const isDraft = actionTarget.dataset.letterStatus === 'draft' || currentItem?.status === 'draft' || selectedItem?.status === 'draft';
      // Descartar un borrador es reversible desde Papelera: no requiere una
      // segunda pulsación de confirmación. Para cartas compartidas sí se confirma.
      if (!isDraft && !(await showConfirmDialog({
        tone: 'warning', title: 'Mover carta a Papelera',
        message: 'La carta dejará de aparecer en tus carpetas habituales.',
        detail: 'Podrás recuperarla desde Papelera mientras no se elimine definitivamente.',
        confirmLabel: 'Mover a Papelera', cancelLabel: 'Cancelar', icon: '⌑'
      }))) break;
      await this.discardLetter(letterId, isDraft);
      break;
    }
    case 'restore-letter': {
      const letterId = String(actionTarget.dataset.letterId || '');
      const before = this.snapshotLetterState();
      this.state.letters = (this.state.letters || []).filter(item => String(item.id) !== letterId);
      if (this.state.selectedLetter?.letter?.id === letterId) this.state.selectedLetter = null;
      if (this.state.route === 'letter') {
        this.state.route = this.previousListRoute || 'trash';
        history.replaceState(null, '', `#/${this.state.route}`);
      }
      this.renderCurrentRoute();
      try {
        const restored = await this.repository.restore(letterId);
        if (restored.status !== 'restored') throw new Error('No se pudo recuperar la carta. Actualiza la lista e inténtalo de nuevo.');
        this.discardedDraftIds.delete(letterId);
        this.invalidateRouteCache();
        showToast('Carta recuperada.', 'success');
      } catch (error) {
        this.restoreLetterState(before);
        throw error;
      }
      break;
    }
    case 'purge-letter': {
      const approved = await showConfirmDialog({
        tone: 'danger', title: 'Eliminar definitivamente',
        message: 'Esta acción no se puede deshacer cuando el proceso de eliminación se complete.',
        detail: 'En una carta compartida, tu confirmación queda registrada y la eliminación del contenido solo se completa cuando ambas personas la confirman.',
        confirmLabel: 'Eliminar definitivamente', cancelLabel: 'Mantener en Papelera'
      });
      if (!approved) break;
      const letterId = String(actionTarget.dataset.letterId || '');
      const before = this.snapshotLetterState();
      const optimisticAt = new Date().toISOString();
      // El botón cambia a estado de proceso mientras llega la respuesta,
      // pero no afirmamos que la confirmación quedó guardada antes del ACK.
      this.renderCurrentRoute();
      try {
        const result = await this.repository.purge(letterId);
        if (result.status === 'pending_other_participant' || result.status === 'already_confirmed_waiting') {
          this.patchLetterState(letterId, { purgeConfirmedAt: optimisticAt });
          showToast(result.status === 'pending_other_participant'
            ? 'Tu confirmación quedó guardada. La carta seguirá en Papelera hasta que la otra persona confirme.'
            : 'Ya habías confirmado. Solo falta que la otra persona confirme.', 'info', { duration: 6500 });
        } else if (result.status === 'purged' || result.status === 'already_purged') {
          this.state.letters = (this.state.letters || []).filter(item => String(item.id) !== letterId);
          if (this.state.selectedLetter?.letter?.id === letterId) this.state.selectedLetter = null;
          if (this.state.route === 'letter') {
            this.state.route = 'trash';
            history.replaceState(null, '', '#/trash');
          }
          showToast('El contenido se eliminó para ambas personas.', 'success');
        } else {
          throw new Error(result.status === 'not_in_trash'
            ? 'Primero mueve la carta a Papelera para eliminarla definitivamente.'
            : 'No se pudo confirmar la eliminación. Actualiza la Papelera e inténtalo de nuevo.');
        }
        this.invalidateRouteCache();
        this.renderCurrentRoute();
      } catch (error) {
        this.restoreLetterState(before);
        throw error;
      }
      break;
    }
    case 'download-txt': await this.downloadTxt(actionTarget.dataset.letterId); break;
    case 'download-html': await this.downloadHtml(actionTarget.dataset.letterId); break;
    case 'print-letter': window.print(); break;
    case 'read-notification': await this.repository.markNotificationRead(actionTarget.dataset.notificationId); this.invalidateRouteCache(); await this.openRoute('notifications', false); break;
    case 'revoke-session': {
      const approved = await showConfirmDialog({
        tone: 'warning', title: 'Revocar sesión',
        message: 'El dispositivo seleccionado perderá el acceso a Nuestro Rincón.',
        detail: 'La persona que lo esté utilizando tendrá que iniciar sesión nuevamente.',
        confirmLabel: 'Revocar acceso', cancelLabel: 'Conservar sesión', icon: '⌑'
      });
      if (!approved) break;
      const sessionId = actionTarget.dataset.sessionId;
      await this.repository.revokeSession(sessionId);
      this.state.sessions = (this.state.sessions || []).filter(item => item.id !== sessionId);
      this.sessionChannel?.postMessage({ type: 'session-revoked', sessionId });
      this.render();
      showToast('Sesión revocada.', 'success');
      await this.refreshSessions();
      break;
    }
  }
} catch (error) {
  showToast(error.message || 'La operación no se pudo completar.', 'error');
  if (error.status === 401) this.forceLogout();
} finally {
  if (guardedLetterId) {
    this.pendingLetterActions.delete(guardedLetterId);
    previousDisabled.forEach(([button, wasDisabled]) => {
      if (!button.isConnected) return;
      button.disabled = wasDisabled;
      button.removeAttribute('aria-busy');
    });
    if (previousDisabled.some(([button]) => !button.isConnected)) this.renderCurrentRoute();
  }
}
}
