/**
 * Conserva los nodos de avatar entre renders de ruta. Al reinsertar el mismo
 * <img> se mantiene su caché/decodificación y no se repite la descarga.
 */
export class AvatarNodeCache {
  constructor(root) {
    this.root = root;
    this.identity = '';
    this.sidebarNode = null;
    this.settingsPreviewNode = null;
  }

  avatarIdentity(profile = {}) {
    // La ruta es estable aunque Storage renueve la firma de su URL.
    return String(profile?.avatarPath || profile?.previewUrl || profile?.avatarUrl || '');
  }

  capture(profile = {}) {
    const identity = this.avatarIdentity(profile);
    if (identity !== this.identity) {
      this.identity = identity;
      this.sidebarNode = null;
      this.settingsPreviewNode = null;
      return;
    }
    const sidebar = this.root.querySelector?.('.user-mini .avatar');
    const preview = this.root.querySelector?.('.profile-avatar-preview');
    if (sidebar) this.sidebarNode = sidebar;
    if (preview) this.settingsPreviewNode = preview;
  }

  adopt(profile = {}) {
    const identity = this.avatarIdentity(profile);
    if (identity !== this.identity) {
      this.identity = identity;
      this.sidebarNode = null;
      this.settingsPreviewNode = null;
    }
    const sidebar = this.root.querySelector?.('.user-mini .avatar');
    const preview = this.root.querySelector?.('.profile-avatar-preview');
    if (sidebar) this.sidebarNode = sidebar;
    if (preview) this.settingsPreviewNode = preview;
  }

  hasSidebar(profile = {}) {
    if (!this.sidebarNode || this.avatarIdentity(profile) !== this.identity) return false;
    // Si existe una URL en el estado pero el nodo cacheado perdió su <img>,
    // reconstruirlo desde el estado en vez de conservar solo las iniciales.
    const hasImageSource = Boolean(profile?.previewUrl || profile?.avatarUrl);
    return !hasImageSource || Boolean(this.sidebarNode.querySelector?.('img'));
  }

  hasSidebarImage(profile = {}) {
    if (!this.sidebarNode || this.avatarIdentity(profile) !== this.identity) return false;
    const image = this.sidebarNode.querySelector?.('img');
    // Una descarga pendiente también es válida: evita sustituirla durante una
    // navegación. Si ya terminó sin píxeles, debe solicitarse una URL nueva.
    return Boolean(image && (!image.complete || image.naturalWidth > 0));
  }

  hasSettingsPreview(profile = {}) {
    return Boolean(this.settingsPreviewNode && this.avatarIdentity(profile) === this.identity);
  }

  restore(route, { restoreSidebar = true } = {}) {
    const sidebar = this.root.querySelector?.('.user-mini .avatar');
    if (sidebar && restoreSidebar && this.sidebarNode) sidebar.replaceWith(this.sidebarNode);
    else if (sidebar) this.sidebarNode = sidebar;
    this.reconcileRestoredSidebarImage();
    if (route !== 'settings') return;
    const preview = this.root.querySelector?.('.profile-avatar-preview');
    if (preview && this.settingsPreviewNode) preview.replaceWith(this.settingsPreviewNode);
    else if (preview) this.settingsPreviewNode = preview;
  }

  reconcileRestoredSidebarImage() {
    const container = this.root.querySelector?.('.user-mini .avatar') || this.sidebarNode;
    const image = container?.querySelector?.('img');
    if (!container || !image || !image.complete) return;

    const finish = () => {
      if (!image.isConnected || !container.isConnected) return;
      if (image.naturalWidth > 0) {
        container.classList?.remove('is-loading');
        return;
      }
      // El evento error pudo ocurrir mientras el nodo estaba separado del DOM.
      image.remove?.();
      container.classList?.remove('has-image', 'is-loading');
      const placeholder = container.querySelector?.('.avatar-image-placeholder');
      if (placeholder?.style) placeholder.style.opacity = '1';
    };

    if (image.naturalWidth > 0 && typeof image.decode === 'function') {
      image.decode().then(finish).catch(finish);
    } else {
      finish();
    }
  }
}
