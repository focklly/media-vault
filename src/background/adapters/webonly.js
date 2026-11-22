/**
 * 网页上传型站点（占位适配器）
 *
 * 这三个站点在用户提供的「沙箱实测可达」清单里，但都没有可被扩展直接调用的
 * 公开直传接口（或被 Cloudflare 前置拦截 / 需要企业账号授权），所以这里不做
 * 假直传，而是登记成「上传目标」里可跳转的入口：
 * - supports 为空 → 不参与自动上传路由，也不会出现在默认站点下拉里；
 * - webOnly: true → 设置页只显示「打开站点」按钮，并写明限制。
 * 将来若拿到官方直传接口，把它们换成真正的 adapter 即可（见 docs/DEVELOPER_GUIDE.md）。
 */

function webOnly({ id, label, badge, summary, openUrl, note, docs }) {
  return {
    id,
    label,
    badge,
    summary,
    openUrl,
    note,
    docs,
    webOnly: true,
    supports: [],
    maxBytes: Infinity,
    fields: [],
    isConfigured() {
      return true;
    },
    async test() {
      return { ok: false, message: '该站点仅支持网页上传，扩展无法自动直传' };
    },
    async upload() {
      throw new Error(`「${label}」只支持网页上传：点卡片上的「打开站点」在网页里拖入文件`);
    },
  };
}

export const webOnlyAdapters = [
  webOnly({
    id: 'imgpile',
    label: 'ImgPile',
    badge: '网页上传·免注册',
    summary: '免注册，图片+视频，单文件约 97MB；给直链与 BBCode，长期无人访问会被回收。',
    openUrl: 'https://imgpile.com/upload',
    note: '站点未公开直传 API，上传走它自己的网页流程（浏览器里 PUT 到签名地址）；免费图会被转 WebP 并压到长边 2048px。',
    docs: 'docs/ADAPTERS.md#imgpile',
  }),
  webOnly({
    id: 'yourimageshare',
    label: 'YourImageShare',
    badge: '网页上传·免注册',
    summary: '免注册，图片+视频，单文件 ≤200MB，格式覆盖 MP4/MKV/MOV/WEBM 等。',
    openUrl: 'https://yourimageshare.com/',
    note: '站点号称有 key 型 JSON REST API（上传/列表/删除），但端点未公开、文档需登录，暂按网页上传处理。',
    docs: 'docs/ADAPTERS.md#yourimageshare',
  }),
  webOnly({
    id: 'hippovideo',
    label: 'Hippo Video',
    badge: '网页上传·需账号',
    summary: '企业级视频平台，免费版 50 条/月；上传需要账号与应用授权，接入成本较高。',
    openUrl: 'https://hippovideo.io/',
    note: '官方 Import/Upload API 需要账号 + 应用授权（OAuth/Token），不适合免注册直传；大文件建议直接用 S3 或 Unlockify。',
    docs: 'docs/ADAPTERS.md#hippovideo',
  }),
];
