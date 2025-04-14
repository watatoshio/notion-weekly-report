// index.js
require('dotenv').config();
const express = require('express');
const { Client } = require('@notionhq/client');
const { Configuration, OpenAIApi } = require('openai');
const cron = require('node-cron');

// 環境変数の設定
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_PAGE_ID = process.env.NOTION_PAGE_ID; // カンマ区切りの複数ページID
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// 週報を作成するページID
const WEEKLY_REPORT_PAGE_ID = '37380149ec3e47e99e8f533c3486ab89';

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
          pageContent.push(`[Error processing block: ${block.type}]`);
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
    console.error(`Error details for ${pageId}:`, JSON.stringify(error.body || error, null, 2));
    return [];
  }
}

// メイン処理 - 複数ページ対応
async function getNotionUpdates() {
  // カンマ区切りのページIDを配列に変換
  const pageIds = NOTION_PAGE_ID.split(',').map(id => id.trim());
  let allUpdates = [];
  
  // 現在の日付を取得（処理開始時点）
  const currentDate = new Date();
  
  console.log(`Checking updates from ${lastCheckedDate.toISOString()} to ${currentDate.toISOString()}`);
  console.log(`Pages to check: ${pageIds.join(', ')}`);
  
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
    console.error("OpenAI error details:", JSON.stringify(error.response?.data || error, null, 2));
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
    console.error(`Page check error details:`, JSON.stringify(error.body || error, null, 2));
    return false;
  }
}

