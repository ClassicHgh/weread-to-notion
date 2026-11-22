/**
 * 一次性迁移：把已有书籍的外链封面改成 Notion 原生文件
 * 运行：npm run migrate:covers
 */

import dotenv from "dotenv";
import axios from "axios";
import { ensureBookCover } from "./api/notion/cover-upload";
import { NOTION_API_BASE_URL, NOTION_VERSION } from "./config/constants";

dotenv.config({ path: ".env" });

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const apiKey = process.env.NOTION_INTEGRATIONS;
  const databaseId = process.env.DATABASE_ID;

  if (!apiKey || !databaseId) {
    console.error("缺少 NOTION_INTEGRATIONS 或 DATABASE_ID");
    process.exit(1);
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };

  let cursor: string | undefined;
  let total = 0;
  let fixed = 0;
  let skipped = 0;
  let failed = 0;

  do {
    const resp = await axios.post(
      `${NOTION_API_BASE_URL}/databases/${databaseId}/query`,
      {
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      },
      { headers, timeout: 30000 }
    );

    for (const page of resp.data.results) {
      total++;
      const files = page.properties?.["封面"]?.files || [];
      const first = files[0];
      const externalUrl = first?.type === "external" ? first.external?.url : null;

      if (!externalUrl) {
        skipped++;
        continue;
      }

      const title = page.properties?.["书名"]?.title?.[0]?.text?.content || page.id;
      console.log(`[${total}] 处理《${title}》`);
      const ok = await ensureBookCover(apiKey, page.id, externalUrl, true);
      if (ok) {
        fixed++;
        console.log(`  ✓ 已转为原生封面`);
      } else {
        failed++;
        console.log(`  ✗ 失败，保留原外链`);
      }
      await sleep(400);
    }

    cursor = resp.data.has_more ? resp.data.next_cursor : undefined;
  } while (cursor);

  console.log(
    `\n迁移完成：共 ${total} 本，修复 ${fixed} 本，跳过 ${skipped} 本，失败 ${failed} 本`
  );
}

main().catch((error) => {
  console.error("迁移失败:", error.message);
  process.exit(1);
});
