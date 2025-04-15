// サーバー起動 - 明示的にIPを指定して起動
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is listening on http://0.0.0.0:${PORT}`);
  console.log(`Scheduled for Fridays at 19:00 JST`);
  
  // 起動時にPageの存在確認
  console.log('Checking destination page on startup...');
  checkPageExists(WEEKLY_REPORT_PAGE_ID).then(exists => {
    if (exists) {
      console.log('✅ Report destination page is accessible');
    } else {
      console.error('⚠️ WARNING: Report destination page is NOT accessible');
    }
  });
});

// プロセス終了時の処理
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
  });
});// index.js
require('dotenv').config();
const express = require('express');
const { Client } = require('@notionhq/client');
const { Configuration, OpenAIApi } = require('openai');
const cron = require('node-cron');

// Webアプリの設定 - 重要: expressアプリを先に初期化
const app = express();

// CORSの設定
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

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
const NOTION_PAGE_ID = process.env.NOTION_PAGE_ID || '016b7ee1-4192-49cd-bea4-04522214f2d1,8620f694-c929-4e28-a1fc-23741ac82372,54608237-b872-4bf0-a2fd-9c66fd10c1c3';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// 週報を作成するページID - 環境変数から取得、なければデフォルト値を使用
const WEEKLY_REPORT_PAGE_ID = process.env.WEEKLY_REPORT_PAGE_ID ? formatNotionId(process.env.WEEKLY_REPORT_PAGE_ID) : '37380149-ec3e-47e9-9e8f-533c3486ab89';
// ポート設定（Renderで重要）
const PORT = process.env.PORT || 3000;

// 起動情報を表示
console.log(`Starting application with config:`);
console.log(`- PORT: ${PORT}`);
console.log(`- NOTION_PAGE_ID pages count: ${NOTION_PAGE_ID ? NOTION_PAGE_ID.split(',').length : 0}`);
console.log(`- WEEKLY_REPORT_PAGE_ID: ${WEEKLY_REPORT_PAGE_ID}`);

// Notionクライアントの初期化
const notion = new Client({ auth: NOTION_API_KEY });

