require('dotenv').config();
const express = require('express');
const { Client } = require('@notionhq/client');
const { Configuration, OpenAIApi } = require('openai');
const cron = require('node-cron');

// ハイフンなしのIDをハイフン付きに変換する関数
function formatNotionId(id) {
  if (!id || typeof id !== 'string') return id;
  if (id.includes('-')) return id;
  return id.replace(/^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/, '$1-$2-$3-$4-$5');
}

// 環境変数の読み込み
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_PAGE_ID = process.env.NOTION_PAGE_ID || '016b7ee1-4192-49cd-bea4-04522214f2d1,8620f694-c929-4e28-a1fc-23741ac82372,54608237-b872-4bf0-a2fd-9c66fd10c1c3';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WEEKLY_REPORT_PAGE_ID = process.env.WEEKLY_REPORT_PAGE_ID ? formatNotionId(process.env.WEEKLY_REPORT_PAGE_ID) : '4a6158f0-c7e3-4317-8364-11de5e834013';
const PORT = process.env.PORT || 3000;

// ログ
console.log(`Starting application with config:`);
console.log(`- PORT: ${PORT}`);
console.log(`- NOTION_PAGE_ID pages count: ${NOTION_PAGE_ID ? NOTION_PAGE_ID.split(',').length : 0}`);
console.log(`- WEEKLY_REPORT_PAGE_ID: ${WEEKLY_REPORT_PAGE_ID}`);

// Notionクライアント
const notion = new Client({ auth: NOTION_API_KEY });

// OpenAI設定
const openai = new OpenAIApi(new Configuration({ apiKey: OPENAI_API_KEY }));

let lastCheckedDate = new Date();
lastCheckedDate.setDate(lastCheckedDate.getDate() - 7);

// ページ探索
async function explorePageStructure(pageId, depth = 0, maxDepth = 2) {
  if (depth > maxDepth) return [];

  try {
    const pageInfo = await notion.pages.retrieve({ page_id: pageId });
    const lastEditedTime = new Date(pageInfo.last_edited_time);
    const blocks = await notion.blocks.children.list({ block_id: pageId, page_size: 100 });

    let updates = [];

    if (lastEditedTime > lastCheckedDate) {
      const pageContent = [];

      for (const block of blocks.results) {
        try {
          const text = block[block.type]?.rich_text?.[0]?.plain_text;
          if (!text) continue;

          if (block.type === 'paragraph') pageContent.push(text);
          else if (block.type.startsWith('heading_')) pageContent.push('#'.repeat(parseInt(block.type.slice(-1))) + ' ' + text);
          else if (block.type === 'bulleted_list_item') pageContent.push('• ' + text);
          else if (block.type === 'numbered_list_item') pageContent.push('1. ' + text);
          else if (block.type === 'to_do') pageContent.push(`[${block.to_do.checked ? 'x' : ' '}] ${text}`);
        } catch (e) {
          console.error(`Block parse error in ${pageId}`, e);
        }
      }

      const title = pageInfo.properties?.title?.title?.[0]?.plain_text || 'Untitled';

      updates.push({
        pageId,
        title,
        lastEditedTime: pageInfo.last_edited_time,
        content: pageContent.join('\n')
      });
    }

    for (const block of blocks.results) {
      if (block.type === 'child_page') {
        const childUpdates = await explorePageStructure(block.id, depth + 1, maxDepth);
        updates.push(...childUpdates);
      }
    }

    return updates;
  } catch (error) {
    console.error(`explorePageStructure error:`, error);
    return [];
  }
}

async function getNotionUpdates() {
  const pageIds = NOTION_PAGE_ID.split(',').map(id => formatNotionId(id.trim()));
  let allUpdates = [];
  const currentDate = new Date();

  for (const pageId of pageIds) {
    const updates = await explorePageStructure(pageId);
    allUpdates.push(...updates);
  }

  const periodStart = new Date(lastCheckedDate);
  const periodEnd = new Date(currentDate);
  lastCheckedDate = currentDate;

  return {
    updates: allUpdates,
    period: { start: periodStart, end: periodEnd }
  };
}

