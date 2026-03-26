/**
 * alerting-gateway.ts — 外部告警网关
 *
 * 支持通过环境变量配置 webhook URL，满足条件时向飞书/钉钉/通用 Webhook 推送告警。
 *
 * 环境变量：
 *   FEISHU_WEBHOOK_URL   飞书机器人 Webhook URL
 *   FEISHU_SECRET        飞书签名密钥（可选）
 *   DINGTALK_WEBHOOK_URL 钉钉机器人 Webhook URL
 *   DINGTALK_SECRET      钉钉加签密钥（可选）
 *   GENERIC_WEBHOOK_URL  通用 Webhook（POST JSON，可选）
 */

import * as crypto from 'crypto';
const { createLogger } = require('./logger');
const log = createLogger('AlertGW');

export interface AlertEvent {
  level: 'warning' | 'critical';
  title: string;
  content: string;
  nodeId?: string;
  service?: string;
  ts?: number;
}

/** 飞书 Bot 推送（sign 加签可选） */
async function sendFeishu(url: string, secret: string | undefined, event: AlertEvent) {
  const timestamp = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  // 飞书签名（timestamp + '\n' + secret 的 HMAC-SHA256）
  let sign: string | undefined;
  if (secret) {
    const str = `${timestamp}\n${secret}`;
    sign = crypto.createHmac('sha256', str).update(str).digest('base64');
  }

  const body: Record<string, unknown> = {
    msg_type: 'interactive',
    card: {
      header: {
        title: { tag: 'plain_text', content: `🚨 ${event.title}` },
        template: event.level === 'critical' ? 'red' : 'orange',
      },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: event.content },
        },
        {
          tag: 'note',
          elements: [
            {
              tag: 'plain_text',
              content: `节点: ${event.nodeId || '-'} | ${new Date(event.ts || Date.now()).toLocaleString('zh-CN')}`,
            },
          ],
        },
      ],
    },
  };

  if (sign) {
    (body as Record<string, unknown>).timestamp = String(timestamp);
    (body as Record<string, unknown>).sign = sign;
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });

  if (!resp.ok) throw new Error(`飞书推送失败: HTTP ${resp.status}`);
}

/** 钉钉 Bot 推送（sign 加签可选） */
async function sendDingtalk(url: string, secret: string | undefined, event: AlertEvent) {
  let fullUrl = url;

  if (secret) {
    const timestamp = Date.now();
    const str = `${timestamp}\n${secret}`;
    const sign = encodeURIComponent(
      crypto.createHmac('sha256', secret).update(str).digest('base64'),
    );
    fullUrl = `${url}&timestamp=${timestamp}&sign=${sign}`;
  }

  const body = {
    msgtype: 'markdown',
    markdown: {
      title: event.title,
      text: `## 🚨 ${event.title}\n\n${event.content}\n\n**节点:** ${event.nodeId || '-'}  \n**时间:** ${new Date(event.ts || Date.now()).toLocaleString('zh-CN')}`,
    },
  };

  const resp = await fetch(fullUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });

  if (!resp.ok) throw new Error(`钉钉推送失败: HTTP ${resp.status}`);
}

/** 通用 Webhook 推送（POST JSON） */
async function sendGeneric(url: string, event: AlertEvent) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...event, ts: event.ts || Date.now() }),
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`通用 Webhook 推送失败: HTTP ${resp.status}`);
}

class AlertingGateway {
  private feishuUrl: string | undefined;
  private feishuSecret: string | undefined;
  private dingtalkUrl: string | undefined;
  private dingtalkSecret: string | undefined;
  private genericUrl: string | undefined;

  constructor() {
    this.feishuUrl = process.env.FEISHU_WEBHOOK_URL;
    this.feishuSecret = process.env.FEISHU_SECRET;
    this.dingtalkUrl = process.env.DINGTALK_WEBHOOK_URL;
    this.dingtalkSecret = process.env.DINGTALK_SECRET;
    this.genericUrl = process.env.GENERIC_WEBHOOK_URL;

    const configured = [this.feishuUrl, this.dingtalkUrl, this.genericUrl].filter(Boolean).length;
    if (configured > 0) {
      log.info(`告警网关已启用 (${configured} 个渠道)`);
    } else {
      log.info('告警网关未配置（设置 FEISHU_WEBHOOK_URL / DINGTALK_WEBHOOK_URL 环境变量启用）');
    }
  }

  /** 发送告警到所有已配置渠道（并发，失败不阻塞） */
  async alert(event: AlertEvent): Promise<void> {
    const tasks: Promise<void>[] = [];

    if (this.feishuUrl) {
      tasks.push(
        sendFeishu(this.feishuUrl, this.feishuSecret, event)
          .then(() => log.info(`飞书告警已发送: ${event.title}`))
          .catch((e: Error) => log.error(`飞书推送失败: ${e.message}`)),
      );
    }

    if (this.dingtalkUrl) {
      tasks.push(
        sendDingtalk(this.dingtalkUrl, this.dingtalkSecret, event)
          .then(() => log.info(`钉钉告警已发送: ${event.title}`))
          .catch((e: Error) => log.error(`钉钉推送失败: ${e.message}`)),
      );
    }

    if (this.genericUrl) {
      tasks.push(
        sendGeneric(this.genericUrl, event)
          .then(() => log.info(`通用 Webhook 告警已发送: ${event.title}`))
          .catch((e: Error) => log.error(`通用 Webhook 推送失败: ${e.message}`)),
      );
    }

    await Promise.all(tasks);
  }

  /** 节点离线告警 */
  alertNodeOffline(nodeId: string, nodeName: string): void {
    void this.alert({
      level: 'warning',
      title: `节点下线: ${nodeName}`,
      content: `节点 **${nodeName}** (${nodeId}) 已失去心跳连接，当前状态: 离线 ⚠️`,
      nodeId,
      ts: Date.now(),
    });
  }

  /** 进程崩溃看门狗告警 */
  alertWatchdog(nodeId: string, service: string, reason: string, restarted: boolean): void {
    void this.alert({
      level: 'critical',
      title: `进程崩溃: ${service}@${nodeId}`,
      content: [
        `**服务:** ${service}`,
        `**原因:** ${reason}`,
        `**自动重启:** ${restarted ? '✅ 已重启' : '❌ 重启失败'}`,
      ].join('\n'),
      nodeId,
      service,
      ts: Date.now(),
    });
  }

  /** 资源阈值超限告警 */
  alertThreshold(nodeId: string, metric: string, value: number, threshold: number): void {
    void this.alert({
      level: 'warning',
      title: `资源告警: ${metric} ${value}%`,
      content: `节点 **${nodeId}** 的 ${metric} 使用率 **${value}%** 超过阈值 ${threshold}%`,
      nodeId,
      ts: Date.now(),
    });
  }

  /** 是否有任何渠道已配置 */
  get isConfigured(): boolean {
    return !!(this.feishuUrl || this.dingtalkUrl || this.genericUrl);
  }
}

// 单例导出
const alertingGateway = new AlertingGateway();
export default alertingGateway;
export { AlertingGateway };
