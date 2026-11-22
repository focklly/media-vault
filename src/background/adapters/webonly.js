/**
 * 网页上传型站点（占位适配器）
 *
 * 只登记那些「确实有服务、但扩展拿不到可用直传通道」的站点：
 * - supports 为空 → 不参与自动上传路由，也不会出现在默认站点下拉里；
 * - webOnly: true → 设置页只显示「打开站点」按钮，并写明限制。
 * 将来若拿到官方直传接口，把它换成真正的 adapter 即可（见 docs/DEVELOPER_GUIDE.md）。
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
      return { ok: false, message: '该站点没有可用的直传接口，只能在网页里上传' };
    },
    async upload() {
      throw new Error(`「${label}」只支持网页上传：点卡片上的「打开站点」在网页里拖入文件`);
    },
  };
}

export const webOnlyAdapters = [
  webOnly({
    id: 'hippovideo',
    label: 'Hippo Video',
    badge: '网页上传·需企业授权',
    summary: '企业级视频平台（免费版 50 条/月）。上传 API 走企业账号的 OAuth 应用授权，个人版拿不到密钥。',
    openUrl: 'https://www.hippovideo.io/',
    note: '官方 API（developer.hippovideo.io）属于企业 SDK：需要 client_id / client_secret 换 access_token，还要在后台建应用与项目，不适合个人免注册直传。',
    docs: 'docs/ADAPTERS.md#hippovideo',
  }),
];
