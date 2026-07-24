# OGREF R2 backend Worker（dev）

OGREF に「端末から動画をアップロードして閲覧する」機能を足すための、Cloudflare Worker（署名役）です。
バケットは**非公開**にし、ブラウザは常に**短期の署名URL**経由でのみ R2 にアクセスします。

- `POST /sign-upload` … 署名付きアップロードURL（PUT）を発行
- `GET  /sign-view?key=...` … 署名付き視聴URL（GET・短期）を発行
- どちらも `Authorization: Bearer <Firebase IDトークン>` が必須（OGREFログインユーザーのみ）

> このWorkerは **dev 用**。Beta（本番）はベータテスト中のため対象外。

---

## 【推奨・簡単】ブラウザだけでデプロイ（Node.js/ターミナル不要）

`standalone-worker.js` は**ライブラリ不要の1ファイル完結版**です。Cloudflareダッシュボードに貼り付けるだけでデプロイできます。

### 手順
1. **バケット作成**：R2 → Create bucket → `ogref-projects`（非公開のまま）。
2. **CORS設定**：R2 → `ogref-projects` → CORSポリシー → 追加 に、下記「CORS設定」のJSONを貼る。
3. **APIトークン発行**：R2 → アカウント詳細の「APIトークン → 管理」→ **Account API トークンを作成** →
   権限 **Object Read & Write** / 対象 `ogref-projects` → 作成 → **Access Key ID** と **Secret Access Key** を控える。
4. **Worker作成**：ダッシュボード左「Workers & Pages」→ **Create application → Create Worker** →
   名前 `ogref-r2` → **Deploy**（最初は雛形のままでOK）。
5. **コードを貼り付け**：作成した Worker の **「Edit code（< > 編集）」** を開き、中身を全消去して
   `standalone-worker.js` の内容を丸ごと貼り付け → **Deploy**。
6. **変数を設定**：その Worker の **Settings → Variables and Secrets** で以下を登録 → Deploy/Save。

   **プレーン変数（Text）**
   | 名前 | 値 |
   |---|---|
   | `PROJECT_ID` | `animref-ef532` |
   | `R2_ACCOUNT_ID` | `5006e4f3903e5857dd54aa6cda9aa183` |
   | `R2_BUCKET` | `ogref-projects` |
   | `FIREBASE_API_KEY` | `AIzaSyASqL2Qp8sGrkzHz7J_HhE6QXntAZOO7RE` |
   | `ALLOWED_ORIGINS` | `https://ogshaw03.github.io,http://localhost:5500` |
   | `MAX_UPLOAD_MB` | `500` |
   | `UPLOAD_URL_TTL` | `600` |
   | `VIEW_URL_TTL` | `1800` |

   **暗号化シークレット（Encrypt）**
   | 名前 | 値 |
   |---|---|
   | `R2_ACCESS_KEY_ID` | 手順3の Access Key ID |
   | `R2_SECRET_ACCESS_KEY` | 手順3の Secret Access Key |

7. Worker のページ上部に出る **URL**（`https://ogref-r2.<サブドメイン>.workers.dev`）を控える。
   - 初回は「workers.dev のサブドメインを作成」を求められたら作成する。

> `FIREBASE_API_KEY` はクライアントに元々埋め込まれている**公開値**なので秘密ではありません。
> R2の Access Key / Secret だけが秘密です（必ず「Encrypt」で登録）。

---

## 【上級・CLI版】wrangler でデプロイ（Node.js が必要）

`src/index.js`（npm版：jose・aws4fetch使用）を使う場合の手順です。ブラウザだけで済ませたい場合は上の【推奨】でOK。

### セットアップ手順（初回）

### 1. Cloudflare アカウント & R2 有効化
1. https://dash.cloudflare.com でアカウント作成。
2. 左メニュー **R2** を開き、**Enable**（R2利用にはカード登録が必要。無料枠内なら課金なし）。

### 2. バケット作成
- **R2 → Create bucket** → 名前 `ogref-projects`（`wrangler.toml` の `R2_BUCKET` と一致させる）。
  - ※バケット名は**小文字英数字とハイフンのみ・3〜63文字**（アンダースコア不可）。
- 公開設定は**オフのまま**（非公開）。

### 3. R2 API トークン（S3）発行
- **R2 → Manage R2 API Tokens → Create API token**
- 権限: **Object Read & Write**、対象バケット: `ogref-projects`。
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
  - `R2_BUCKET` … `ogref-projects`
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
