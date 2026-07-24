// OGREF R2 Worker — 1ファイル完結版（Cloudflareダッシュボードに貼り付け用）
// ライブラリ不要。ターミナル/Node.js不要でブラウザだけでデプロイできる。
//   - 認証: Firebase の REST（Identity Toolkit accounts:lookup）で IDトークンを検証
//   - 署名: AWS SigV4（クエリ署名）を WebCrypto で自前実装
// エンドポイント:
//   POST /sign-upload           … 署名付きアップロードURL(PUT)を発行
//   GET  /sign-view?key=...     … 署名付き視聴URL(GET・短期)を発行
// どちらも Authorization: Bearer <Firebase IDトークン> が必須。
//
// ダッシュボードの「Settings → Variables and Secrets」で以下を設定:
//   [プレーン変数] PROJECT_ID, R2_ACCOUNT_ID, R2_BUCKET, FIREBASE_API_KEY,
//                 ALLOWED_ORIGINS, MAX_UPLOAD_MB, UPLOAD_URL_TTL, VIEW_URL_TTL
//   [暗号化シークレット] R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY

const te = new TextEncoder();

function toHex(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}
async function sha256Hex(str) {
  return toHex(await crypto.subtle.digest('SHA-256', te.encode(str)));
}
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, te.encode(msg));
}
// RFC3986 準拠のエンコード（AWS署名用）
function encRfc3986(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
function encPath(key) {
  return key.split('/').map(encRfc3986).join('/');
}

// ---- CORS ----
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
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors } });
}
// 許可するキー: uploads/（旧） か (dev_)workspaces/…/videos/…（Firestore階層）。パストラバーサル禁止。
function keyOk(key) {
  return /^(uploads|dev_workspaces|workspaces)\//.test(key) && !key.includes('..');
}

// ---- Firebase IDトークン検証（REST）----
// 成功: { user }, 失敗: { error }（理由を返す＝デバッグしやすく）
async function verifyUser(idToken, apiKey) {
  if (!apiKey) return { error: 'FIREBASE_API_KEY 未設定' };
  let res;
  try {
    res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
  } catch (e) {
    return { error: 'lookup fetch失敗: ' + String((e && e.message) || e) };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = (data.error && data.error.message) || ('lookup HTTP ' + res.status);
    return { error: reason };
  }
  const u = data.users && data.users[0];
  return u ? { user: u } : { error: 'no user in lookup' };
}

// ---- SigV4 クエリ署名（R2 / S3 互換）----
async function presignR2(env, key, method, ttl) {
  const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const region = 'auto';
  const service = 's3';
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const canonicalUri = `/${env.R2_BUCKET}/${encPath(key)}`;
  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${env.R2_ACCESS_KEY_ID}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(ttl),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(params).sort()
    .map((k) => `${encRfc3986(k)}=${encRfc3986(params[k])}`).join('&');
  const canonicalRequest = [
    method, canonicalUri, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  const kDate = await hmac(te.encode('AWS4' + env.R2_SECRET_ACCESS_KEY), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = toHex(await hmac(kSigning, stringToSign));
  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

const EXT_BY_TYPE = {
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'video/x-matroska': 'mkv', 'video/x-m4v': 'm4v',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const cors = corsHeaders(origin, allowed);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const authz = request.headers.get('Authorization') || '';
    const token = authz.startsWith('Bearer ') ? authz.slice(7) : '';
    if (!token) return json({ error: 'missing token' }, 401, cors);
    const auth = await verifyUser(token, env.FIREBASE_API_KEY);
    if (!auth.user) return json({ error: 'auth: ' + (auth.error || 'invalid') }, 401, cors);
    const user = auth.user;

    try {
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
          key = `uploads/${user.localId}/${crypto.randomUUID()}.${ext}`;
        }
        const ttl = Number(env.UPLOAD_URL_TTL || 600);
        const uploadUrl = await presignR2(env, key, 'PUT', ttl);
        return json({ key, uploadUrl, expiresIn: ttl }, 200, cors);
      }
      if (request.method === 'GET' && url.pathname === '/sign-view') {
        const key = url.searchParams.get('key') || '';
        if (!keyOk(key)) return json({ error: 'bad key' }, 400, cors);
        const ttl = Number(env.VIEW_URL_TTL || 1800);
        const viewUrl = await presignR2(env, key, 'GET', ttl);
        return json({ url: viewUrl, expiresIn: ttl }, 200, cors);
      }
      // R2オブジェクト削除（動画削除時の孤児防止）。Worker→R2をサーバー側で実行。
      if (request.method === 'POST' && url.pathname === '/delete-object') {
        const body = await request.json().catch(() => ({}));
        const key = String(body.key || '');
        if (!keyOk(key)) return json({ error: 'bad key' }, 400, cors);
        const delUrl = await presignR2(env, key, 'DELETE', 120);
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
