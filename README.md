# OGREF

アニメーション作業用の動画リファレンス管理ツール（単一HTML / Firebase Firestore / Google認証）。

## ファイル構成

| ファイル | 用途 | Firestoreデータ | 公開URL |
|---|---|---|---|
| `OGREF_Beta.html` | **本番**（他の人もアクセス） | `workspaces` 等（実データ） | https://ogshaw03.github.io/OGREF/OGREF_Beta.html |
| `OGREF_dev.html` | **開発用** | `dev_workspaces` 等（分離データ） | https://ogshaw03.github.io/OGREF/OGREF_dev.html |
| `OGREF_Canvas.html` | **自由配置版（PureRef風・開発中）**。OGREF_dev と**同じ dev データ**（ワークスペース/動画）を共有し、各動画の `canvas:{x,y,w,z}` 配置を別途保存して無限キャンバスに自由配置 | `dev_workspaces` 等（dev と共有） | https://ogshaw03.github.io/OGREF/OGREF_Canvas.html |
| `OGREF_admin.html` | **運営コンソール**（メンテナンス/お知らせ/アクセス管理） | `access_control` 等 | https://ogshaw03.github.io/OGREF/OGREF_admin.html |

- DB: Firebase Firestore（プロジェクト `animref-ef532` / `asia-northeast1`）
- 認証: Google（承認済みドメイン `ogshaw03.github.io`）

## データ分離

`OGREF_dev.html` は先頭の `DEV_MODE=true` により、`dev_` プレフィックス付きコレクション
（`dev_workspaces` / `dev_access_control` / `dev_users`）を使用する。
**本番データ（`workspaces` 等）には一切書き込まないため、開発中も他の利用者に影響しない。**
dev環境への初回ログインユーザーが自動的に管理者(admin)になる。

## 開発フロー

1. `OGREF_dev.html` を編集して開発・動作確認（dev_ データで安全に検証）
2. 確定したら同じ変更を `OGREF_Beta.html`（本番）へ反映
3. `main` に push → GitHub Pages へ自動公開

> ローカル確認は `python3 -m http.server` で起動し `http://localhost:8000/...` から開く
> （`file://` 直開きは Google ログイン不可）。

## バージョン

現在: `v0.0.4`（フォルダ多階層スキャン §10 / フォルダ階層ナビゲーション §11 実装）
