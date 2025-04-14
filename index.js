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
    // ページの情報を取得
    const pageInfo = await notion.pages.retrieve({ page_id: pageId });
    const lastEditedTime = new Date(pageInfo.last_edited_time);
    
    // ページのブロック（内容）を取得
    const blocks = await notion.blocks.children.list({ block_id: pageId });
    let updates = [];
    
    // 最終チェック日以降に更新されていれば記録
    if (lastEditedTime > lastCheckedDate) {
      // ページの内容をテキスト化
      const pageContent = [];
      for (const block of blocks.results) {
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
      }
      
      // タイトルの取得
      let title = "Untitled";
      if (pageInfo.properties && pageInfo.properties.title) {
        const titleProp = pageInfo.properties.title;
        if (titleProp.title && titleProp.title.length > 0) {
          title = titleProp.title[0].plain_text;
        }
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
        const childUpdates = await explorePageStructure(block.id, depth + 1, maxDepth);
        updates = [...updates, ...childUpdates];
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
  // カンマ区切りのページIDを配列に変換
  const pageIds = NOTION_PAGE_ID.split(',').map(id => id.trim());
  let allUpdates = [];
  
  // 現在の日付を取得（処理開始時点）
  const currentDate = new Date();
  
  // 各ページを順番に処理
  for (const pageId of pageIds) {
    console.log(`Processing page: ${pageId}`);
    const updates = await explorePageStructure(pageId);
    allUpdates = [...allUpdates, ...updates];
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
    const completion = await openai.createChatCompletion({
      model: "gpt-4",
      messages: [
        { role: "system", content: "あなたは個人の生産性向上とAI活用を支援するライフコーチです。Notionの更新内容を分析して、週次のフィードバックを提供します。特にAI活用の観点からアドバイスしてください。" },
        { role: "user", content: prompt }
      ],
    });
    
    // 期間情報を先頭に追加
    const periodInfo = `期間: ${startDateStr} 〜 ${endDateStr}\n\n`;
    return periodInfo + completion.data.choices[0].message.content;
  } catch (error) {
    console.error("Error generating weekly report:", error);
    return `期間: ${startDateStr} 〜 ${endDateStr}\n\n週報の生成中にエラーが発生しました: ${error.message}`;
  }
}

// 週報をNotionに書き込む関数 - 指定ページ対応
async function writeWeeklyReportToNotion(report) {
  const today = new Date();
  const reportTitle = `週報 ${today.getFullYear()}/${today.getMonth() + 1}/${today.getDate()}`;
  
  try {
    // 指定されたページIDを親ページとして使用
    const parentPageId = WEEKLY_REPORT_PAGE_ID;
    
    // 新しいページを作成
    const response = await notion.pages.create({
      parent: {
        page_id: parentPageId, // 指定されたページの下に作成
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
    
    console.log("Weekly report created:", response.url);
    return response.url;
  } catch (error) {
    console.error("Error writing to Notion:", error);
    return null;
  }
}

// Webアプリの設定
const app = express();
const PORT = process.env.PORT || 3000;

// APIエンドポイントを設定
app.get('/', (req, res) => {
  res.send('Notion Weekly Report Generator is running! 複数ページ対応版');
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
    
    // Notionに書き込み
    res.write('週報をNotionに保存中...\n');
    const reportUrl = await writeWeeklyReportToNotion(report);
    
    if (reportUrl) {
      res.write(`\n✅ 週報の生成が完了しました！\n`);
      res.write(`Notionで確認: ${reportUrl}\n`);
      res.end();
    } else {
      res.write('\n❌ 週報の保存中にエラーが発生しました\n');
      res.end();
    }
  } catch (error) {
    res.status(500).send(`エラーが発生しました: ${error.message}`);
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
    res.status(500).send(`エラーが発生しました: ${error.message}`);
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
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
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

// サーバー起動
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Configured page IDs: ${NOTION_PAGE_ID.split(',').length}`);
  console.log(`Weekly report will be created under page: ${WEEKLY_REPORT_PAGE_ID}`);
  console.log(`Scheduled for Fridays at 19:00 JST`);
});
