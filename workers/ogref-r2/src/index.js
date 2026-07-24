// OGREF R2 backend Worker（dev）
// 役割:
//  - Firebase ID トークンで「OGREFのログインユーザー」を検証
//  - POST /sign-upload : R2 への署名付きアップロードURL（PUT）を発行
//  - GET  /sign-view   : R2 からの署名付き視聴URL（GET・短期）を発行
// バケットは「非公開」。ブラウザは常に短期の署名URL経由でのみアクセスする。
import { AwsClient } from 'aws4fetch';
import { importX509, jwtVerify } from 'jose';

// ---------- CORS ----------
function corsHeaders(origin, allowed) {
  const ok = allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : (allowed[0] || '*'),
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
// 許可するキー: uploads/（旧） か (dev_)workspaces/…（Firestore階層）。パストラバーサル禁止。
function keyOk(key) {
  return /^(uploads|dev_workspaces|workspaces)\//.test(key) && !key.includes('..');
}

// ---------- Firebase ID トークン検証 ----------
// Firebase の公開証明書（X.509, kid でキー）。max-age を尊重してキャッシュ。
const GOOGLE_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let certCache = { exp: 0, certs: null };
async function fetchCerts() {
  const now = Date.now();
  if (certCache.certs && now < certCache.exp) return certCache.certs;
  const res = await fetch(GOOGLE_CERTS_URL);
  if (!res.ok) throw new Error('certs fetch failed');
  const certs = await res.json();
  const cc = res.headers.get('cache-control') || '';
  const m = cc.match(/max-age=(\d+)/);
  const ttl = (m ? parseInt(m[1], 10) : 3600) * 1000;
  certCache = { exp: now + ttl, certs };
  return certs;
}
async function verifyIdToken(token, projectId) {
  const certs = await fetchCerts();
  const { payload } = await jwtVerify(
    token,
    async (header) => {
      const pem = certs[header.kid];
      if (!pem) throw new Error('unknown kid');
      return importX509(pem, 'RS256');
    },
    {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    }
  );
  if (!payload.sub) throw new Error('no sub');
  return payload; // sub = uid, email など
}

// ---------- R2 (S3 互換) 署名 ----------
function r2Client(env) {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });
}
function r2Endpoint(env, key) {
  return `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${encodeURIComponent(key).replace(/%2F/g, '/')}`;
}
async function presign(env, key, method, ttl) {
  const url = r2Endpoint(env, key) + `?X-Amz-Expires=${ttl}`;
  const signed = await r2Client(env).sign(new Request(url, { method }), { aws: { signQuery: true } });
  return signed.url;
}

const EXT_BY_TYPE = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/x-m4v': 'm4v',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const cors = corsHeaders(origin, allowed);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // 認証（全エンドポイント共通）
    const authz = request.headers.get('Authorization') || '';
    const token = authz.startsWith('Bearer ') ? authz.slice(7) : '';
    if (!token) return json({ error: 'missing token' }, 401, cors);
    let user;
    try {
      user = await verifyIdToken(token, env.PROJECT_ID);
    } catch (e) {
      return json({ error: 'invalid token' }, 401, cors);
    }

    try {
      // 署名付きアップロードURL発行
      if (request.method === 'POST' && url.pathname === '/sign-upload') {
        const body = await request.json().catch(() => ({}));
        const contentType = String(body.contentType || '');
        const size = Number(body.size || 0);
        if (!contentType.startsWith('video/')) return json({ error: 'video only' }, 400, cors);
        const maxBytes = Number(env.MAX_UPLOAD_MB || 500) * 1024 * 1024;
        if (!(size > 0) || size > maxBytes) return json({ error: 'size over limit', maxBytes }, 413, cors);
        let key = String(body.key || '');
        if (key) {
          // クライアント指定キー（Firestore階層に合わせる）: (dev_)workspaces/{wsId}/videos/{videoId}.ext
          if (!/^(dev_)?workspaces\/[A-Za-z0-9_-]+\/videos\/[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(key)) return json({ error: 'bad key' }, 400, cors);
        } else {
          const ext = EXT_BY_TYPE[contentType] || 'mp4';
          key = `uploads/${user.sub}/${crypto.randomUUID()}.${ext}`;
        }
        const ttl = Number(env.UPLOAD_URL_TTL || 600);
        const uploadUrl = await presign(env, key, 'PUT', ttl);
        return json({ key, uploadUrl, expiresIn: ttl }, 200, cors);
      }

      // 署名付き視聴URL発行
      if (request.method === 'GET' && url.pathname === '/sign-view') {
        const key = url.searchParams.get('key') || '';
        if (!keyOk(key)) return json({ error: 'bad key' }, 400, cors);
        const ttl = Number(env.VIEW_URL_TTL || 3600);
        const viewUrl = await presign(env, key, 'GET', ttl);
        return json({ url: viewUrl, expiresIn: ttl }, 200, cors);
      }

      // R2オブジェクト削除（動画削除時の孤児防止）
      if (request.method === 'POST' && url.pathname === '/delete-object') {
        const body = await request.json().catch(() => ({}));
        const key = String(body.key || '');
        if (!keyOk(key)) return json({ error: 'bad key' }, 400, cors);
        const delUrl = await presign(env, key, 'DELETE', 120);
        const r = await fetch(delUrl, { method: 'DELETE' });
        if ((r.status >= 200 && r.status < 300) || r.status === 404) return json({ ok: true }, 200, cors);
        return json({ error: 'delete failed ' + r.status }, 502, cors);
      }

      return json({ error: 'not found' }, 404, cors);
    } catch (e) {
      return json({ error: 'server error', detail: String((e && e.message) || e) }, 500, cors);
    }
  },
};