async function analyzeWeeklyUpdates(data) {
  const { updates, period } = data;
  const start = period.start.toLocaleString('ja-JP');
  const end = period.end.toLocaleString('ja-JP');

  if (updates.length === 0) {
    return `期間: ${start} 〜 ${end}\n\n今週は更新がありませんでした。`;
  }

  const prompt = `
以下は私のNotionで ${start} から ${end} までの期間に更新されたページの内容です。これらを分析し、週報を以下の形式で作成してください：

1. 今週の進捗まとめ
2. 達成した項目
3. 課題や停滞している項目
4. 来週に向けたアドバイス
5. AIが推奨する優先事項（特にAI活用の視点から）

更新内容：
${updates.map(u => `タイトル: ${u.title}\n最終更新: ${new Date(u.lastEditedTime).toLocaleString('ja-JP')}\n内容:\n${u.content}\n---`).join('\n')}
`;

  try {
    const res = await openai.createChatCompletion({
      model: 'gpt-4',
      messages: [
        { role: "system", content: "あなたはAIライフコーチです。Notionの内容を分析し週次フィードバックを提供してください。" },
        { role: "user", content: prompt }
      ]
    });
    return `期間: ${start} 〜 ${end}\n\n${res.data.choices[0].message.content}`;
  } catch (e) {
    return `期間: ${start} 〜 ${end}\n\n週報生成中にエラー: ${e.message}`;
  }
}

async function checkPageExists(pageId) {
  try {
    await notion.pages.retrieve({ page_id: pageId });
    return true;
  } catch {
    return false;
  }
}

async function writeWeeklyReportToNotion(report) {
  const today = new Date();
  const title = `週報 ${today.getFullYear()}/${today.getMonth() + 1}/${today.getDate()}`;

  try {
    const exists = await checkPageExists(WEEKLY_REPORT_PAGE_ID);
    if (!exists) return null;

    const res = await notion.pages.create({
      parent: { page_id: WEEKLY_REPORT_PAGE_ID },
      properties: {
        title: {
          title: [{ text: { content: title } }]
        }
      },
      children: [
        {
          object: "block",
          type: "heading_2",
          heading_2: { rich_text: [{ type: "text", text: { content: "週次AIフィードバック" } }] }
        },
        {
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: report } }] }
        }
      ]
    });

    return res.url;
  } catch (e1) {
    try {
      const res = await notion.pages.create({
        parent: { database_id: WEEKLY_REPORT_PAGE_ID },
        properties: {
          Name: { title: [{ text: { content: title } }] }
        },
        children: [{
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: report } }] }
        }]
      });

      return res.url;
    } catch (e2) {
      console.error("Create page failed", e1, e2);
      return null;
    }
  }
}

// Expressアプリ初期化
const app = express();
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// ページ情報確認
app.get('/check-page', async (req, res) => {
  const pageId = req.query.id || WEEKLY_REPORT_PAGE_ID;

  try {
    res.write(`Notionページ情報の確認を開始: ${pageId}\n\n`);
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




app.get('/', (_, res) => res.send('Notion Weekly Report Generator is running!'));
app.get('/generate-report', async (req, res) => {
  const data = await getNotionUpdates();
  const report = await analyzeWeeklyUpdates(data);
  const url = await writeWeeklyReportToNotion(report);
  res.send(url ? `✅ 週報作成成功: ${url}` : `❌ 作成失敗`);
});

cron.schedule('0 19 * * 5', async () => {
  const data = await getNotionUpdates();
  if (data.updates.length > 0) {
    const report = await analyzeWeeklyUpdates(data);
    const url = await writeWeeklyReportToNotion(report);
    console.log(`📌 Weekly report saved: ${url}`);
  } else {
    console.log("No updates found this week.");
  }
}, { timezone: "Asia/Tokyo" });

// サーバー起動（←ここが修正された場所！）
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is listening on http://0.0.0.0:${PORT}`);
  console.log(`Scheduled for Fridays at 19:00 JST`);
  console.log('Checking destination page on startup...');
  checkPageExists(WEEKLY_REPORT_PAGE_ID).then(exists => {
    console.log(exists ? '✅ Report destination page is accessible' : '⚠️ WARNING: Report destination page is NOT accessible');
  });
});

// 終了ハンドラー
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => console.log('Server closed'));
});
process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => console.log('Server closed'));
});
