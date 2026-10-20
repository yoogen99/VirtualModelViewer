# PCから一時公開する

モデルと管理情報はPCの`.vmv/local/`に保存します。Cloudflare Quick TunnelはHTTPS通信の中継に使います。クラウドのR2・D1、Cloudflareログイン、独自ドメインは不要です。

スマホ・QuestはPCと同じWi-Fiに接続する必要はありません。双方にインターネット接続があれば、モバイル回線や別のWi-Fiからも公開URLを開けます。ルーターのポート開放は不要です。

## 起動

Node.js 24、pnpm 11を用意し、リポジトリで実行します。

```powershell
pnpm install --frozen-lockfile
pnpm share
```

Windowsで画面を閉じても配信を続けたい場合は、初回に`pnpm build`を済ませ、リポジトリ直下の`Start-PC-Sharing.cmd`をダブルクリックします。配信はバックグラウンドで続き、停止は`Stop-PC-Sharing.cmd`から行えます。`pnpm share`は実行したターミナルを開いたまま使う方法です。

Node.jsを通常の場所にインストールしていない場合は、初回のみ次を実行します。指定した実行ファイルの場所はPC内に記録するため、次回からダブルクリックで起動できます。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/start-local.ps1 -NodePath "C:\path\to\node.exe"
```

初回は公式GitHubのCloudflare配布元から`cloudflared`を取得し、固定バージョンのSHA-256を照合します。自動導入はWindows x64に対応しています。ほかの環境では公式の実行ファイルを用意し、`VMV_CLOUDFLARED`環境変数に絶対パスを指定してください。

起動すると`https://….trycloudflare.com`と、PC内の`connection.json`のパスを表示します。PCの電源とネット接続を維持し、配信を起動したまま使います。スリープ中もアクセスできません。

## Blenderの設定

1. 最新のアドオンZIPをインストール・有効化します。
2. アドオン設定の「PC配信設定ファイル」に、表示された`.vmv/local/connection.json`を指定します。
3. 設定を保存し、選択したモデルを「実寸AR」パネルの「ARで確認」で送信します。
4. スマホでQRコード、またはQuest Browserでリンクを開きます。

PC配信設定ファイルを指定すると、配信先と管理用トークンを送信のたびにPC内から読み込みます。Blenderを再起動してもトークンの手入力は不要です。ファイルパスのみBlenderに保存し、トークンは`.blend`やBlenderの設定に保存しません。手動の接続設定に戻すには、このファイル欄を空にします。

Fusionでは表示された公開URLと`.vmv/local/upload-token.txt`の内容をパレットに入力します。Fusionのトークンはメモリ内のみで保持します。接続設定ファイルの自動読み込みはBlender版の対応です。

## 停止・再起動

起動した画面でCtrl+Cを押すか、別の画面で次を実行します。

バックグラウンドで起動した場合は`Stop-PC-Sharing.cmd`をダブルクリックしてください。

```powershell
pnpm share:stop
```

停止すると公開URLはアクセス不可になり、接続設定ファイルも削除されます。保存済みモデルはPC内に残ります。配信を起動し直すと公開URLのホスト名が変わるため、Blenderから新規リンクを発行してください。配信中の「更新」では同じURLを維持します。

モデルは最終更新から24時間で閲覧不可になります。配信中は15分ごとと起動時に期限切れデータを回収します。旧版や失敗した送信の回収には1時間の猶予があります。配信停止中は削除処理も停止します。停止中に期限を過ぎたモデルは、再起動後も閲覧できません。

異常終了で起動できない場合は、配信プロセスが残っていないことを確認してから`.vmv/local/session.lock`だけを削除します。既存のCloudflareログイン設定やトンネル設定は変更しません。

## 公開範囲

公開するのは閲覧ページ・表示用ファイル・モデルAPIのみです。PCのほかのフォルダ、開発用の管理画面、保存用トークンファイルは公開しません。送信・更新・削除には管理用トークンが必要です。URLを知る人は期限内のモデルを閲覧・ダウンロードできます。

`.vmv/`はGitの対象外です。トークンファイルは共有しないでください。通信はCloudflareを経由します。

Quick Tunnelは試用・開発向けで稼働保証がありません。一時的な少人数の確認に使用し、固定URLで常時運用する場合は別途構成を変更します。[公式の説明](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