// OpenAI設定
const configuration = new Configuration({
  apiKey: OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

// 最終チェック日を保存する変数 (初期値: 1週間前)
let lastCheckedDate = new Date();
lastCheckedDate.setDate(lastCheckedDate.getDate() - 7);

// Notionの更新を取得する関数 - ページ階層探索バージョン
async function explorePageStructure(pageId, depth = 0, maxDepth = 2) {
  if (depth > maxDepth) return []; // 無限ループ防止
  
  try {
    console.log(`Exploring page: ${pageId} at depth ${depth}`);
    
    // ページの情報を取得
    const pageInfo = await notion.pages.retrieve({ page_id: pageId });
    const lastEditedTime = new Date(pageInfo.last_edited_time);
    
    // ページのブロック（内容）を取得
    const blocks = await notion.blocks.children.list({ 
      block_id: pageId,
      page_size: 100 // 最大100ブロックを取得
    });
    
    let updates = [];
    
    // 最終チェック日以降に更新されていれば記録
    if (lastEditedTime > lastCheckedDate) {
      console.log(`Page ${pageId} was updated after ${lastCheckedDate.toISOString()}`);
      
      // ページの内容をテキスト化
      const pageContent = [];
      for (const block of blocks.results) {
        try {
          if (block.type === 'paragraph' && block.paragraph.rich_text.length > 0) {
            pageContent.push(block.paragraph.rich_text[0].plain_text);
          } else if (block.type === 'heading_1' && block.heading_1.rich_text.length > 0) {
            pageContent.push('# ' + block.heading_1.rich_text[0].plain_text);
          } else if (block.type === 'heading_2' && block.heading_2.rich_text.length > 0) {
            pageContent.push('## ' + block.heading_2.rich_text[0].plain_text);
          } else if (block.type === 'heading_3' && block.heading_3.rich_text.length > 0) {
            pageContent.push('### ' + block.heading_3.rich_text[0].plain_text);
          } else if (block.type === 'bulleted_list_item' && block.bulleted_list_item.rich_text.length > 0) {
            pageContent.push('• ' + block.bulleted_list_item.rich_text[0].plain_text);
          } else if (block.type === 'numbered_list_item' && block.numbered_list_item.rich_text.length > 0) {
            pageContent.push('1. ' + block.numbered_list_item.rich_text[0].plain_text);
          } else if (block.type === 'to_do' && block.to_do.rich_text.length > 0) {
            pageContent.push(`[${block.to_do.checked ? 'x' : ' '}] ` + block.to_do.rich_text[0].plain_text);
          }
        } catch (blockError) {
          console.error(`Error processing block in page ${pageId}:`, blockError);
        }
      }
      
      // タイトルの取得
      let title = "Untitled";
      try {
        if (pageInfo.properties && pageInfo.properties.title) {
          const titleProp = pageInfo.properties.title;
          if (titleProp.title && titleProp.title.length > 0) {
            title = titleProp.title[0].plain_text;
          }
        }
      } catch (titleError) {
        console.error(`Error getting title for page ${pageId}:`, titleError);
      }
      
      updates.push({
        pageId,
        title: title,
        lastEditedTime: pageInfo.last_edited_time,
        content: pageContent.join('\n')
      });
    }
    
    // 子ページや子データベースを探索
    for (const block of blocks.results) {
      if (block.type === 'child_page') {
        // 子ページの場合は再帰的に探索
        try {
          const childUpdates = await explorePageStructure(block.id, depth + 1, maxDepth);
          updates = [...updates, ...childUpdates];
        } catch (childError) {
          console.error(`Error exploring child page ${block.id}:`, childError);
        }
      }
    }
    
    return updates;
  } catch (error) {
    console.error(`Error exploring page ${pageId}:`, error);
    return [];
  }
}

// メイン処理 - 複数ページ対応
async function getNotionUpdates() {
  // カンマ区切りのページIDを配列に変換し、各IDをハイフン付き形式に変換
  const pageIds = NOTION_PAGE_ID.split(',')
    .map(id => id.trim())
    .map(id => formatNotionId(id));
  
  let allUpdates = [];
  
  // 現在の日付を取得（処理開始時点）
  const currentDate = new Date();
  
  console.log(`Checking updates from ${lastCheckedDate.toISOString()} to ${currentDate.toISOString()}`);
  console.log(`Monitoring these pages: ${pageIds.join(', ')}`);
  
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
  
  // 期間情報の追加
  const periodStart = new Date(lastCheckedDate);
  const periodEnd = new Date(currentDate);
  
  // 次回のために最終チェック日を更新
  lastCheckedDate = currentDate;
  
  return {
    updates: allUpdates,
    period: {
      start: periodStart,
      end: periodEnd
    }
  };
}

// ChatGPTで週報分析を行う関数
async function analyzeWeeklyUpdates(data) {
  const { updates, period } = data;
  
  if (updates.length === 0) {
    return `期間: ${period.start.toLocaleString('ja-JP')} 〜 ${period.end.toLocaleString('ja-JP')}\n\n今週は更新がありませんでした。`;
  }
  
  const startDateStr = period.start.toLocaleString('ja-JP');
  const endDateStr = period.end.toLocaleString('ja-JP');
  
  const prompt = `
以下は私のNotionで ${startDateStr} から ${endDateStr} までの期間に更新されたページの内容です。これらの更新内容を分析して、以下の形式で週報フィードバックを作成してください：

1. 今週の進捗まとめ
2. 達成した項目
3. 課題や停滞している項目
4. 来週に向けたアドバイス
5. AIが推奨する優先事項（特にAI活用の視点から）

更新内容：
${updates.map(update => `
タイトル: ${update.title}
最終更新: ${new Date(update.lastEditedTime).toLocaleString('ja-JP')}
内容:
${update.content}
-------------------
`).join('\n')}
`;

  try {
    console.log("Sending request to OpenAI for analysis");
    const completion = await openai.createChatCompletion({
      model: "gpt-4",
      messages: [
        { role: "system", content: "あなたは個人の生産性向上とAI活用を支援するライフコーチです。Notionの更新内容を分析して、週次のフィードバックを提供します。特にAI活用の観点からアドバイスしてください。" },
        { role: "user", content: prompt }
      ],
    });
    
    // 期間情報を先頭に追加
    const periodInfo = `期間: ${startDateStr} 〜 ${endDateStr}\n\n`;
    console.log("Analysis completed successfully");
    return periodInfo + completion.data.choices[0].message.content;
  } catch (error) {
    console.error("Error generating weekly report:", error);
    return `期間: ${startDateStr} 〜 ${endDateStr}\n\n週報の生成中にエラーが発生しました: ${error.message}`;
  }
}

// ページ作成前にページが存在するか確認する関数
async function checkPageExists(pageId) {
  try {
    console.log(`Checking if page ${pageId} exists...`);
    const response = await notion.pages.retrieve({ page_id: pageId });
    console.log(`Page ${pageId} exists:`, response.id);
    return true;
  } catch (error) {
    console.error(`Error checking page ${pageId}:`, error);
    return false;
  }
}

// 週報をNotionに書き込む関数
async function writeWeeklyReportToNotion(report) {
  const today = new Date();
  const reportTitle = `週報 ${today.getFullYear()}/${today.getMonth() + 1}/${today.getDate()}`;
  
  try {
    // まず親ページの存在を確認
    const pageExists = await checkPageExists(WEEKLY_REPORT_PAGE_ID);
    if (!pageExists) {
      console.error(`Parent page ${WEEKLY_REPORT_PAGE_ID} does not exist or is inaccessible.`);
      return null;
    }
    
    console.log(`Creating weekly report under parent page ${WEEKLY_REPORT_PAGE_ID}`);
    
    // 新しいページを作成
    const response = await notion.pages.create({
      parent: {
        page_id: WEEKLY_REPORT_PAGE_ID
      },
      properties: {
        title: {
          title: [
            {
              text: {
                content: reportTitle,
              },
            },
          ],
        },
      },
      children: [
        {
          object: "block",
          type: "heading_2",
          heading_2: {
            rich_text: [
              {
                type: "text",
                text: {
                  content: "週次AIフィードバック",
                },
              },
            ],
          },
        },
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: {
                  content: report,
                },
              },
            ],
          },
        },
      ],
    });
    
    console.log("Weekly report created successfully:", response.url);
    return response.url;
  } catch (error) {
    console.error("Error writing to Notion:", error);
    
    // データベースとして試してみる
    try {
      console.log(`Attempting to create report as database entry...`);
      const response = await notion.pages.create({
        parent: {
          database_id: WEEKLY_REPORT_PAGE_ID
        },
        properties: {
          Name: {
            title: [
              {
                text: {
                  content: reportTitle,
                },
              },
            ],
          }
        },
        children: [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [
                {
                  type: "text",
                  text: {
                    content: report,
                  },
                },
              ],
            },
          },
        ],
      });
      
      console.log("Weekly report created as database entry:", response.url);
      return response.url;
    } catch (dbError) {
      console.error("Error creating as database entry:", dbError);
      return null;
    }
  }
}

