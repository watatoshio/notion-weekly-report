// index.js
require('dotenv').config();
const express = require('express');
const { Client } = require('@notionhq/client');
const { Configuration, OpenAIApi } = require('openai');
const cron = require('node-cron');

// 環境変数の設定（後でRender.comで設定します）
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_PAGE_ID = process.env.NOTION_PAGE_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Notionクライアントの初期化
const notion = new Client({ auth: NOTION_API_KEY });

// OpenAI設定
const configuration = new Configuration({
  apiKey: OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

// 最終チェック日を保存する変数
let lastCheckedDate = new Date();
lastCheckedDate.setDate(lastCheckedDate.getDate() - 7); // 初回は1週間前から

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

// メイン処理
async function getNotionUpdates() {
  const updates = await explorePageStructure(NOTION_PAGE_ID);
  const currentDate = new Date();
  lastCheckedDate = currentDate; // 最終チェック日を更新
  return updates;
}

// ChatGPTで週報分析を行う関数
async function analyzeWeeklyUpdates(updates) {
  if (updates.length === 0) {
    return "今週は更新がありませんでした。";
  }
  
  const prompt = `
以下は私のNotionで過去1週間に更新されたページの内容です。これらの更新内容を分析して、以下の形式で週報フィードバックを作成してください：

1. 今週の進捗まとめ
2. 達成した項目
3. 課題や停滞している項目
4. 来週に向けたアドバイス
5. AIが推奨する優先事項（特にAI活用の視点から）

更新内容：
${updates.map(update => `
タイトル: ${update.title}
最終更新: ${new Date(update.lastEditedTime).toLocaleString()}
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
    
    return completion.data.choices[0].message.content;
  } catch (error) {
    console.error("Error generating weekly report:", error);
    return "週報の生成中にエラーが発生しました: " + error.message;
  }
}

// 週報をNotionに書き込む関数
async function writeWeeklyReportToNotion(report) {
  const today = new Date();
  const reportTitle = `週報 ${today.getFullYear()}/${today.getMonth() + 1}/${today.getDate()}`;
  
  try {
    // 新しいページを作成
    const response = await notion.pages.create({
      parent: {
        page_id: NOTION_PAGE_ID, // 親ページの下に作成
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
                  content: "今週のAIフィードバック",
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

// 週に一度、日曜日の夜に実行するスケジューラー
cron.schedule('0 20 * * 0', async () => {
  console.log('Running weekly report generation...');
  const updates = await getNotionUpdates();
  const report = await analyzeWeeklyUpdates(updates);
  await writeWeeklyReportToNotion(report);
}, {
  timezone: "Asia/Tokyo"
});

// APIエンドポイントを設定
app.get('/', (req, res) => {
  res.send('Notion Weekly Report Generator is running!');
});

app.get('/generate-report', async (req, res) => {
  try {
    const updates = await getNotionUpdates();
    console.log(`Found ${updates.length} updated pages`);
    const report = await analyzeWeeklyUpdates(updates);
    const reportUrl = await writeWeeklyReportToNotion(report);
    res.json({ success: true, updatesCount: updates.length, reportUrl });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// サーバー起動
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
