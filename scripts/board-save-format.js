'use strict';

function boardHeaderPrefix(core, preview) {
  const header = preview ? { preview, ...core } : { ...core };
  const encoded = JSON.stringify(header);
  if (!encoded.endsWith('}')) throw new Error('Invalid board header');
  return encoded.slice(0, -1) + ',"images":[';
}

function boardImageParts(image, data) {
  const type = /^(?:image|audio|video)\/[a-z0-9.+-]+$/i.test(String(image?.type || ''))
    ? String(image.type)
    : 'application/octet-stream';
  const bytes = Buffer.isBuffer(data)
    ? data
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : ArrayBuffer.isView(data)
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : null;
  if (!bytes) throw new TypeError('Invalid streamed board image data');
  const meta = JSON.stringify({
    id: String(image?.id || ''),
    type,
    name: String(image?.name || ''),
    w: Math.max(0, Math.round(Number(image?.w) || 0)),
    h: Math.max(0, Math.round(Number(image?.h) || 0)),
    size: Math.max(0, Math.round(Number(image?.size) || bytes.length)),
  });
  return {
    prefix: meta.slice(0, -1) + `,"data":"data:${type};base64,`,
    base64: bytes.toString('base64'),
    suffix: '"}',
  };
}

module.exports = { boardHeaderPrefix, boardImageParts };
