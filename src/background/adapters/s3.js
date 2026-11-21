/**
 * 适配器：S3 兼容对象存储（Cloudflare R2 / MinIO / 阿里云 OSS / 七牛 / B2）
 *
 * 使用 AWS Signature V4 直接 PUT 对象，无需后端中转。
 * 免费额度参考：Cloudflare R2 免费 10GB 存储 + 无出网流量费，最适合放视频。
 *
 * 注意：必须给桶配置 CORS（AllowedOrigins 包含 chrome-extension://* 或具体扩展 ID），
 * 否则预检请求会被拒绝。扩展携带 host_permissions 时可绕过 CORS，但部分服务端
 * 仍会因签名/Host 不匹配报错，配置步骤见 docs/ADAPTERS.md。
 */

import { encodePath, joinPath, normalizePrefix, sha256Hex, hmac, arrayBufferToHex, uniqueFileName } from '../../shared/utils.js';

export default {
  id: 's3',
  label: 'S3 兼容存储',
  badge: '推荐放视频',
  supports: ['image', 'video'],
  maxBytes: Infinity,
  summary: '兼容 Cloudflare R2、MinIO、阿里云 OSS、七牛、Backblaze B2；大视频首选，R2 免费 10GB。',
  docs: 'docs/ADAPTERS.md#s3-兼容对象存储',
  fields: [
    { key: 'endpoint', label: 'Endpoint', type: 'text', placeholder: 'https://<accountid>.r2.cloudflarestorage.com', required: true, help: '只填到域名，不要带桶名；MinIO 形如 http://127.0.0.1:9000。' },
    { key: 'region', label: 'Region', type: 'text', placeholder: 'auto', required: false, help: 'R2 填 auto；AWS/OSS 填实际区域，如 us-east-1、oss-cn-hangzhou。' },
    { key: 'bucket', label: 'Bucket', type: 'text', placeholder: 'media', required: true },
    { key: 'accessKey', label: 'Access Key ID', type: 'password', required: true },
    { key: 'secretKey', label: 'Secret Access Key', type: 'password', required: true },
    { key: 'pathPrefix', label: '存储目录', type: 'text', placeholder: 'media/', required: false },
    { key: 'publicBase', label: '公开访问域名', type: 'text', placeholder: 'https://pub-xxx.r2.dev 或自定义 CDN 域名', required: false, help: '留空则用 Endpoint 拼接（私有桶不可公开访问）。' },
    { key: 'forcePathStyle', label: 'Path-Style 访问', type: 'boolean', required: false, help: 'R2/MinIO 选 true；OSS/七牛选 false（虚拟主机风格）。' },
  ],

  isConfigured(config) {
    return Boolean(config && config.endpoint && config.bucket && config.accessKey && config.secretKey);
  },

  async test(config) {
    // 用一次空对象 PUT 到测试 key，验证签名、权限与桶是否存在
    const key = joinPath(normalizePrefix(config.pathPrefix || ''), '.mediavault-test.txt');
    const res = await signedPut(config, key, new TextEncoder().encode(`mediavault ${new Date().toISOString()}`), 'text/plain');
    if (!res.ok) return { ok: false, message: `连接失败 ${res.status}：${await safeText(res)}` };
    return { ok: true, message: `连接正常，测试对象已写入 ${config.bucket}/${key}` };
  },

  async upload({ blob, fileName, config }) {
    const key = joinPath(normalizePrefix(config.pathPrefix || 'media/'), dateDir(), uniqueFileName(fileName));
    const res = await signedPut(config, key, blob, blob.type || 'application/octet-stream');
    if (!res.ok) throw new Error(`S3 上传失败 ${res.status}：${await safeText(res)}`);

    const publicBase = (config.publicBase || '').replace(/\/+$/, '');
    let url;
    if (publicBase) {
      url = `${publicBase}/${encodePath(key)}`;
    } else {
      const endpoint = config.endpoint.replace(/\/+$/, '');
      url = config.forcePathStyle === false
        ? `${endpoint}/${encodePath(key)}`
        : `${endpoint}/${config.bucket}/${encodePath(key)}`;
    }
    return {
      url,
      path: key,
      size: blob.size,
      /** 没有 publicBase 时链接可能不可公开访问，UI 会显示提示 */
      privateLink: !publicBase,
    };
  },
};

/* ------------------------- SigV4 签名 ------------------------- */

async function signedPut(config, key, body, contentType) {
  const endpoint = new URL(config.endpoint);
  const forcePath = config.forcePathStyle !== false;
  const host = forcePath ? endpoint.host : `${config.bucket}.${endpoint.host}`;
  const canonicalUri = forcePath
    ? `/${config.bucket}/${encodePath(key)}`
    : `/${encodePath(key)}`;
  const requestUrl = `${endpoint.protocol}//${host}${canonicalUri}`;

  const payload = typeof body === 'string' || body instanceof Uint8Array
    ? body
    : await body.arrayBuffer();
  const payloadHash = await sha256Hex(payload);

  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const region = config.region || 'auto';
  const service = 's3';

  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    'PUT',
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');

  const kDate = await hmac(`AWS4${config.secretKey}`, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = arrayBufferToHex(await hmac(kSigning, stringToSign));

  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return fetch(requestUrl, {
    method: 'PUT',
    headers: {
      Authorization: authorization,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'Content-Type': contentType,
    },
    body,
  });
}

function dateDir() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/`;
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 200);
  } catch (_) {
    return '';
  }
}
