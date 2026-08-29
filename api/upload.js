import { put } from '@vercel/blob';

const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX = 2 * 1024 * 1024;

export async function POST(request) {
  const contentType = (request.headers.get('content-type') || '').split(';')[0].trim();
  if (!ALLOWED.has(contentType)) {
    return Response.json({ error: 'png, jpeg, webp, or gif' }, { status: 400 });
  }
  const buf = Buffer.from(await request.arrayBuffer());
  if (buf.length === 0 || buf.length > MAX) {
    return Response.json({ error: 'empty or over 2MB' }, { status: 400 });
  }
  const rawName = request.headers.get('x-filename') || 'token';
  const safe = rawName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'token';
  const blob = await put(`tokens/${safe}`, buf, {
    access: 'public',
    addRandomSuffix: true,
    contentType,
  });
  return Response.json({ url: blob.url });
}
