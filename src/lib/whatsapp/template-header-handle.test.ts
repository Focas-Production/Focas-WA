import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the Meta resumable upload so the helper is tested in isolation.
vi.mock('./meta-api', () => ({
  uploadResumableMedia: vi.fn(async () => ({ handle: 'HANDLE123' })),
}));

import { ensureImageHeaderHandle, ensureMediaHeaderHandle } from './template-header-handle';
import { uploadResumableMedia } from './meta-api';
import type { TemplatePayload } from './template-validators';

function payload(over: Partial<TemplatePayload> = {}): TemplatePayload {
  return {
    name: 't',
    category: 'Utility',
    language: 'en_US',
    body_text: 'hi',
    header_type: 'image',
    header_media_url: 'https://x.test/img.jpg',
    ...over,
  };
}

function imgResponse(type = 'image/jpeg', size = 1024, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? type : null) },
    arrayBuffer: async () => new ArrayBuffer(size),
  } as unknown as Response;
}

describe('ensureImageHeaderHandle', () => {
  beforeEach(() => {
    vi.mocked(uploadResumableMedia).mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('is a no-op for non-image headers', async () => {
    const p = payload({ header_type: 'text', header_content: 'Hi' });
    await ensureImageHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).not.toHaveBeenCalled();
    expect(p.header_handle).toBeUndefined();
  });

  it('is a no-op when a handle already exists', async () => {
    const p = payload({ header_handle: 'existing' });
    await ensureImageHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).not.toHaveBeenCalled();
    expect(p.header_handle).toBe('existing');
  });

  it('throws an actionable error when META_APP_ID is unset', async () => {
    const p = payload();
    await expect(ensureImageHeaderHandle(p, 'tok')).rejects.toThrow(/META_APP_ID/);
  });

  it('derives + sets header_handle from a valid image URL', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse('image/jpeg', 2048)));
    const p = payload();
    await ensureImageHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).toHaveBeenCalledOnce();
    expect(p.header_handle).toBe('HANDLE123');
  });

  it('rejects a non-image content type', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse('text/html')));
    await expect(ensureImageHeaderHandle(payload(), 'tok')).rejects.toThrow(/JPEG or PNG/);
  });

  it('rejects an image over 5 MB', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse('image/png', 6 * 1024 * 1024)));
    await expect(ensureImageHeaderHandle(payload(), 'tok')).rejects.toThrow(/5 MB/);
  });
});

function fileResponse(type: string, bytes: Uint8Array, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? type : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}
const pdfBytes = new TextEncoder().encode('%PDF-1.7 sample');

describe('ensureMediaHeaderHandle — document', () => {
  beforeEach(() => vi.mocked(uploadResumableMedia).mockClear());
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  const doc = (over: Partial<TemplatePayload> = {}) =>
    payload({ header_type: 'document', header_media_url: 'https://x.test/s.pdf', ...over });

  it('uploads a PDF sample and sets header_handle', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => fileResponse('application/pdf', pdfBytes)));
    const p = doc();
    await ensureMediaHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'application/pdf', fileName: 'sample.pdf' }));
    expect(p.header_handle).toBe('HANDLE123');
  });

  it('accepts a PDF served as octet-stream', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => fileResponse('application/octet-stream', pdfBytes)));
    const p = doc();
    await ensureMediaHeaderHandle(p, 'tok');
    expect(p.header_handle).toBe('HANDLE123');
  });

  it('rejects a link that returns HTML instead of a PDF', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => fileResponse('text/html', new TextEncoder().encode('<html>'))));
    await expect(ensureMediaHeaderHandle(doc(), 'tok')).rejects.toThrow(/must be a PDF/);
    expect(uploadResumableMedia).not.toHaveBeenCalled();
  });

  it('old name still works', () => {
    expect(ensureImageHeaderHandle).toBe(ensureMediaHeaderHandle);
  });
});

