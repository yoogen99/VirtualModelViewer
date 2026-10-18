# Cloudflareへの配置

## 初回設定

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
