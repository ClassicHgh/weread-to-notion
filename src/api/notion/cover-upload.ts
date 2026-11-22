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
 * 下载图片的二进制内容。
 * 由脚本侧（而不是 Notion 服务器）抓取，带上 Referer/UA 绕过微信读书防盗链，
 * 并跟随 parsecover 的 302 跳转到签名 COS 直链。
 */
async function downloadImageBytes(
  coverUrl: string
): Promise<{ data: Buffer; contentType: string } | null> {
  try {
    // 先解析出 parsecover 的真实签名直链（不跟随跳转，手动取 Location）
    const directUrl = await resolveDirectImageUrl(coverUrl);
    const resp = await axios.get(directUrl, {
      responseType: "arraybuffer",
      timeout: 30000,
      maxRedirects: 5,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Referer: "https://weread.qq.com/",
      },
    });
    const contentType = String(resp.headers["content-type"] || "image/jpeg");
    // COS 返回的 content-type 可能是 application/octet-stream，按图片处理
    const mime = contentType.startsWith("image/")
      ? contentType.split(";")[0]
      : "image/jpeg";
    return { data: Buffer.from(resp.data), contentType: mime };
  } catch (error: any) {
    console.warn(`下载封面图片失败 ${coverUrl}: ${error.message}`);
    return null;
  }
}

/**
 * 把图片 URL 导入为 Notion 原生文件，返回 file_upload id。
 *
 * 关键：改用 single_part 模式 —— 脚本侧先把图片下载成二进制，再通过
 * POST /file_uploads/{id}/send 把字节流传给 Notion。
 * 原先的 external_url 模式是让 Notion 服务器自己去抓微信读书的签名直链，
 * Notion 抓不到会报 400 "Failed to fetch the headers of the external URL"，
 * 尤其在 GitHub Actions 环境下 parsecover 的临时签名链接对外部请求不友好。
 */
export async function uploadCoverToNotion(
  apiKey: string,
  coverUrl: string
): Promise<string | null> {
  if (!coverUrl) return null;

  try {
    // 1. 脚本侧下载图片二进制（跟随 302、带 Referer/UA）
    const image = await downloadImageBytes(coverUrl);
    if (!image || image.data.length === 0) {
      console.warn(`封面图片为空，跳过: ${coverUrl}`);
      return null;
    }

    // 2. 用 single_part 模式创建一个上传会话
    const ext = image.contentType.split("/")[1] || "jpeg";
    const filename = `cover.${ext === "jpeg" ? "jpg" : ext}`;
    const createResp = await axios.post(
      `${NOTION_API_BASE_URL}/file_uploads`,
      {
        mode: "single_part",
        filename,
        content_type: image.contentType,
      },
      { headers: fileHeaders(apiKey), timeout: 30000 }
    );

    const uploadId = createResp.data?.id;
    if (!uploadId) return null;

    // 3. 把二进制上传到该会话（multipart/form-data，字段名固定为 file）
    const form = new FormData();
    form.append(
      "file",
      new Blob([image.data], { type: image.contentType }),
      filename
    );
    // send 端点需要 multipart 的 Content-Type（含 boundary），不能带 JSON 头
    const sendHeaders = {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": FILE_API_VERSION,
    };
    await axios.post(
      `${NOTION_API_BASE_URL}/file_uploads/${uploadId}/send`,
      form,
      { headers: sendHeaders, timeout: 60000 }
    );

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
