import { APP_CONFIG } from '../config/app-config.js';

function uploadError(status) {
  const messages = {
    400: 'Supabase Storage rechazó la imagen. Comprueba que el archivo sea una imagen JPEG, PNG o WebP válida.',
    401: 'El permiso temporal de carga ha caducado. Vuelve a seleccionar la imagen e inténtalo de nuevo.',
    403: 'Supabase Storage no autorizó la carga. Actualiza la página y vuelve a intentarlo.',
    404: 'No se encontró el almacenamiento privado de imágenes. Comprueba la configuración de Supabase.',
    409: 'Ya existe un archivo en esa ruta. Vuelve a seleccionar la imagen para generar una ruta nueva.',
    413: 'La imagen supera el límite permitido por el almacenamiento privado.',
    415: 'El formato de la imagen no está permitido. Utiliza JPEG, PNG o WebP.'
  };
  const error = new Error(messages[status] || `Supabase Storage no pudo guardar la imagen (HTTP ${status}). Vuelve a intentarlo.`);
  error.code = `MEDIA_UPLOAD_HTTP_${status}`;
  error.status = status;
  return error;
}

/**
 * Sube un Blob a una URL temporal firmada por letters-api.
 * Nunca envía cookies ni credenciales de la sesión a Storage: el token firmado
 * es la única autorización para esta operación.
 */
export async function uploadPrivateMedia(uploadUrl, blob) {
  if (!(blob instanceof Blob) || !blob.size || !/^image\/(?:jpeg|png|webp)$/i.test(blob.type)) {
    const error = new Error('La imagen preparada no tiene un formato válido. Selecciona otra imagen JPEG, PNG o WebP.');
    error.code = 'MEDIA_UPLOAD_FILE_INVALID';
    throw error;
  }

  let target;
  let expectedOrigin;
  try {
    target = new URL(String(uploadUrl));
    expectedOrigin = new URL(APP_CONFIG.supabaseUrl).origin;
  } catch {
    const error = new Error('Supabase no devolvió una dirección de carga válida. Vuelve a intentarlo.');
    error.code = 'MEDIA_UPLOAD_URL_INVALID';
    throw error;
  }
  if (target.protocol !== 'https:' || target.origin !== expectedOrigin
      || !target.pathname.startsWith('/storage/v1/object/upload/sign/private-media/')) {
    const error = new Error('La dirección de carga no corresponde al almacenamiento privado de Nuestro Rincón.');
    error.code = 'MEDIA_UPLOAD_URL_INVALID';
    throw error;
  }

  let response;
  try {
    response = await fetch(target.href, {
      method: 'PUT',
      headers: { 'Content-Type': blob.type },
      body: blob,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error'
    });
  } catch {
    const error = new Error('No se pudo conectar con Supabase Storage. Comprueba tu conexión e inténtalo de nuevo.');
    error.code = 'MEDIA_UPLOAD_NETWORK_ERROR';
    throw error;
  }

  if (!response.ok) throw uploadError(response.status);
  return { status: response.status };
}
