import { showToast, showConfirmDialog, beginActionToast } from '../utils/dom.js';
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
const guardedLetterActions = new Set(['toggle-favorite','toggle-archive','trash-letter','restore-letter','purge-letter','reply-letter','edit-draft','preview-send-draft','edit-sent-letter']);
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
    case 'remove-profile-avatar': {
      const approved = await showConfirmDialog({ tone: 'warning', title: 'Quitar avatar', message: 'La imagen dejará de mostrarse en tu perfil.', confirmLabel: 'Quitar avatar', cancelLabel: 'Conservar imagen' });
      if (approved) await this.removeProfileAvatar();
      break;
    }
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
      if (approved) { await this.session.logout(); this.stopNotificationPolling(); this.stopSessionRefreshPolling(); this.resetPrivateSessionState(null); this.view.renderLogin('', 'Has cerrado sesión correctamente en este dispositivo.'); }
      break;
    }
    case 'create-invitation': {
      actionTarget.disabled = true;
      const feedback = beginActionToast('Generando el código de invitación…');
      try {
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
      feedback.success('La invitación se generó correctamente. Copia y comparte el código en privado.');
      } catch (error) { feedback.error(error.message || 'No se pudo generar la invitación.'); error.actionFeedbackShown = true; throw error; }
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
      const feedback = beginActionToast('Revocando el código de invitación…');
      try {
      await this.session.api.auth('invitation:revoke');
      this.state.invitation = { ...(this.state.invitation || {}), pending: false, canCreate: true, expiresAt: null, revealedCode: '' };
      this.invalidateRouteCache();
      this.render();
      feedback.success('La invitación fue revocada.');
      } catch (error) { feedback.error(error.message || 'No se pudo revocar la invitación.'); error.actionFeedbackShown = true; throw error; }
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
    case 'back-to-list': await this.navigateBack(this.previousListRoute || 'inbox'); break;
    case 'cancel-editor': await this.navigateBack(this.previousListRoute || 'drafts'); break;
    case 'save-draft': {
      const result = await this.saveDraft(false);
      if (['saved', 'created', 'local'].includes(result?.status)) {
        await this.openRoute('drafts', true, { focus: true, skipHistory: true });
      }
      break;
    }
    case 'preview-send': await this.previewSend(); break;
    case 'save-sent-edits': await this.saveSentLetterEdits(); break;
    case 'preview-send-draft': await this.openLetterForSend(actionTarget.dataset.letterId); break;
    case 'confirm-send': await this.confirmSend(); break;
    case 'dismiss-modal': this.closeModal(); break;
    case 'edit-draft': await this.editDraft(actionTarget.dataset.letterId); break;
    case 'edit-local-draft': await this.editLocalDraft(actionTarget.dataset.localDraftKey); break;
    case 'discard-local-draft': await this.discardLocalDraft(actionTarget.dataset.localDraftKey, actionTarget.dataset.letterId || ''); break;
    case 'delete-all-trash': {
      const approved = await showConfirmDialog({
        tone: 'danger', title: 'Eliminar todo de la Papelera',
        message: 'Se procesarán todas las cartas y respuestas que están actualmente en tu Papelera, incluidas las que todavía no has revisado en páginas posteriores.',
        detail: 'Las cartas y respuestas creadas por ti se eliminarán definitivamente para ambas personas. En los mensajes creados por la otra persona se registrará tu confirmación; el contenido compartido solo se eliminará cuando también se confirme desde la otra cuenta. Los borradores que siguen en Borradores no se modificarán.',
        confirmLabel: 'Eliminar todo', cancelLabel: 'Conservar Papelera'
      });
      if (approved) await this.deleteAllTrash();
      break;
    }
    case 'edit-sent-letter': await this.startEditSentLetter(actionTarget.dataset.letterId); break;
    case 'choose-letter-image': {
      const editor = this.root.querySelector('#letter-editor');
      const selection = window.getSelection();
      this._letterImageInsertionRange = selection?.rangeCount && editor?.contains(selection.getRangeAt(0).commonAncestorContainer)
        ? selection.getRangeAt(0).cloneRange() : null;
      this.root.querySelector('#letter-image-input')?.click();
      break;
    }
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
      const feedback = beginActionToast(next ? 'Añadiendo la carta a Favoritos…' : 'Quitando la carta de Favoritos…');
      try {
        const result = await this.repository.setFavorite(letterId, next);
        if (result?.status !== 'updated') throw new Error('No se pudo actualizar el favorito. La carta puede estar en Papelera o ya no estar disponible.');
        this.invalidateRouteCache();
        feedback.success(next ? 'La carta se añadió a Favoritos.' : 'La carta se quitó de Favoritos.');
      } catch (error) {
        this.restoreLetterState(before);
        feedback.error(error.message || 'No se pudo actualizar Favoritos.');
        error.actionFeedbackShown = true;
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
      const feedback = beginActionToast(next ? 'Guardando la carta en Archivo…' : 'Retirando la carta de Archivo…');
      try {
        const result = await this.repository.setArchive(letterId, next);
        if (result?.status !== 'updated') throw new Error('No se pudo actualizar el Archivo. La carta puede estar en Papelera o ya no estar disponible.');
        this.invalidateRouteCache();
        feedback.success(next ? 'La carta se guardó en Archivo.' : 'La carta se retiró de Archivo.');
      } catch (error) {
        this.restoreLetterState(before);
        feedback.error(error.message || 'No se pudo actualizar Archivo.');
        error.actionFeedbackShown = true;
        throw error;
      }
      break;
    }
    case 'trash-letter': {
      const letterId = actionTarget.dataset.letterId;
      const currentItem = this.state.letters.find(item => item.id === letterId);
      const selectedItem = this.state.selectedLetter?.letter?.id === letterId ? this.state.selectedLetter.letter : null;
      const source = currentItem || selectedItem || this.state.selectedLetter?.thread?.find(item => String(item.id) === String(letterId));
      const isDraft = actionTarget.dataset.letterStatus === 'draft' || source?.status === 'draft';
      const withdrawToDraft = !isDraft && source?.status === 'sent'
        && String(source.sender_id) === String(this.session?.user?.id) && !source.isInTrash;
      // El autor retira su propia creación y la recupera como borrador; para
      // el destinatario, descartar solo afecta a su carpeta personal.
      if (!isDraft && !(await showConfirmDialog({
        tone: 'warning', title: withdrawToDraft ? 'Retirar a Borradores' : 'Mover carta a Papelera',
        message: withdrawToDraft
          ? 'La carta o respuesta dejará de formar parte de la conversación compartida.'
          : 'La carta dejará de aparecer en tus carpetas habituales.',
        detail: withdrawToDraft
          ? 'La otra persona ya no podrá verla. Podrás editarla y enviarla de nuevo desde Borradores.'
          : 'Podrás recuperarla desde Papelera mientras no se elimine definitivamente.',
        confirmLabel: withdrawToDraft ? 'Retirar a Borradores' : 'Mover a Papelera',
        cancelLabel: 'Cancelar', icon: '⌑'
      }))) break;
      await this.discardLetter(letterId, isDraft);
      break;
    }
    case 'restore-letter': {
      if (this._bulkPurgingTrash) break;
      const before = this.snapshotLetterState();
      this.state.letters = (this.state.letters || []).filter(item => String(item.id) !== letterId);
      if (this.state.selectedLetter?.letter?.id === letterId) this.state.selectedLetter = null;
      if (this.state.route === 'letter') {
        this.state.route = this.previousListRoute || 'trash';
        history.replaceState(null, '', `#/${this.state.route}`);
      }
      this.renderCurrentRoute();
      const feedback = beginActionToast('Recuperando la carta…');
      try {
        const restored = await this.repository.restore(letterId);
        if (restored.status !== 'restored') throw new Error('No se pudo recuperar la carta. Actualiza la lista e inténtalo de nuevo.');
        this.discardedDraftIds.delete(letterId);
        this.invalidateRouteCache();
        feedback.success('La carta se recuperó correctamente.');
      } catch (error) {
        this.restoreLetterState(before);
        feedback.error(error.message || 'No se pudo recuperar la carta.');
        error.actionFeedbackShown = true;
        throw error;
      }
      break;
    }
    case 'purge-letter': {
      if (this._bulkPurgingTrash) break;
      const letterId = String(actionTarget.dataset.letterId || '');
      const purgeSource = this.state.letters.find(item => String(item.id) === letterId)
        || this.state.selectedLetter?.thread?.find(item => String(item.id) === letterId)
        || (String(this.state.selectedLetter?.letter?.id || '') === letterId ? this.state.selectedLetter.letter : null);
      const ownerPurge = Boolean(purgeSource && String(purgeSource.sender_id) === String(this.session?.user?.id));
      const approved = await showConfirmDialog({
        tone: 'danger', title: 'Eliminar definitivamente',
        message: 'Esta acción no se puede deshacer cuando el proceso de eliminación se complete.',
        detail: ownerPurge
          ? 'Como creador, puedes eliminar tu carta o respuesta sin autorización de la otra persona. Dejará de estar disponible para ambos.'
          : 'En una carta compartida, tu confirmación queda registrada y la eliminación del contenido solo se completa cuando ambas personas la confirman.',
        confirmLabel: 'Eliminar definitivamente', cancelLabel: 'Mantener en Papelera'
      });
      if (!approved) break;
      const before = this.snapshotLetterState();
      const optimisticAt = new Date().toISOString();
      const feedback = beginActionToast('Registrando la confirmación de eliminación…');
      // El botón cambia a estado de proceso mientras llega la respuesta,
      // pero no afirmamos que la confirmación quedó guardada antes del ACK.
      this.renderCurrentRoute();
      try {
        const result = await this.repository.purge(letterId);
        if (result.status === 'pending_other_participant' || result.status === 'already_confirmed_waiting') {
          this.patchLetterState(letterId, { purgeConfirmedAt: optimisticAt });
          feedback.info(result.status === 'pending_other_participant'
            ? 'Tu confirmación quedó guardada. La carta seguirá en Papelera hasta que la otra persona confirme.'
            : 'Ya habías confirmado. Solo falta que la otra persona confirme.', { duration: 6500 });
        } else if (result.status === 'purged' || result.status === 'already_purged') {
          this.state.letters = (this.state.letters || []).filter(item => String(item.id) !== letterId);
          if (this.state.selectedLetter?.letter?.id === letterId) this.state.selectedLetter = null;
          if (this.state.route === 'letter') {
            this.state.route = 'trash';
            history.replaceState(null, '', '#/trash');
          }
          feedback.success(ownerPurge ? 'Tu carta o respuesta se eliminó definitivamente y ya no está disponible para la otra persona.' : 'El contenido se eliminó para ambas personas.');
        } else {
          throw new Error(result.status === 'not_in_trash'
            ? 'Primero mueve la carta a Papelera para eliminarla definitivamente.'
            : 'No se pudo confirmar la eliminación. Actualiza la Papelera e inténtalo de nuevo.');
        }
        this.invalidateRouteCache();
        this.renderCurrentRoute();
      } catch (error) {
        this.restoreLetterState(before);
        feedback.error(error.message || 'No se pudo confirmar la eliminación.');
        error.actionFeedbackShown = true;
        throw error;
      }
      break;
    }
    case 'print-letter': await this.saveLetterAsPdf(); break;
    case 'read-notification': await this.repository.markNotificationRead(actionTarget.dataset.notificationId); this.invalidateRouteCache(); await this.openRoute('notifications', false); break;
    case 'revoke-other-sessions': {
      const otherCount = (this.state.sessions || []).filter(item => !item.isCurrent).length;
      const approved = await showConfirmDialog({
        tone: 'warning', title: 'Revocar las demás sesiones',
        message: otherCount
          ? `Se cerrarán ${otherCount} sesiones activas que aparecen en esta lista y cualquier otra sesión no revocada de tu cuenta.`
          : 'Se cerrarán todas las demás sesiones no revocadas, incluidas las que hayan caducado.',
        detail: 'Este dispositivo y esta sesión permanecerán conectados. Los demás tendrán que iniciar sesión de nuevo.',
        confirmLabel: 'Revocar las demás', cancelLabel: 'Conservar sesiones', icon: '⌑'
      });
      if (!approved) break;
      const feedback = beginActionToast('Revocando las demás sesiones…');

      // Mantiene estable el anclaje visual incluso cuando la lista se acorta
      // estando la persona cerca del final de la página.
      const sessionCard = actionTarget.closest('.sessions-card');
      const anchorTop = sessionCard?.getBoundingClientRect().top ?? null;
      const sessionList = sessionCard?.querySelector('.session-list');
      const originalListMarkup = sessionList?.innerHTML ?? null;
      const originalSessions = [...(this.state.sessions || [])];
      const originalButtonText = actionTarget.textContent;
      const originalButtonDisabled = actionTarget.disabled;
      const restoreScroll = () => {
        if (anchorTop === null || !sessionCard?.isConnected) return;
        const nextTop = sessionCard.getBoundingClientRect().top;
        const delta = nextTop - anchorTop;
        if (Math.abs(delta) > 1) window.scrollTo({ left: 0, top: Math.max(0, (window.scrollY || 0) + delta), behavior: 'instant' });
      };

      actionTarget.disabled = true;
      actionTarget.setAttribute('aria-busy', 'true');
      actionTarget.textContent = 'Revocando…';
      // Actualización optimista y local: no se vuelve a renderizar la vista ni
      // se encadenan peticiones individuales por cada dispositivo.
      this.state.sessions = originalSessions.filter(item => item.isCurrent);
      sessionCard?.querySelectorAll('.session-row:not(.is-current)').forEach(row => row.remove());
      actionTarget.textContent = 'No hay otras sesiones por revocar';
      restoreScroll();

      try {
        const result = await this.repository.revokeOtherSessions();
        actionTarget.removeAttribute('aria-busy');
        actionTarget.disabled = true;
        actionTarget.textContent = 'No hay otras sesiones por revocar';
        this.sessionChannel?.postMessage({ type: 'sessions-revoked-except-current', currentSessionId: this.session.sessionId });
        this.invalidateRouteCache();
        restoreScroll();
        feedback.success(`Se revocaron ${Number(result.revokedCount || 0)} sesiones. Este dispositivo sigue conectado.`);
      } catch (error) {
        this.state.sessions = originalSessions;
        if (sessionList && originalListMarkup !== null) sessionList.innerHTML = originalListMarkup;
        actionTarget.textContent = originalButtonText;
        actionTarget.disabled = originalButtonDisabled;
        actionTarget.removeAttribute('aria-busy');
        restoreScroll();
        const displayedError = error.code === 'UNKNOWN_ACTION'
          ? new Error('La función letters-api de Supabase no está actualizada. Publica la versión incluida en este proyecto y vuelve a intentarlo.')
          : error;
        feedback.error(displayedError.message || 'No se pudieron revocar las sesiones.');
        displayedError.actionFeedbackShown = true;
        throw displayedError;
      }
      break;
    }
    case 'revoke-session': {
      const approved = await showConfirmDialog({
        tone: 'warning', title: 'Revocar sesión',
        message: 'El dispositivo seleccionado perderá el acceso a Nuestro Rincón.',
        detail: 'La persona que lo esté utilizando tendrá que iniciar sesión nuevamente.',
        confirmLabel: 'Revocar acceso', cancelLabel: 'Conservar sesión', icon: '⌑'
      });
      if (!approved) break;
      const sessionId = actionTarget.dataset.sessionId;
      const feedback = beginActionToast('Revocando la sesión seleccionada…');
      try {
        await this.repository.revokeSession(sessionId);
        this.state.sessions = (this.state.sessions || []).filter(item => item.id !== sessionId);
        this.sessionChannel?.postMessage({ type: 'session-revoked', sessionId });
        this.render();
        await this.refreshSessions();
        feedback.success('La sesión seleccionada fue revocada.');
      } catch (error) {
        feedback.error(error.message || 'No se pudo revocar la sesión.');
        error.actionFeedbackShown = true;
        throw error;
      }
      break;
    }
  }
} catch (error) {
  if (!error?.actionFeedbackShown) showToast(error.message || 'La operación no se pudo completar.', 'error');
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
