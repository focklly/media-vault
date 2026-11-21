/**
 * 消息通道封装
 *
 * 两条通道：
 * 1) sendMessage：一次性短请求（查状态、打开页面、触发扫描），毫秒级返回。
 * 2) 端口通道 runTask：耗时任务（下载媒体、上传外部存储）。MV3 的 service worker
 *    空闲 30 秒会被回收，而端口连接期间不会被回收；同时客户端每 20 秒发一次心跳，
 *    长任务（大视频上传）不会被中断。
 */

import { PORT_NAME, PORT_MSG } from './constants.js';

export function sendMessage(type, payload = {}) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(res || { ok: true });
      });
    } catch (err) {
      resolve({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  });
}

export function sendToTab(tabId, type, payload = {}) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type, payload }, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(res || { ok: true });
      });
    } catch (err) {
      resolve({ ok: false, error: String(err) });
    }
  });
}

/**
 * 执行长任务
 * @param {string} type TASK 中的类型
 * @param {object} payload
 * @param {(info:{done:number,total:number,message?:string}) => void} onProgress
 * @param {number} timeoutMs 默认 15 分钟
 */
export function runTask(type, payload = {}, onProgress = null, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
    } catch (err) {
      reject(new Error('无法连接后台服务，请确认扩展已启用'));
      return;
    }

    let settled = false;
    const heartbeat = setInterval(() => {
      try {
        port.postMessage({ type: 'ping' });
      } catch (_) { /* 端口已关闭 */ }
    }, 20000);

    const timer = setTimeout(() => {
      finish(new Error('任务超时，请稍后重试'));
    }, timeoutMs);

    function finish(err, result) {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      clearTimeout(timer);
      try { port.disconnect(); } catch (_) { /* noop */ }
      if (err) reject(err);
      else resolve(result);
    }

    port.onMessage.addListener((msg) => {
      if (!msg || !msg.kind) return;
      if (msg.kind === PORT_MSG.PROGRESS) {
        if (onProgress) onProgress(msg.payload || {});
      } else if (msg.kind === PORT_MSG.DONE) {
        finish(null, msg.payload);
      } else if (msg.kind === PORT_MSG.ERROR) {
        finish(new Error((msg.payload && msg.payload.message) || '后台任务失败'));
      }
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      if (!settled) finish(new Error(err?.message || '后台连接已断开'));
    });

    port.postMessage({ kind: PORT_MSG.REQUEST, type, payload });
  });
}
