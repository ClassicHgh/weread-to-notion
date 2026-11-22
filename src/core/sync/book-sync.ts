/**
 * 书籍同步核心模块
 */

import { BookContentSyncResult } from "../../config/types";
import { saveSyncState } from "../../utils/file";
import {
  getBookHighlightsFormatted,
  getBookThoughtsFormatted,
} from "../formatter";
import {
  writeHighlightsToNotionPage,
  writeThoughtsToNotionPage,
  writeBookToNotion,
  checkBookExistsInNotion,
  backfillStartReadingFromHighlight,
} from "../../api/notion/services";
import { getBookInfo } from "../../api/weread/services";

/**
 * 从划线数据里找出最早的一条划线日期（YYYY-MM-DD）
 * highlights 按章节组织，每个章节下有 highlights 数组。
 * 划线时间字段可能是 created / createTime / createdTime，秒或毫秒，兼容处理。
 */
function getFirstHighlightDate(highlights: any[]): string | null {
  let earliestMs: number | null = null;
  let scanned = 0;
  for (const chapter of highlights) {
    for (const h of chapter.highlights || []) {
      scanned++;
      // 微信读书不同接口/版本时间字段名不一致，全部尝试
      const raw =
        h.created ?? h.createTime ?? h.createdTime ?? h.time ?? null;
      if (raw === null || raw === undefined || raw === "") continue;
      // 若是 ISO 字符串，直接解析
      if (typeof raw === "string" && raw.includes("-")) {
        const parsed = Date.parse(raw);
        if (!isNaN(parsed)) {
          if (earliestMs === null || parsed < earliestMs) earliestMs = parsed;
        }
        continue;
      }
      const ts = typeof raw === "number" ? raw : parseInt(String(raw), 10);
      if (isNaN(ts) || ts <= 0) continue;
      // 大于 9999999999 视为毫秒，否则秒
      const ms = ts > 9999999999 ? ts : ts * 1000;
      if (earliestMs === null || ms < earliestMs) earliestMs = ms;
    }
  }
  console.log(
    `  [回填诊断] 扫描 ${scanned} 条划线，最早时间戳=${
      earliestMs === null ? "无" : new Date(earliestMs).toISOString()
    }`
  );
  if (earliestMs === null) return null;
  return new Date(earliestMs).toISOString().split("T")[0];
}

/**
 * 同步书籍内容（划线和想法）到Notion
 * 确保先写入划线，再写入想法
 */
