# VirtualModelViewer

Blender・Fusionで選んだモデルを、スマホやQuestで実寸表示するアドオンです。モデルを一時アップロードし、共通のURL・QRコードから開きます。

- iPhone：Safari → AR Quick Look（USDZをブラウザ内で生成）
- Android：AR対応端末のChrome → Scene Viewer
- Quest 3 / 3S：Quest Browser → WebXRパススルー
- 最終更新から24時間有効。同じURLで更新でき、手動削除も可能です。

Blender・Fusionの両方から同じ配信APIを利用できます。Quest Linkと編集中の自動同期は後続の対象です。

## セットアップ

Node.js 24 LTS、pnpm 11、Python 3、Blender 4.5以降を想定しています。Python依存パッケージは不要です。

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm package:addon
pnpm package:fusion
```

Cloudflareの初回設定は`pnpm setup:cloudflare`で案内・作成・公開まで進められます。先に`pnpm setup:cloudflare --dry-run`で処理内容を確認できます。[配信基盤の導入手順](docs/deployment.md)を参照してください。Workers・非公開R2・D1を使用します。

### ローカル開発

`.dev.vars.example`を`.dev.vars`にコピーし、`UPLOAD_TOKEN`を32文字以上のランダムな値に置き換えます。このファイルはGit管理されません。

```powershell
pnpm db:local
pnpm build
pnpm serve
```

`http://127.0.0.1:8797`で起動します。画面開発時は別ターミナルで`pnpm dev`を起動し、Viteが表示したURLを開いてください。APIは8797番へ転送されます。

このローカルURLはPCの動作確認用です。スマホ・Questの実機確認には、インターネットから到達できる本番のHTTPS URLを使ってください。

### Blenderへのインストール

1. `pnpm package:addon`で`artifacts/virtual_model_viewer-0.1.0.zip`を作成。
2. Blenderの「プリファレンス → アドオン → ディスクからインストール」でZIPを選び、有効化。
3. アドオン設定の「配信先URL」にWorkersのHTTPS URL、「管理用トークン」にサーバーと同じ値を入力。
4. オブジェクトモードで対象を選び、3Dビューのサイドバー（Nキー）→「実寸AR」→「ARで確認」。送信前の寸法を確認。
5. スマホでQRコードを読み取るか、Quest BrowserでURLを開き、「実寸で配置」。

管理用トークンはBlenderの設定ファイルや`.blend`に保存しません。起動ごとに入力するか、Blenderの起動環境に`VMV_UPLOAD_TOKEN`を設定してください。リンク・寸法・期限はシーンに保持されるため、再起動後も使う場合は`.blend`を保存してください。

「更新」は選択中のモデルで既存リンクの内容を置き換えます。端末側でAR画面を閉じ、「最新のモデルを読み込む」を押してから再配置してください。期限切れリンクは更新できないため、新規リンクを発行してください。

### Fusionへのインストール

`pnpm package:fusion`で作成した`artifacts/VirtualModelViewer-Fusion-0.1.0.zip`を展開し、Fusionの「スクリプトとアドイン」から`VirtualModelViewer`フォルダを追加・実行します。「実寸AR」パレットで配信先とトークンを設定し、ボディ・コンポーネントを選択して送信できます。[Fusionの導入・操作手順](docs/fusion.md)を参照してください。

## 実寸とモデルの扱い

- Blenderのシーン単位、評価後の形状、ワールド変換を反映してメートルへ正規化します。単位未設定は1 Blender単位＝1mです。
- 選択した表示中のモデルをまとめ、全体の底面中央を配置原点にします。元シーン・選択・変換を変更せず、一時シーンで書き出します。
- 形状、glTFで表現できる基本マテリアル・画像テクスチャを対象にします。複雑なシェーダーのベイク、アニメーション、ボリューム、線だけの形状は対象外です。
- アップロード上限は25MiB。圧縮なしの、画像等を埋め込んだGLB 2.0を使用します。外部リソースURLを含むGLBは拒否します。
- AR表示では倍率を100%固定にします。画面上の3Dプレビューでは確認のためカメラをズームできます。
- Questはコントローラーのトリガーで配置・移動、グリップで15°回転、スティック左右で回転、B／Yで終了。配置面は床、または入力した床からの高さです。机を自動検出する方式ではありません。

FusionではAPI内部のcmをmへ変換し、配置インスタンスの変換を反映します。Fusion版の初期対応はボディの基本色までで、画像テクスチャや面ごとの塗り分けは対象外です。

ARの追跡には誤差があるため、寸法の数値一致と物理空間での見え方は分けて検証してください。

## テスト

```powershell
pnpm check
pnpm test
python -m unittest discover -s tests -p 'test_*.py'
blender --background --factory-startup --python-exit-code 1 --python tests/blender_export.py
pnpm exec wrangler deploy --dry-run
```

検証結果と実機の確認手順は [検証状況](docs/verification.md)、Fusion等から利用できるAPIは [API仕様](docs/api.md) を参照してください。

## 共有と削除

閲覧者のログインはありません。URLを知る人は、有効期限内に閲覧・ダウンロードできます。R2バケットは非公開にし、モデル取得は期限を確認するWorker経由で行います。

期限切れはAPIで直ちに拒否し、15分ごとの定期処理で削除します。旧版や失敗したアップロードの回収には1時間の猶予があります。手動削除ではリンクを先に停止し、保存済みモデルを削除します。すでに端末にダウンロードされたモデルを遠隔で消すことはできません。
