/**
 * 封面导入：把微信读书的外链封面转成 Notion 原生文件
 *
 * 原因：脚本原先写入的是 external file，文件名没有扩展名，
 * 且 res.weread.qq.com 的 parsecover 地址会 302 跳转到带签名的临时链接。
 * Notion 不会跟随跳转，也不保证把无扩展名的外链当图片渲染，
 * 结果是画廊里封面空白。这里改成先把真实地址解析出来，
 * 再用 Notion File Upload API 导入为原生文件。
 */

import axios from "axios";
import { NOTION_API_BASE_URL } from "../../config/constants";

// File Upload API 需要新版本头
const FILE_API_VERSION = "2026-03-11";

function fileHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Notion-Version": FILE_API_VERSION,
    "Content-Type": "application/json",
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 解析封面的真实直链。
 * parsecover 会 302 到带签名的 COS 地址，Notion 的 external_url 导入不支持跳转，
 * 所以这里在同步侧先把 Location 取出来。
 */
async function resolveDirectImageUrl(coverUrl: string): Promise<string> {
  try {
    const resp = await axios.get(coverUrl, {
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
      timeout: 15000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Referer: "https://weread.qq.com/",
      },
    });
    const location = resp.headers["location"];
    if (resp.status >= 300 && resp.status < 400 && location) {
      return new URL(location, coverUrl).toString();
    }
    return coverUrl;
  } catch (error: any) {
    // 解析失败时退回原地址，交给 Notion 尝试
    console.warn(`解析封面直链失败，使用原地址: ${error.message}`);
    return coverUrl;
  }
}

/**
 * 把图片 URL 导入为 Notion 原生文件，返回 file_upload id。
 */
export async function uploadCoverToNotion(
  apiKey: string,
  coverUrl: string
): Promise<string | null> {
  if (!coverUrl) return null;

  const directUrl = await resolveDirectImageUrl(coverUrl);

  try {
    const createResp = await axios.post(
      `${NOTION_API_BASE_URL}/file_uploads`,
      {
        mode: "external_url",
        external_url: directUrl,
        filename: "cover.jpg",
      },
      { headers: fileHeaders(apiKey), timeout: 30000 }
    );

    const uploadId = createResp.data?.id;
    if (!uploadId) return null;

    let status = createResp.data?.status;
    for (let i = 0; i < 12 && status !== "uploaded"; i++) {
      if (status === "failed" || status === "expired") return null;
      await sleep(5000);
      const check = await axios.get(
        `${NOTION_API_BASE_URL}/file_uploads/${uploadId}`,
        { headers: fileHeaders(apiKey), timeout: 30000 }
      );
      status = check.data?.status;
    }

    if (status !== "uploaded") {
      console.warn(`封面导入超时: ${coverUrl}`);
      return null;
    }
    return uploadId;
  } catch (error: any) {
    const detail = error.response?.data
      ? JSON.stringify(error.response.data).substring(0, 300)
      : error.message;
    console.warn(`封面导入失败 ${coverUrl}: ${detail}`);
    return null;
  }
}

/**
 * 确保某本书的封面是 Notion 原生文件。
 * 已经是原生文件就跳过，避免每次同步重复上传。
 */
export async function ensureBookCover(
  apiKey: string,
  pageId: string,
  coverUrl: string,
  skipCheck: boolean = false
): Promise<boolean> {
  if (!coverUrl) return false;

  try {
    if (!skipCheck) {
      const pageResp = await axios.get(
        `${NOTION_API_BASE_URL}/pages/${pageId}`,
        { headers: fileHeaders(apiKey), timeout: 30000 }
      );
      const files = pageResp.data?.properties?.["封面"]?.files || [];
      const first = files[0];
      if (first && (first.type === "file" || first.type === "file_upload")) {
        return false;
      }
    }

    const uploadId = await uploadCoverToNotion(apiKey, coverUrl);
    if (!uploadId) return false;

    await axios.patch(
      `${NOTION_API_BASE_URL}/pages/${pageId}`,
      {
        properties: {
          封面: {
            files: [
              {
                type: "file_upload",
                file_upload: { id: uploadId },
              },
            ],
          },
        },
      },
      { headers: fileHeaders(apiKey), timeout: 30000 }
    );
    return true;
  } catch (error: any) {
    const detail = error.response?.data
      ? JSON.stringify(error.response.data).substring(0, 300)
      : error.message;
    console.warn(`更新封面属性失败 ${pageId}: ${detail}`);
    return false;
  }
}