export async function syncBookContent(
  apiKey: string,
  databaseId: string,
  cookie: string,
  bookId: string,
  finalPageId: string,
  bookInfo: any,
  useIncremental: boolean = true,
  organizeByChapter: boolean = false
): Promise<BookContentSyncResult> {
  console.log(`\n=== 同步书籍内容 ===`);
  console.log(`按章节组织: ${organizeByChapter ? "是" : "否"}`);

  try {
    // 获取书籍划线数据 - 使用增量同步
    const {
      highlights,
      synckey: highlightsSynckey,
      hasUpdate: hasHighlightUpdate,
    } = await getBookHighlightsFormatted(cookie, bookId, useIncremental);

    // 获取书籍想法数据 - 同样使用增量同步获取新想法
    const {
      thoughts,
      synckey: thoughtsSynckey,
      hasUpdate: hasThoughtUpdate,
    } = await getBookThoughtsFormatted(cookie, bookId, useIncremental);

    // 判断是否有更新
    const hasUpdates =
      hasHighlightUpdate || hasThoughtUpdate || !useIncremental;

    // 回填"开始阅读"：导入到微信读书的书没有 startReadingTime，该字段为空，
    // 会导致这些书在按日期排序/筛选的 Notion 视图里看不到。
    // 用第一条（最早）划线的时间填充。是否写入由 backfillStartReadingFromHighlight
    // 读取页面后决定：字段已有值（含手工填写）则跳过，为空才写入。
    // 因此这里不再依赖 bookInfo.progressData 判断，任何书都尝试一次。
    // 必须放在 hasUpdates 提前返回之前，否则没有新划线的书永远无法回填。
    console.log(
      `\n[开始阅读回填] 《${bookInfo.title}》 progressData.startReadingTime=${
        bookInfo?.progressData?.startReadingTime ?? "undefined"
      }`
    );
    let backfillHighlights = highlights;
    // 增量模式只返回新划线，拿不到最早那条，需全量拉取一次
    if (useIncremental) {
      const fullData = await getBookHighlightsFormatted(cookie, bookId, false);
      backfillHighlights = fullData.highlights;
      console.log(
        `  [回填诊断] 增量模式下全量重拉划线，得到 ${
          backfillHighlights.reduce(
            (sum, ch) => sum + (ch.highlights?.length || 0),
            0
          )
        } 条`
      );
    }
    const firstDate = getFirstHighlightDate(backfillHighlights);
    if (firstDate) {
      console.log(
        `  [开始阅读回填] 《${bookInfo.title}》最早划线日期=${firstDate}，尝试回填到页面 ${finalPageId}`
      );
      const ok = await backfillStartReadingFromHighlight(
        apiKey,
        finalPageId,
        firstDate
      );
      console.log(`  [开始阅读回填] 结果=${ok ? "已写入" : "跳过或失败"}`);
    } else {
      console.log(
        `  [开始阅读回填] 《${bookInfo.title}》未取到划线日期，跳过（无划线或时间字段异常）`
      );
    }

    if (!hasUpdates) {
      console.log(`《${bookInfo.title}》没有检测到新内容，跳过内容同步`);
      return {
        success: true,
        highlightsSynckey,
        thoughtsSynckey,
        hasUpdate: false,
        highlights: [],
        thoughts: [],
      };
    }

    // 1. 先处理划线数据
    console.log(
      `处理划线数据（共 ${highlights.reduce(
        (sum, chapter) => sum + chapter.highlights.length,
        0
      )} 条）...`
    );

    let highlightResult = true;
    if (hasHighlightUpdate && highlights.length > 0) {
      // 写入划线数据
      highlightResult = await writeHighlightsToNotionPage(
        apiKey,
        finalPageId,
        bookInfo,
        highlights,
        organizeByChapter
      );
      console.log(
        highlightResult
          ? `成功写入 ${highlights.reduce(
              (sum, chapter) => sum + chapter.highlights.length,
              0
            )} 条划线`
          : `写入划线失败`
      );
    } else {
      console.log(`没有新的划线需要同步`);
    }

    // 2. 再处理想法数据
    console.log(`处理想法数据（共 ${thoughts.length} 条）...`);

    let thoughtResult = true;
    if (hasThoughtUpdate && thoughts.length > 0) {
      // 写入想法数据 - 传递增量更新标志和按章节组织标志
      thoughtResult = await writeThoughtsToNotionPage(
        apiKey,
        finalPageId,
        bookInfo,
        thoughts,
        useIncremental,
        organizeByChapter
      );
      console.log(
        thoughtResult ? `成功写入 ${thoughts.length} 条想法` : `写入想法失败`
      );
    } else {
      console.log(`没有新的想法需要同步`);
    }

    // 返回同步结果和synckey
    return {
      success: highlightResult && thoughtResult,
      highlightsSynckey,
      thoughtsSynckey,
      hasUpdate: true,
      highlights,
      thoughts,
    };
  } catch (error: any) {
    console.error(`同步书籍内容失败:`, error.message);
    return {
      success: false,
      highlightsSynckey: "",
      thoughtsSynckey: "",
      hasUpdate: false,
      highlights: [],
      thoughts: [],
    };
  }
}

/**
 * 同步单本书
 */
export async function syncSingleBook(
  apiKey: string,
  databaseId: string,
  cookie: string,
  bookId: string,
  useIncremental: boolean = true,
  organizeByChapter: boolean = false
): Promise<boolean> {
  console.log(
    `\n=== 开始${useIncremental ? "增量" : "全量"}同步书籍(ID: ${bookId}) ===`
  );

  try {
    // 获取书籍详细信息
    const bookInfo = await getBookInfo(cookie, bookId);
    if (!bookInfo) {
      console.error(`未能获取到书籍 ${bookId} 的信息`);
      return false;
    }

    // 添加读书状态
    bookInfo.finishReadingStatus = bookInfo.finishReading ? "已读完" : "未读完";

    // 检查书籍是否已存在
    const { exists, pageId: existingPageId } = await checkBookExistsInNotion(
      apiKey,
      databaseId,
      bookInfo.title,
      bookInfo.author
    );

    let finalPageId: string;

    if (exists && existingPageId) {
      console.log(`书籍《${bookInfo.title}》已存在，将更新现有记录`);
      finalPageId = existingPageId;
    } else {
      // 写入书籍元数据到Notion
      const writeResult = await writeBookToNotion(apiKey, databaseId, bookInfo);

      if (!writeResult.success || !writeResult.pageId) {
        console.error(`写入书籍 ${bookId} 到Notion失败`);
        return false;
      }
      finalPageId = writeResult.pageId;
    }

    // 同步书籍内容
    const syncContentResult = await syncBookContent(
      apiKey,
      databaseId,
      cookie,
      bookId,
      finalPageId,
      bookInfo,
      useIncremental,
      organizeByChapter
    );

    // 保存同步状态
    if (useIncremental) {
      const syncState = {
        bookId,
        lastSyncTime: Date.now(),
        highlightsSynckey: syncContentResult.highlightsSynckey,
        thoughtsSynckey: syncContentResult.thoughtsSynckey,
      };
      saveSyncState(syncState);
      console.log(
        `已保存同步状态，highlightsSynckey: ${syncContentResult.highlightsSynckey}, thoughtsSynckey: ${syncContentResult.thoughtsSynckey}`
      );
    }

    console.log(`书籍 ${bookId} 同步完成`);
    return true;
  } catch (error: any) {
    console.error(`同步书籍 ${bookId} 失败:`, error.message);
    return false;
  }
}
