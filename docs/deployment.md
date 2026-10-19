# Cloudflareへの配置

R2・クラウドD1を使わない一時公開は[PC配信の手順](local-sharing.md)を参照してください。以下はクラウドへの常時配置を選んだ場合の手順です。

## 自動セットアップ（推奨）

Node.js 24とpnpm 11を使い、次を実行します。

```powershell
pnpm install --frozen-lockfile
pnpm setup:cloudflare --dry-run
pnpm setup:cloudflare
```

`--dry-run`は計画の表示だけを行い、通信・認証・ファイル変更は行いません。通常実行はCloudflareログイン、アカウント選択、D1・R2の準備、DBマイグレーション、ビルド・公開、アップロード用トークン設定、HTTPSページの疎通確認を順に行います。既存のD1・R2は同名なら再利用します。すでに公開されているR2や、このコマンドが管理していない同名Workerは上書きせず停止します。

Cloudflareのアカウント作成、R2の有効化・契約、Workersの初回サブドメイン設定はDashboardで済ませてください。リソースの作成・公開は利用料金の対象になり得ます。

CIなど対話できない環境では、CloudflareのAPIトークンとアカウントIDを環境変数`CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID`で渡します。権限は対象アカウントのWorkers Scripts編集、Workers R2 Storage編集、D1編集を用意し、アカウントを自動列挙する場合はAccount Settings読み取りも必要です。既存のWrangler OAuthログインも利用できます。

```powershell
pnpm setup:cloudflare --name my-model-viewer --account-id <32桁のアカウントID>
```

生成物はGit管理から除外しています。

- `wrangler.production.json`：本番用のアカウントID・DB ID・バケット名。元の`wrangler.jsonc`は変更しません。
- `.vmv/upload-token.txt`：Blender・Fusionに設定する管理用トークン。
- `.vmv/cloudflare.json`：再開用の情報。トークンを含むため他人に共有しないでください。

途中で失敗した場合は、原因を直して同じコマンドを再実行します。既存のリソースとトークンを再利用し、モデルを削除したりトークンを自動変更したりしません。強制終了で`.vmv/setup.lock`が残った場合は、他に実行中のセットアップがないことを確認してからそのファイルだけ削除してください。

通常の更新も`pnpm setup:cloudflare`で行えます。コードだけの更新には`pnpm deploy:production`を使えます。手動でトークンを変更した場合は`.vmv`の保存情報と一致するよう管理してください。本番への実際の作成・公開はモックテストとは別の確認が必要です。

## 初回設定

以下は自動セットアップを使わない場合の手順です。

CloudflareアカウントでWorkers・R2・D1を利用できることを確認してください。契約と利用量に応じて料金が発生するため、アカウント側で利用状況を管理してください。

```powershell
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm exec wrangler r2 bucket create virtual-model-viewer
pnpm exec wrangler d1 create virtual-model-viewer
```

`wrangler.jsonc`の`database_id`を、作成結果に表示されるIDに置き換えてください。バケット名・DB名を変更した場合は同じファイルに反映します。R2の公開URLは有効にしません。

```powershell
pnpm db:remote
pnpm exec wrangler secret put UPLOAD_TOKEN
pnpm deploy
```

`secret put`の入力欄に、32文字以上のランダムな管理用トークンを入力します。作成には例えば次を使えます。

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

同じトークンをBlenderのアドオン設定へ入力します。トークンをソースや`wrangler.jsonc`へ書き込まないでください。漏えい時は`secret put UPLOAD_TOKEN`で置き換え、アドオン側も更新してください。

デプロイ結果の`https://virtual-model-viewer.<account>.workers.dev`をアドオンの配信先に設定します。末尾に`/api`などのパスは付けません。独自ドメインを使う場合も、ビューアとAPIを同じHTTPSオリジンに配置してください。

## 更新と確認

```powershell
pnpm check
pnpm test
pnpm build
pnpm exec wrangler deploy --dry-run
pnpm deploy
```

DB変更を含む更新では、対応するマイグレーションを追加して`pnpm db:remote`を実行します。既存DBのテーブル削除・作り直しは不要です。

公開後は100mmと1mの基準モデルを送り、各実機で[確認表](verification.md)を実施してください。QRコードにはHTTPSの本番URLが入ることを確認します。

Cloudflare DashboardでCron Triggerが15分間隔で登録されていること、Scheduled呼び出しが成功していること、Workerのエラー数・R2の使用量を確認してください。独自のアクセスログを追加する場合、閲覧URLと管理用トークンを記録しないでください。

## ローカルでの削除処理確認

ローカルではCronは自動実行されません。`pnpm serve`を起動した状態で、WranglerのローカルScheduledエンドポイントを呼び出せます。

```powershell
Invoke-WebRequest -Method Post 'http://127.0.0.1:8797/cdn-cgi/local/explorer/api/local/scheduled?worker=virtual-model-viewer'
```

自動テストは別の一時D1・R2を使うため、ローカル開発用モデルや本番モデルを変更しません。
