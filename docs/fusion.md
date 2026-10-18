# Fusionアドオン

## インストール

```powershell
pnpm package:fusion
```

`artifacts/VirtualModelViewer-Fusion-0.1.0.zip`を展開してください。`VirtualModelViewer`フォルダの中に、同名のPythonファイルとmanifest、その他のPython・HTML・JSファイルがある状態を保ちます。

Fusionの「ユーティリティ → アドイン → スクリプトとアドイン → アドイン」で、追加ボタンから展開した`VirtualModelViewer`フォルダを指定し、実行します。必要なら起動時に実行する設定を有効にしてください。デザイン作業環境に「実寸AR」パネルとボタンが追加されます。

ソースフォルダをそのまま指定せず、配布ZIPを展開したフォルダを使用してください。ZIP作成時にBlenderと共通の通信クライアントを同梱します。

## 操作

1. 「実寸AR」を押し、パレットを開きます。
2. [Cloudflareセットアップ](deployment.md)で発行したHTTPS URLと管理用トークンを入力し、「設定を反映」を押します。
3. 「ARで確認（新規リンク）」を押し、ボディ・メッシュボディ・コンポーネントの配置インスタンスを選択します。ルートコンポーネントを選ぶと表示中の全体を送信します。
4. 上方向（標準はZ）とメッシュ精度を選び、幅・奥行き・高さ・容量を確認して送信します。Y上向きのデザインは「Y上向き」に切り替えます。
5. パレットに表示されるURL・QRコードからスマホやQuestで開きます。

「選択モデルで更新」は選択範囲を再送信し、同じURLの内容を置き換えます。期限は最終更新から24時間です。期限切れの場合は新規リンクを発行してください。「公開モデルを削除」は確認後にリンクを停止し、保存モデルを削除します。

## 保存と通信

配信先URLは`~/.virtualmodelviewer/fusion-settings.json`に保存します。管理用トークンはメモリだけに保持し、Fusion終了・アドオン停止時に破棄します。起動時の環境変数`VMV_UPLOAD_TOKEN`でも設定できます。トークンはデザイン属性に保存しません。

リンク・モデル寸法・期限は送信元のデザイン属性へ保存します。再起動後も使うにはFusionのデザインを保存してください。送信中に他のデザインへ切り替えても、結果を記録する先は元のデザインです。元のデザインを閉じた場合は、その旨とURLをステータスへ表示します。

形状の取得とデザインへの記録はFusionのメインスレッド、通信はバックグラウンドスレッドで行います。元のボディ、コンポーネント、配置、CAD履歴は変更しません。リンク属性の追加・削除はデザインの変更として扱われます。

## 対応範囲

- BRepのソリッド／サーフェスとメッシュボディ。
- 非表示要素を除いた、選択した配置インスタンスとその子孫。
- 同じコンポーネントの複数配置、入れ子の配置、重複選択の除外。
- Fusion API内部のcmからmへの変換、全体の底面中央への原点移動。
- ボディの代表的な基本色とメッシュ法線。

画像テクスチャ、面ごとの塗り分け、複雑な外観、アニメーション、スケッチだけの線やボリュームは対象外です。複雑な外観は近似色またはグレーで表示します。最大25MiBのため、大きすぎる場合は選択範囲やメッシュ精度を下げてください。

## 検証

```powershell
python -m unittest discover -s tests -p test_fusion.py
pnpm package:fusion
```

単位・座標・組立配置・法線・重複排除・リンク保存先はFusion APIの代替オブジェクトを使って自動テストしています。配布ZIP内のGLB生成・通信コードはローカルWorkerへの送信・更新・QR取得・削除まで確認しました。

Fusion本体でのインストール・パレット操作・実モデルのメッシュ取得は未検証です。スマホ・Questの実機AR確認も保留です。

実装の参照元：[Fusion APIの単位](https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/Units_UM.htm)、[メッシュ計算](https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/fusion_MeshManager_createMeshCalculator.htm)、[配置変換](https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/fusion_Occurrence_transform2.htm)、[HTMLパレット](https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/Palettes_UM.htm)。