// ルートパス
app.get('/', (req, res) => {
  res.send('Notion Weekly Report Generator is running! v2.0');
});

// ページ情報確認
app.get('/check-page', async (req, res) => {
  const pageId = req.query.id || WEEKLY_REPORT_PAGE_ID;
  
  try {
    res.write(`Notionページ情報の確認を開始: ${pageId}\n\n`);
    
    // ページの存在を確認
    const pageExists = await checkPageExists(pageId);
    res.write(`ページのアクセス権: ${pageExists ? 'アクセス可能' : 'アクセス不可'}\n\n`);
    
    if (pageExists) {
      res.write(`✅ ページは正常にアクセスできます\n`);
    } else {
      res.write(`❌ ページにアクセスできません。以下を確認してください：\n`);
      res.write(`1. ページIDが正しいか\n`);
      res.write(`2. インテグレーションにページへのアクセス権が付与されているか\n`);
    }
    
    res.end();
  } catch (error) {
    res.write(`⚠️ エラーが発生しました: ${error.message}\n`);
    res.end();
  }
});

// 週報生成
app.get('/generate-report', async (req, res) => {
  try {
    res.write('週報生成を開始しました...\n');
    
    // ページ更新の確認
    res.write('Notionページの更新を確認中...\n');
    const data = await getNotionUpdates();
    const updates = data.updates;
    res.write(`期間: ${data.period.start.toLocaleString('ja-JP')} 〜 ${data.period.end.toLocaleString('ja-JP')}\n`);
    res.write(`${updates.length}件の更新を検出しました\n`);
    
    // 更新内容のサマリーを表示
    if (updates.length > 0) {
      res.write('\n更新されたページ一覧:\n');
      updates.forEach(update => {
        res.write(`- ${update.title} (${new Date(update.lastEditedTime).toLocaleString('ja-JP')})\n`);
      });
    }
    
    // レポート生成
    res.write('\nAIによる週報を生成中...\n');
    const report = await analyzeWeeklyUpdates(data);
    
    // Notionに書き込み
    res.write('週報をNotionに保存中...\n');
    const reportUrl = await writeWeeklyReportToNotion(report);
    
    if (reportUrl) {
      res.write(`\n✅ 週報の生成が完了しました！\n`);
      res.write(`Notionで確認: ${reportUrl}\n`);
      res.end();
    } else {
      res.write('\n❌ 週報の保存中にエラーが発生しました\n');
      res.write('考えられる原因:\n');
      res.write('1. インテグレーションにページへのアクセス権がない\n');
      res.write('2. ページIDが正しくない\n');
      res.write('\n対処方法:\n');
      res.write('1. Notionページの設定で「Connections」から統合のアクセス権を確認\n');
      res.write('2. /check-page エンドポイントでページの詳細情報を確認\n');
      res.end();
    }
  } catch (error) {
    res.write(`エラーが発生しました: ${error.message}\n\n`);
    res.end();
  }
});