// 週報をNotionに書き込む関数 - 指定ページ対応とデータベース対応
async function writeWeeklyReportToNotion(report) {
  const today = new Date();
  const reportTitle = `週報 ${today.getFullYear()}/${today.getMonth() + 1}/${today.getDate()}`;
  
  // 指定されたページIDを親ページとして使用
  const parentPageId = WEEKLY_REPORT_PAGE_ID;
  
  try {
    console.log(`Checking parent page ${parentPageId} before creating report...`);
    
    // まず親ページの存在を確認
    const pageExists = await checkPageExists(parentPageId);
    if (!pageExists) {
      console.error(`Parent page ${parentPageId} does not exist or is inaccessible.`);
      return null;
    }
    
    console.log(`Creating weekly report under parent page ${parentPageId}`);
    
    // ページの親タイプを確認（データベースかページか）
    // まずはページ型として試す
    try {
      console.log(`Attempting to create report as child page...`);
      
      // 新しいページを作成
      const response = await notion.pages.create({
        parent: {
          page_id: parentPageId // 指定されたページの下に作成
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
    } catch (pageError) {
      console.error("Error creating as child page:", pageError);
      console.error("Page creation error details:", JSON.stringify(pageError.body || pageError, null, 2));
      
      // もしページとして失敗したら、データベースとして試してみる
      if (pageError.status === 400) {
        try {
          console.log(`Attempting to create report as database entry...`);
          const response = await notion.pages.create({
            parent: {
              database_id: parentPageId // データベースIDとして使用
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
              },
              // 他にデータベースが必要とするプロパティがあればここに追加
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
          
          console.log("Weekly report created as database entry:", response.url);
          return response.url;
        } catch (dbError) {
          console.error("Error creating as database entry:", dbError);
          console.error("Database creation error details:", JSON.stringify(dbError.body || dbError, null, 2));
          return null;
        }
      }
      return null;
    }
  } catch (error) {
    console.error("Error writing to Notion:", error);
    console.error("Error details:", JSON.stringify(error.body || error, null, 2));
    return null;
  }
}

// Notionのページタイプを検出する関数
async function detectNotionPageType(pageId) {
  try {
    console.log(`Detecting page type for ${pageId}...`);
    
    // まずはページとして取得を試みる
    try {
      const pageInfo = await notion.pages.retrieve({ page_id: pageId });
      console.log(`Page ${pageId} is a normal page`);
      return { type: 'page', info: pageInfo };
    } catch (pageError) {
      // ページとして取得できなかった場合、データベースとして試す
      if (pageError.status === 404) {
        try {
          const dbInfo = await notion.databases.retrieve({ database_id: pageId });
          console.log(`Page ${pageId} is a database`);
          return { type: 'database', info: dbInfo };
        } catch (dbError) {
          console.error(`${pageId} is neither a valid page nor database:`, dbError);
          return { type: 'unknown', error: dbError };
        }
      } else {
        console.error(`Error detecting page type for ${pageId}:`, pageError);
        return { type: 'error', error: pageError };
      }
    }
  } catch (error) {
    console.error(`General error detecting page type for ${pageId}:`, error);
    return { type: 'error', error };
  }
}

// Webアプリの設定
const app = express();
const PORT = process.env.PORT || 3000;

// CORSを設定（必要に応じて）
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// APIエンドポイントを設定
app.get('/', (req, res) => {
  res.send('Notion Weekly Report Generator is running! 複数ページ対応版 (デバッグ強化版)');
});

// Notionページの情報を確認するエンドポイント
app.get('/check-page', async (req, res) => {
  const pageId = req.query.id || WEEKLY_REPORT_PAGE_ID;
  
  try {
    res.write(`Notionページ情報の確認を開始: ${pageId}\n\n`);
    
    // ページタイプを検出
    const pageTypeInfo = await detectNotionPageType(pageId);
    res.write(`ページタイプ: ${pageTypeInfo.type}\n`);
    
    if (pageTypeInfo.type === 'error' || pageTypeInfo.type === 'unknown') {
      res.write(`エラー情報: ${JSON.stringify(pageTypeInfo.error, null, 2)}\n`);
      res.end();
      return;
    }
    
    // ページのアクセス権を確認
    const pageExists = await checkPageExists(pageId);
    res.write(`ページのアクセス権: ${pageExists ? 'アクセス可能' : 'アクセス不可'}\n\n`);
    
    if (pageTypeInfo.type === 'page') {
      res.write(`ページの詳細情報:\n`);
      res.write(`ページID: ${pageTypeInfo.info.id}\n`);
      res.write(`最終更新: ${new Date(pageTypeInfo.info.last_edited_time).toLocaleString('ja-JP')}\n`);
      res.write(`作成日時: ${new Date(pageTypeInfo.info.created_time).toLocaleString('ja-JP')}\n`);
    } else if (pageTypeInfo.type === 'database') {
      res.write(`データベースの詳細情報:\n`);
      res.write(`データベースID: ${pageTypeInfo.info.id}\n`);
      res.write(`タイトル: ${pageTypeInfo.info.title[0]?.plain_text || 'タイトルなし'}\n`);
      
      res.write(`\nデータベースの列構造:\n`);
      for (const [key, prop] of Object.entries(pageTypeInfo.info.properties)) {
        res.write(`- ${key}: ${prop.type}\n`);
      }
    }
    
    res.write(`\n✅ チェック完了\n`);
    res.end();
  } catch (error) {
    res.write(`⚠️ エラーが発生しました: ${error.message}\n`);
    res.write(`詳細: ${JSON.stringify(error, null, 2)}\n`);
    res.end();
  }
});

// 進捗状況を詳細に表示する拡張バージョン
app.get('/generate-report', async (req, res) => {
  try {
    // 処理開始メッセージ
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
    
    // 週報保存先の情報確認
    res.write(`\n週報保存先ページの確認: ${WEEKLY_REPORT_PAGE_ID}\n`);
    const pageTypeInfo = await detectNotionPageType(WEEKLY_REPORT_PAGE_ID);
    res.write(`週報保存先のタイプ: ${pageTypeInfo.type}\n`);
    
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
      res.write('1. 指定されたページID（37380149ec3e47e99e8f533c3486ab89）が存在しない\n');
      res.write('2. インテグレーションにページへのアクセス権がない\n');
      res.write('3. ページIDがデータベースIDなど、子ページ作成に対応していない形式\n');
      res.write('\n対処方法:\n');
      res.write('1. ページIDが正しいか確認してください\n');
      res.write('2. Notionページの設定で「Connections」から統合（インテグレーション）のアクセス権を確認・追加してください\n');
      res.write('3. /check-page エンドポイントでページの詳細情報を確認してください\n');
      res.end();
    }
  } catch (error) {
    res.write(`エラーが発生しました: ${error.message}\n\n`);
    res.write(`詳細: ${JSON.stringify(error, null, 2)}\n`);
    res.end();
  }
});

// 過去の期間を指定して週報を生成するエンドポイント
app.get('/generate-report-custom', async (req, res) => {
  try {
    // URLから日付パラメータを取得
    const startDateStr = req.query.start; // 例: 2025-04-04
    const endDateStr = req.query.end;     // 例: 2025-04-11
    
    if (!startDateStr || !endDateStr) {
      return res.status(400).send('開始日と終了日を指定してください。(?start=2025-04-04&end=2025-04-11)');
    }
    
    // 日付をパース
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
    
    // 終了日を手動で設定（getNotionUpdates内でlastCheckedDateが更新されるため）
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
    
    // 週報保存先の情報確認
    res.write(`\n週報保存先ページの確認: ${WEEKLY_REPORT_PAGE_ID}\n`);
    const pageTypeInfo = await detectNotionPageType(WEEKLY_REPORT_PAGE_ID);
    res.write(`週報保存先のタイプ: ${pageTypeInfo.type}\n`);
    
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
      res.write('考えられる原因:\n');
      res.write('1. 指定されたページID（37380149ec3e47e99e8f533c3486ab89）が存在しない\n');
      res.write('2. インテグレーションにページへのアクセス権がない\n');
      res.write('3. ページIDがデータベースIDなど、子ページ作成に対応していない形式\n');
      res.write('\n対処方法:\n');
      res.write('1. ページIDが正しいか確認してください\n');
      res.write('2. Notionページの設定で「Connections」から統合（インテグレーション）のアクセス権を確認・追加してください\n');
      res.write('3. /check-page エンドポイントでページの詳細情報を確認してください\n');
      res.end();
    }
  } catch (error) {
    res.write(`エラーが発生しました: ${error.message}\n\n`);
    res.write(`詳細: ${JSON.stringify(error, null, 2)}\n`);
    res.end();
  }
});

// シンプルなJSONレスポンスバージョン
app.get('/api/generate-report', async (req, res) => {
  try {
    const data = await getNotionUpdates();
    const updates = data.updates;
    console.log(`Found ${updates.length} updated pages`);
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
      // ページタイプのチェック結果を含める
      const pageTypeInfo = await detectNotionPageType(WEEKLY_REPORT_PAGE_ID);
      
      res.status(500).json({ 
        success: false, 
        error: "週報の保存に失敗しました",
        period: {
          start: data.period.start.toISOString(),
          end: data.period.end.toISOString()
        },
        updatesCount: updates.length,
        pageTypeInfo: {
          pageId: WEEKLY_REPORT_PAGE_ID,
          type: pageTypeInfo.type
        }
      });
    }
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message,
      details: JSON.stringify(error, null, 2)
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
