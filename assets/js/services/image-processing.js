const SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024;
const MAX_DECODED_PIXELS = 40_000_000;

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob !== 'function') {
      reject(new Error('Este navegador no permite exportar la imagen procesada. Actualiza el navegador e inténtalo de nuevo.'));
      return;
    }
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('No se pudo procesar la imagen.')), type, quality);
  });
}

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { width: bitmap.width, height: bitmap.height, draw: (context, width, height) => context.drawImage(bitmap, 0, 0, width, height), close: () => bitmap.close?.() };
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = 'async';
  image.src = url;
  try {
    await (image.decode ? image.decode() : new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('El navegador no pudo abrir esta imagen.'));
    }));
    return { width: image.naturalWidth, height: image.naturalHeight, draw: (context, width, height) => context.drawImage(image, 0, 0, width, height), close: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function keepSmallest(current, candidate) {
  if (!candidate || !SUPPORTED.has(candidate.type) || !candidate.size) return current;
  if (!current || candidate.size < current.blob.size) return { blob: candidate };
  return current;
}

/**
 * Normaliza imágenes una sola vez y limita el número de exportaciones del
 * canvas. En navegadores modernos suele bastar una codificación WebP; solo se
 * repite si hay que reducir el peso para el límite de Storage.
 */
export async function prepareImageFile(file, { maxDimension = 1920, maxBytes = 5 * 1024 * 1024 } = {}) {
  if (!(file instanceof Blob) || !SUPPORTED.has(file.type)) {
    throw new Error('Selecciona una imagen JPG, PNG o WebP.');
  }
  if (file.size <= 0 || file.size > MAX_ORIGINAL_BYTES) {
    throw new Error('La imagen original debe pesar menos de 20 MB.');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('El límite de tamaño de imagen no es válido.');
  }
  if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') {
    throw new Error('Este navegador no permite procesar imágenes de forma segura.');
  }

  const decoded = await decodeImage(file);
  try {
    if (!decoded.width || !decoded.height || decoded.width * decoded.height > MAX_DECODED_PIXELS) {
      throw new Error('La imagen tiene demasiados píxeles. Selecciona una versión de menor resolución.');
    }
    const requestedMaxDimension = Math.max(128, Math.min(2048, Number(maxDimension) || 640));
    const sourceMaxDimension = Math.max(decoded.width, decoded.height);
    const effectiveMaxDimension = Math.min(requestedMaxDimension, sourceMaxDimension);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) throw new Error('No se pudo preparar la imagen en este navegador.');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';

    const drawAt = (scale) => {
      canvas.width = Math.max(1, Math.round(decoded.width * scale));
      canvas.height = Math.max(1, Math.round(decoded.height * scale));
      context.clearRect(0, 0, canvas.width, canvas.height);
      decoded.draw(context, canvas.width, canvas.height);
    };
    const encode = async (type, quality) => canvasBlob(canvas, type, quality);
    const firstScale = effectiveMaxDimension / sourceMaxDimension;
    drawAt(firstScale);

    // Primer intento: mejor calidad visual a la resolución prevista.
    let candidate = await encode('image/webp', 0.84);
    if (SUPPORTED.has(candidate.type) && candidate.size <= maxBytes) return candidate;

    if (candidate.type !== 'image/webp') {
      // Navegador sin WebP: conservar PNG si cabe; si no, intentar JPEG una
      // vez y ajustar la resolución según el peso real de la exportación.
      if (candidate.type === 'image/png' && candidate.size <= maxBytes) return candidate;
      context.save();
      context.globalCompositeOperation = 'destination-over';
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      let fallback = await encode('image/jpeg', 0.82);
      context.restore();
      if (SUPPORTED.has(fallback.type) && fallback.size <= maxBytes) return fallback;

      const sizeRatio = Math.sqrt(maxBytes / Math.max(1, fallback.size));
      const smallerScale = firstScale * Math.max(0.36, Math.min(0.9, sizeRatio * 0.88));
      drawAt(smallerScale);
      if (fallback.type === 'image/jpeg') {
        context.save();
        context.globalCompositeOperation = 'destination-over';
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        fallback = await encode('image/jpeg', 0.72);
        context.restore();
      } else {
        // Si el navegador ignora también image/jpeg, un PNG a menor resolución
        // puede caber sin perder transparencia.
        fallback = await encode('image/webp', 0.72);
      }
      if (SUPPORTED.has(fallback.type) && fallback.size <= maxBytes) return fallback;
      candidate = fallback;

    } else {
      // Ajuste basado en la relación entre peso real y peso objetivo, no una
      // cascada fija de tamaños/calidades que tarda más de lo necesario.
      const ratio = Math.sqrt(maxBytes / Math.max(1, candidate.size));
      const secondScale = firstScale * Math.max(0.48, Math.min(0.92, ratio * 0.9));
      drawAt(secondScale);
      candidate = await encode('image/webp', 0.76);
      if (candidate.type === 'image/webp' && candidate.size <= maxBytes) return candidate;

      if (candidate.type === 'image/webp') {
        const secondRatio = Math.sqrt(maxBytes / Math.max(1, candidate.size));
        const thirdScale = secondScale * Math.max(0.66, Math.min(0.86, secondRatio * 0.88));
        drawAt(thirdScale);
        candidate = await encode('image/webp', 0.68);
        if (candidate.type === 'image/webp' && candidate.size <= maxBytes) return candidate;
      }
    }

    if (candidate?.size > maxBytes) {
      throw new Error('No fue posible reducir la imagen al tamaño permitido. Elige una fotografía de menor resolución o recórtala e inténtalo de nuevo.');
    }
    if (SUPPORTED.has(candidate?.type) && candidate.size <= maxBytes) return candidate;
    throw new Error('Este navegador no pudo exportar la imagen en un formato compatible. Prueba con JPG o PNG.');
  } finally {
    decoded.close?.();
  }
}
