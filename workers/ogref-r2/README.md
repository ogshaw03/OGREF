# OGREF R2 backend Worker（dev）

OGREF に「端末から動画をアップロードして閲覧する」機能を足すための、Cloudflare Worker（署名役）です。
バケットは**非公開**にし、ブラウザは常に**短期の署名URL**経由でのみ R2 にアクセスします。

- `POST /sign-upload` … 署名付きアップロードURL（PUT）を発行
- `GET  /sign-view?key=...` … 署名付き視聴URL（GET・短期）を発行
- どちらも `Authorization: Bearer <Firebase IDトークン>` が必須（OGREFログインユーザーのみ）

> このWorkerは **dev 用**。Beta（本番）はベータテスト中のため対象外。

---

## セットアップ手順（初回）

### 1. Cloudflare アカウント & R2 有効化
1. https://dash.cloudflare.com でアカウント作成。
2. 左メニュー **R2** を開き、**Enable**（R2利用にはカード登録が必要。無料枠内なら課金なし）。

### 2. バケット作成
- **R2 → Create bucket** → 名前 `ogref-dev`（`wrangler.toml` の `R2_BUCKET` と一致させる）。
- 公開設定は**オフのまま**（非公開）。

### 3. R2 API トークン（S3）発行
- **R2 → Manage R2 API Tokens → Create API token**
- 権限: **Object Read & Write**、対象バケット: `ogref-dev`。
- 発行結果の **Access Key ID / Secret Access Key** を控える（Secretは再表示不可）。
- **Account ID** は R2 概要ページ右側に表示。`wrangler.toml` の `R2_ACCOUNT_ID` に記入。

### 4. wrangler 準備
```bash
cd workers/ogref-r2
npm install
npx wrangler login        # ブラウザで認証
```

### 5. 変数と秘密の設定
- `wrangler.toml` の `[vars]` を編集:
  - `R2_ACCOUNT_ID` … 手順3の Account ID
  - `R2_BUCKET` … `ogref-dev`
  - `PROJECT_ID` … `animref-ef532`（変更不要）
  - `ALLOWED_ORIGINS` … 配信元。GitHub Pages は `https://ogshaw03.github.io`
  - `MAX_UPLOAD_MB` … 1ファイル上限（初期 500）
- 秘密（コミットしない）:
```bash
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

### 6. バケットの CORS 設定
R2 → 対象バケット → **Settings → CORS policy** に以下を貼る（オリジンは自分の配信元に合わせる）:
```json
[
  {
    "AllowedOrigins": ["https://ogshaw03.github.io", "http://localhost:5500"],
    "AllowedMethods": ["GET", "PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

### 7. デプロイ
```bash
npx wrangler deploy
```
- 出力される URL（例 `https://ogref-r2.<subdomain>.workers.dev`）を控える。
- **この Worker URL を OGREF_dev 側の設定に入れる**とアップロード/再生が有効化されます（クライアント配線は別途対応）。

---

## 動作確認（任意・cURL）
`ID_TOKEN` は OGREF_dev のコンソールで `await firebase.auth().currentUser.getIdToken()` 等で取得。
```bash
# アップロードURL発行
curl -X POST "$WORKER_URL/sign-upload" \
  -H "Authorization: Bearer $ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"contentType":"video/mp4","size":1048576}'
```

## セキュリティメモ（MVPの範囲と今後）
- 現状の視聴認可は「**OGREFにログイン済みのユーザーなら誰でも** `uploads/` の署名URLを取得可能」。
  クローズドβでは十分だが、**ワークスペース単位の厳密な閲覧制御**（そのユーザーが該当WSのメンバーか）を Worker で
  Firestore 参照して検証するのは今後の強化項目。
- サイズ上限は `/sign-upload` の申告値で判定（署名URL自体はサイズを強制しない）。厳密化は S3 POST policy 等で今後対応可。
- 署名URLは短期（既定: アップロード10分 / 視聴60分）。視聴URLはタイル表示のたびに再取得する想定。
