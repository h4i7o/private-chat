# Private Chat

Claude API を使う、上限 $25 固定のプライベートチャット。ログイン付き(最高権限者 + もう1人まで)。

- 送信前にトークン数と「使用 → 見込み → 最悪ケース」を%で表示
- 最悪ケースが残額を超える送信は止める(解除は最高権限者のみ)
- モデル: Sonnet 5.5 / Opus 5.5 / Fable 5.2、Effort は中で固定
- Web検索は送信ごとにON/OFF(1送信につき最大3回)
- 画像・PDF・テキストを添付でき、添付ごとのトークン数も送信前に表示
- Claude が出した HTML を、生成中からリアルタイムでプレビュー(隔離した iframe)
- 送信した発言は編集して送り直せる(鉛筆アイコン)。その発言以降の会話は置き換わり、見積もりは下の入力欄で同じように出る

構成: Cloudflare Workers(Hono)+ D1(SQLite)+ R2(添付)。ローカルでは Cloudflare のアカウント不要で、そのまま動く。

## 1. ローカルで動かす

必要なもの: **Node.js 20 以上**(`node -v` で確認。無ければ https://nodejs.org の LTS)。

```bash
cd private-chat
npm install
npm run setup      # .dev.vars の作成 + ローカルDBの用意
```

### まずは課金なしで確認(偽のAPIサーバー)

```bash
npm run dev:mock
```

http://localhost:8787 を開く。最初のアクセスで「最高権限者を作成」の画面になる。ユーザー名とパスワード(8文字以上)を決めて入る。
「HTMLを作って」と送ると、右側にプレビューが開く。応答は偽のサーバーが返すもので、課金は一切発生しない。

### 実APIにつなぐ

1. Claude Console で**このアプリ専用のワークスペース**を作り、ワークスペースの支出上限も $25 にする(アプリ側の上限とは別の二重の安全)。
2. そのワークスペースで API キーを発行する。
3. Web検索を使うなら、Console の設定で Web 検索を有効にする(組織管理者の操作。無効だと検索付きの送信が 400 になる)。
4. `.dev.vars` の `ANTHROPIC_API_KEY` を書き換える。
5. `npm run dev` を起動して http://localhost:8787 を開く。

### 確認用コマンド

```bash
npm run typecheck                         # 型チェック
npm run dev:mock  &  npm run smoke        # APIの通し確認(認証・見積もり・ストリーミング・停止・権限)
CAP_USD=0.02 npm run dev:mock  &  SMOKE=cap npm run smoke   # 上限とリミッターの確認
```

ローカルのデータを消して最初からやり直す: `rm -rf .wrangler/state && npm run db:migrate`

## 2. 上限 $25 を守る仕組み

金額は全て整数の nano-USD(1e-9 ドル)で管理し、誤差を出さない。

1. 送信直前に `count_tokens` で入力トークンを正確に数える。
2. 「最悪ケース」= 入力(全部キャッシュ書き込み価格)+ `max_tokens` を使い切った出力 + 検索の最大分、を計算する。
3. 台帳の累計 + 他の予約 + 最悪ケース が $25 以内のときだけ、D1 の1文(INSERT ... WHERE)で**原子的に予約**する。2人が同時に送っても超えない。
4. 超える場合は 402 で止める。最高権限者がリミッターを解除している間は、残額ぜんぶを予約し、`max_tokens` を残額に収まるまで**自動で絞って**送る。出力の上限は API 側が守るので、$25 を超えることはない。
5. 完了・停止・切断・エラーのいずれでも、実際の使用量(`usage`)で精算し、予約を解放する。予約は15分で自動失効するので、Worker が落ちても残額は固まらない。

注意点:
- 検索結果が入力に足される量は事前に確定できないため、1回あたり 20,000 トークンを予約している。これは上限の保証ではなく見積もり。
- 停止ボタンで切断した応答は、最後の usage が届かないので、見えているテキストから**多めに**見積もって課金する(見えない思考ぶんを上乗せ)。
- 添付は会話履歴に残り、毎ターン再送される(その分の入力も毎回課金)。同じ内容はキャッシュが効く。

## 3. 本番(Cloudflare)へのデプロイ

ローカルで実APIの確認ができてから。所要は 15〜20 分。

### 事前に
- Cloudflare アカウントを作る(https://dash.cloudflare.com/sign-up)。
- ダッシュボードの **R2 Object Storage** を開き、案内に従って R2 を有効にする(カード登録が必要。無料枠内なら課金なし)。
- **Workers の料金プラン**: ログインのパスワード照合(PBKDF2)は CPU を使うため、Free プランの CPU 制限(1リクエスト10ms)に当たる可能性がある。まず Free で試し、ログインで「Error 1102」が出たら **Workers Paid($5/月)** にする。

### 手順
```bash
npx wrangler login                              # ブラウザが開く。許可する
npx wrangler d1 create private-chat             # 出力の database_id をコピー
```
`wrangler.jsonc` の `database_id`(0000…の部分)を、コピーした値に書き換える。

```bash
npx wrangler r2 bucket create private-chat-files
npm run db:migrate:remote                       # 本番DBにテーブルを作る(確認で y)
npm run deploy                                  # 初回は workers.dev のサブドメイン登録を聞かれる
npx wrangler secret put ANTHROPIC_API_KEY       # 実APIキーを貼る(画面には表示されない)
```
デプロイの最後に出る `https://private-chat.<サブドメイン>.workers.dev` を開く。

### デプロイ直後にすること
1. **すぐ最高権限者を作る。** 最初にアクセスした人が最高権限者になる作りなので、デプロイしたらすぐ自分で開いて作成する。
2. 設定 → ユーザーで、もう1人を追加する(必要なら)。
3. 「HTMLを作って」を送って動作を確認し、Console の使用額と見比べる。

### 更新・運用
- コードを変えたら `npm run deploy` だけ。DBの定義を変えたときだけ `npm run db:migrate:remote` も。
- ログを見る: `npx wrangler tail`
- 上限額を変える: `wrangler.jsonc` の `CAP_USD` を変えて `npm run deploy`。
- 使用額をリセット: 設定 → 予算 →「使用額を0に」(最高権限者)。Console 側の月額上限は月初に自動でリセットされる。
- APIキーを替える: `npx wrangler secret put ANTHROPIC_API_KEY` をもう一度。
- 追加の防御(任意): Cloudflare Zero Trust の Access でこのURLを保護すると、ログイン画面の手前で自分のメールアドレスの確認が入る(無料枠あり)。

## 3.5 機能メモ

- **設定(最高権限者)**: 設定 → 予算 → 動作。Effort は「中に固定」(初期)か「低・中・高」を選択式に。権限は「手動」(初期。検索は送信ごとに自分で付ける)か「自動」(検索を常に付けて Claude が判断)。Web検索は最大回数(1〜20)か「制限なし」(内部では20回で打ち切り)。回数を増やすほど「最悪ケース」が大きくなり、残額が少ないと送信が止まる(上限を守るための仕様)。
- **パスキー**: 設定 → アカウント → パスキー。各ユーザーが自分で追加でき、Android / iPhone / PC で使える。ログイン画面の「パスキー」ボタンはユーザー名の入力が要らない。パスワードでのログインも残る。
  パスキーは**ドメインに結びつく**。`localhost` と本番の `*.workers.dev` は別物で、それぞれ登録する。ローカルで試すときは `127.0.0.1` ではなく `http://localhost:8787` を開く(IPアドレスは WebAuthn が受け付けない)。ドメインを変えたら登録し直し。
- **`/compact`**: 入力欄に `/compact`(続けて指示も書ける。例: `/compact コードの決定事項を残して`)。会話を要約して、以降は要約から続ける。元の発言は薄く残り、編集はできなくなる。要約は最後まで出きったときだけ反映される。
- **再生成**: 最後の応答の ↻ から。モデルを選び直せ、見積もりも出る。‹ 1/2 › で版を行き来できる。
- **リクエストID**: 各応答の `#` ボタンで Anthropic の request-id をコピー。Console のログと突き合わせられる。
- **プレビュー**: ダウンロード、HTMLの版の切り替え(会話内の複数のHTMLを行き来)、実行時エラーを拾って「修正を依頼」で Claude に送る。
- **チャット**: 検索(タイトルと本文)、ピン留め、名前の変更(ダブルクリックでも)、Markdown / JSON の書き出し。全会話は設定 → アカウントから JSON で保存。
- **予算の通知**: 50% と 80% に達したときに一度ずつ知らせる(リセットすると再び有効)。
- **ホーム画面に追加(PWA)**: Android は設定 → アカウントの追加ボタン、iPhone は Safari の共有 → ホーム画面に追加。

## 4. セキュリティの要点

- パスワードは PBKDF2-SHA256(10万回)で保存。セッションはランダムトークンで、DBにはハッシュのみ。Cookie は HttpOnly / SameSite=Strict。
- ログインは 15分で5回失敗するとロック。
- 状態を変える API は、同一オリジンと `x-pc` ヘッダを必須にして CSRF を防ぐ。
- 本体ページの CSP は `script-src 'self'`。Claude が出す HTML は `/preview` を `sandbox="allow-scripts"` の iframe で開き、親の Cookie に触れず、通信(`connect-src 'none'`)もできない。
- 他のユーザーのチャットは API が一切返さない。

## 5. ファイル構成

```
src/index.ts       ルート(認証・ユーザー・台帳・見積もり・送信SSE)
src/ledger.ts      予約と精算
src/pricing.ts     単価と最悪ケースの計算(単価は platform.claude.com の料金表が出典)
src/auth.ts        パスワードとセッション
src/config.ts      最高権限者の動作設定(Effort・権限・検索回数)
src/webauthn.ts    パスキーの検証(WebCrypto)
src/anthropic.ts   count_tokens とストリーミング
migrations/        D1 のスキーマ
public/            フロントエンド(index.html / app.css / app.js / preview.html / _headers / PWA用の manifest・sw.js・アイコン)
scripts/           setup, dev:mock, 偽API, スモークテスト
```

単価が変わったら `src/pricing.ts` の `MODELS` を更新する。


## 追加機能(第3弾)

- **思考の表示**: 考える過程の要約を折りたたみで表示(設定→予算→動作で オン/オフ)。表示の有無にかかわらず思考トークンは課金されます。
- **引用**: Web検索の根拠を本文中の番号で表示。番号を押すとそのページを開きます。
- **数式・図**: KaTeX と Mermaid を同梱(MIT)。必要になった時だけ読み込みます。Mermaid は約5.5MBです。
- **ファイルカード**: 添付はカードで表示し、押すと開きます。コードブロックは保存ボタンで拡張子つきファイルとして保存できます。
- **メモリ**: 入力欄の脳アイコンで送信ごとにオン/オフ(既定オン)。`/remember 内容` で追加、設定→メモリで編集・削除。メモリのトークンも見積もりに含まれます。
- **使用量の厳密化**: 使用量が取れなかった場合は多めに計上します。設定→予算の「Consoleの実額」(任意)は、管理用キーを設定したときだけ表示され、取得した額を確認のうえ反映できます(読み取りのみ・実APIでは未検証)。

### 更新手順
```
npm run db:migrate            # ローカル
npm run db:migrate:remote     # 本番(0003_memory)
npm run deploy
# 任意: npx wrangler secret put ANTHROPIC_ADMIN_KEY
```
ローカル開発と本番は別の台帳です。同じAPIキーを共用すると合計がずれるため、キーを分けるか Console 同期を使ってください。

## iPhone だけで更新する(GitHub + Cloudflare Workers Builds)

1. GitHub に非公開リポジトリを作り、プロジェクト一式を入れる。`wrangler.jsonc` の `database_id` は Cloudflare の D1 画面にある実際のIDに書き換えておく(この値は秘密ではない)。
2. Cloudflare ダッシュボード → Workers & Pages → `private-chat` → Settings → Builds → Connect。リポジトリとブランチ(main)を選び、ビルドコマンドは空、デプロイコマンドは `npx wrangler deploy` のまま保存。
3. 以降は GitHub に反映(push / Webで編集の Commit)するたびに自動でデプロイされる。結果は同じ画面の Builds で見られる。失敗したビルドは公開中の版を置き換えない。
4. APIキーなどのシークレットは Worker の Settings → Variables and Secrets に残ったまま。管理用キー(任意)もここの Add → Secret で `ANTHROPIC_ADMIN_KEY` として追加できる。
5. メモリの表は初回アクセス時に自動で作られるため、データベースの移行作業は不要。

## ファイルカード(AIが作ったコード・文書)
- AIが ```言語 file=名前.拡張子 の形で出したコードや文書は、返答の中でカードになります。カードを押すと右のパネルで開き(HTMLはライブプレビュー、Markdownは整形表示とコード切り替え、他はコード表示)、カード右のボタンやパネルの保存ボタンでファイルとして保存できます。
- 名前が付かなくても、HTML/SVG/Markdownが8行以上、その他が25行以上ならカードになります。短い断片は従来のコードブロックのままです。
