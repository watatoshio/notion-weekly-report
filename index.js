// index.js内のこの部分を修正
// ページIDにハイフンを追加するヘルパー関数を追加

// ハイフンなしのIDをハイフン付きに変換する関数
function formatNotionId(id) {
  if (!id || typeof id !== 'string') return id;
  
  // すでにハイフンが含まれている場合はそのまま返す
  if (id.includes('-')) return id;
  
  // 8-4-4-4-12 の形式にフォーマット
  return id.replace(
    /^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/,
    '$1-$2-$3-$4-$5'
  );
}

// 環境変数の設定
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_PAGE_ID = process.env.NOTION_PAGE_ID; // カンマ区切りの複数ページID
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// 週報を作成するページID - ハイフン付きフォーマットに修正
const WEEKLY_REPORT_PAGE_ID = formatNotionId('37380149ec3e47e99e8f533c3486ab89');

// 起動情報を表示
console.log(`Starting application with config:`);
console.log(`- PORT: ${PORT}`);
console.log(`- NOTION_PAGE_ID pages count: ${NOTION_PAGE_ID ? NOTION_PAGE_ID.split(',').length : 0}`);
console.log(`- WEEKLY_REPORT_PAGE_ID: ${WEEKLY_REPORT_PAGE_ID}`);

// メイン処理 - 複数ページ対応 (ここも修正)
async function getNotionUpdates() {
  // カンマ区切りのページIDを配列に変換し、各IDをハイフン付き形式に変換
  const pageIds = NOTION_PAGE_ID.split(',')
    .map(id => id.trim())
    .map(id => formatNotionId(id));
  
  let allUpdates = [];
  
  // 現在の日付を取得（処理開始時点）
  const currentDate = new Date();
  
  console.log(`Checking updates from ${lastCheckedDate.toISOString()} to ${currentDate.toISOString()}`);
  console.log(`Page IDs to check: ${pageIds.join(', ')}`);
  
  // 各ページを順番に処理
  for (const pageId of pageIds) {
    console.log(`Processing page: ${pageId}`);
    try {
      const updates = await explorePageStructure(pageId);
      console.log(`Found ${updates.length} updates in page ${pageId}`);
      allUpdates = [...allUpdates, ...updates];
    } catch (pageError) {
      console.error(`Error processing page ${pageId}:`, pageError);
    }
  }
  
  // 以下は変更なし...
}

// 追加: 接続確認と詳細なアクセスガイド用のエンドポイント
app.get('/setup-guide', (req, res) => {
  const integrationName = req.query.name || 'あなたのインテグレーション';
  
  res.send(`
    <html>
      <head>
        <title>Notion接続ガイド</title>
        <style>
          body { font-family: sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; line-height: 1.6; color: #333; }
          h1 { color: #5c6ac4; }
          h2 { color: #7c56dd; margin-top: 30px; }
          code { background: #f1f1f1; padding: 2px 4px; border-radius: 3px; }
          .step { margin-bottom: 25px; border-left: 4px solid #5c6ac4; padding-left: 15px; }
          .error { color: #e34c26; font-weight: bold; }
          .success { color: #2ea44f; font-weight: bold; }
          img { max-width: 100%; border: 1px solid #ddd; margin: 10px 0; }
        </style>
      </head>
      <body>
        <h1>Notionとの接続設定ガイド</h1>
        
        <div class="step">
          <h2>Step 1: 対象となるNotionページを開く</h2>
          <p>週報を保存したいページ（ID: <code>${WEEKLY_REPORT_PAGE_ID}</code>）をNotionで開きます。</p>
        </div>
        
        <div class="step">
          <h2>Step 2: インテグレーションを接続する</h2>
          <p>
            1. ページ右上の <strong>...</strong> (3点リーダー)をクリック<br>
            2. <strong>Connections</strong> または <strong>Add connections</strong> を選択<br>
            3. <strong>${integrationName}</strong> を検索してクリック<br>
            4. ダイアログが出たら「許可する」を選択
          </p>
        </div>
        
        <div class="step">
          <h2>Step 3: 権限を確認する</h2>
          <p>
            接続後、インテグレーションがページに表示されていることを確認してください。<br>
            これでインテグレーションがページにアクセスする権限が付与されました。
          </p>
        </div>
        
        <div class="step">
          <h2>Step 4: 接続テスト</h2>
          <p>
            <a href="/check-page" target="_blank">ページ接続テスト</a> にアクセスして、接続が正常に行われているか確認してください。<br>
            「✅ ページは正常にアクセスできます」と表示されれば成功です。
          </p>
        </div>
        
        <div class="step">
          <h2>Step 5: 週報生成を試す</h2>
          <p>
            設定が完了したら、<a href="/generate-report" target="_blank">週報生成</a> を実行してみてください。
          </p>
        </div>
        
        <p>
          <small>問題が解決しない場合は、Render.comのログを確認して詳細なエラーメッセージを確認してください。</small>
        </p>
      </body>
    </html>
  `);
});