// 過去の期間の週報を生成
app.get('/generate-report-custom', async (req, res) => {
  try {
    const startDateStr = req.query.start;
    const endDateStr = req.query.end;
    
    if (!startDateStr || !endDateStr) {
      return res.status(400).send('開始日と終了日を指定してください。(?start=2025-04-04&end=2025-04-11)');
    }
    
    const startDate = new Date(startDateStr);
    const endDate = new Date(endDateStr);
    
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return res.status(400).send('無効な日付形式です。YYYY-MM-DD形式で指定してください。');
    }
    
    // 処理開始メッセージ
    res.write(`${startDateStr}から${endDateStr}までの週報生成を開始しました...\n`);
    
    // 最終チェック日を一時的に保存
    const originalLastCheckedDate = new Date(lastCheckedDate);
    
    // 指定された期間で上書き
    lastCheckedDate = startDate;
    
    // ページ更新の確認
    res.write('Notionページの更新を確認中...\n');
    const data = await getNotionUpdates();
    const updates = data.updates;
    
    // 終了日を手動で設定
    data.period.end = endDate;
    
    res.write(`期間: ${data.period.start.toLocaleString('ja-JP')} 〜 ${endDate.toLocaleString('ja-JP')}\n`);
    res.write(`${updates.length}件の更新を検出しました\n`);
    
    // 更新内容のサマリーを表示
    if (updates.length > 0) {
      res.write('\n更新されたページ一覧:\n');
      updates.forEach(update => {
        res.write(`- ${update.title} (${new Date(update.lastEditedTime).toLocaleString('ja-JP')})\n`);
      });
    }
    
    // レポート生成
    res.write('\nAIによる週報を生成中...\n');
    const report = await analyzeWeeklyUpdates(data);
    
    // Notionに書き込み
    res.write('週報をNotionに保存中...\n');
    const reportUrl = await writeWeeklyReportToNotion(report);
    
    // 元の最終チェック日を復元
    lastCheckedDate = originalLastCheckedDate;
    
    if (reportUrl) {
      res.write(`\n✅ 週報の生成が完了しました！\n`);
      res.write(`Notionで確認: ${reportUrl}\n`);
      res.end();
    } else {
      res.write('\n❌ 週報の保存中にエラーが発生しました\n');
      res.end();
    }
  } catch (error) {
    res.write(`エラーが発生しました: ${error.message}\n\n`);
    res.end();
  }
});

// 接続確認と詳細なアクセスガイド用のエンドポイント
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
        </style>
      </head>
      <body>
        <h1>Notionとの接続設定ガイド</h1>
        
        <div class="step">
          <h2>Step 1: 対象となるNotionページを開く</h2>
          <p>週報を保存したいページ（ID: <code>${WEEKLY_REPORT_PAGE_ID}</code>）をNotionで開きます。</p>
          <p>データを監視するページ：</p>
          <ul>
            ${NOTION_PAGE_ID.split(',').map(id => `<li><code>${formatNotionId(id.trim())}</code></li>`).join('')}
          </ul>
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
          <p>
            <a href="/verify-token" target="_blank">APIトークン検証</a> でAPIトークンが有効か確認することもできます。
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

// Notionのアクセストークン検証エンドポイント
app.get('/verify-token', async (req, res) => {
  try {
    res.write('NotionAPIトークンの検証を実行中...\n\n');
    
    // 最も基本的な操作でAPIを検証
    try {
      const response = await notion.users.list({});
      res.write(`✅ Notion APIトークンは有効です\n`);
      res.write(`認証済みユーザー数: ${response.results.length}\n\n`);
      
      // 最初のユーザー情報を表示
      if (response.results.length > 0) {
        const user = response.results[0];
        res.write(`認証アカウント情報:\n`);
        res.write(`- タイプ: ${user.type}\n`);
        if (user.name) res.write(`- 名前: ${user.name}\n`);
        if (user.bot && user.bot.owner) {
          res.write(`- ボット所有者: ${user.bot.owner.type}\n`);
        }
      }
    } catch (tokenError) {
      res.write(`❌ Notion APIトークンが無効です\n`);
      res.write(`エラー: ${tokenError.message}\n\n`);
      res.write(`対処方法:\n`);
      res.write(`1. Notion Developers ページで新しいトークンを生成してください\n`);
      res.write(`2. Render.comの環境変数でNOTION_API_KEYを更新してください\n`);
    }
    
    res.end();
  } catch (error) {
    res.write(`エラーが発生しました: ${error.message}\n`);
    res.end();
  }
});

// API用エンドポイント
app.get('/api/generate-report', async (req, res) => {
  try {
    const data = await getNotionUpdates();
    const updates = data.updates;
    const report = await analyzeWeeklyUpdates(data);
    const reportUrl = await writeWeeklyReportToNotion(report);
    
    if (reportUrl) {
      res.json({ 
        success: true, 
        period: {
          start: data.period.start.toISOString(),
          end: data.period.end.toISOString()
        },
        updatesCount: updates.length, 
        updatedPages: updates.map(u => u.title),
        reportUrl 
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: "週報の保存に失敗しました"
      });
    }
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message
    });
  }
});

// 金曜日の19時に実行するスケジューラー
cron.schedule('0 19 * * 5', async () => {
  console.log('Running weekly report generation... (Friday 19:00 JST)');
  try {
    const data = await getNotionUpdates();
    const updates = data.updates;
    console.log(`Found ${updates.length} updated pages`);
    if (updates.length > 0) {
      const report = await analyzeWeeklyUpdates(data);
      const reportUrl = await writeWeeklyReportToNotion(report);
      console.log(`Weekly report created: ${reportUrl}`);
    } else {
      console.log('No updates found, skipping report generation');
    }
  } catch (error) {
    console.error('Error in scheduled report generation:', error);
  }
}, {
  timezone: "Asia/Tokyo"
});
