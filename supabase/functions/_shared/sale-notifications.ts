import {
  processNotificationOutbox,
  queueEmailNotification,
  queueWebhookNotification
} from './notification-outbox.ts';

export type SaleNotificationItem = {
  productId?: number | string | null;
  name: string;
  quantity?: number | null;
  unitAmount?: number | null;
  priceLabel?: string | null;
  sku?: string | null;
  category?: string | null;
  image?: string | null;
};

export type SaleNotification = {
  provider: string;
  eventId: string;
  platformOrderId?: string | number | null;
  status?: string | null;
  buyerEmail?: string | null;
  amountTotal?: number | null;
  currency?: string | null;
  occurredAt?: string | null;
  orderUrl?: string | null;
  dashboardUrl?: string | null;
  items: SaleNotificationItem[];
  metadata?: Record<string, unknown>;
};

const notificationReplyTo = String(Deno.env.get('SALE_NOTIFICATION_EMAIL_REPLY_TO') || '').trim();
const subjectPrefix = String(Deno.env.get('SALE_NOTIFICATION_SUBJECT_PREFIX') || 'DJHC Sale').trim();
const notificationRecipients = String(
  Deno.env.get('SALE_NOTIFICATION_EMAIL_TO') || ''
)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const HTML_ESCAPE_PATTERN = /[&<>"']/g;
const HTML_ESCAPE_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};
const currencyFormatters = new Map<string, Intl.NumberFormat>();

function escapeHtml(value: unknown) {
  return String(value ?? '').replace(HTML_ESCAPE_PATTERN, (character) => HTML_ESCAPE_ENTITIES[character]);
}

function normalizedCurrency(value?: string | null) {
  return String(value || 'usd').trim().toUpperCase() || 'USD';
}

function formatMoney(cents?: number | null, currency?: string | null) {
  const amount = Number(cents);
  if (!Number.isFinite(amount)) return '';
  const normalized = normalizedCurrency(currency);
  try {
    let formatter = currencyFormatters.get(normalized);
    if (!formatter) {
      formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: normalized });
      currencyFormatters.set(normalized, formatter);
    }
    return formatter.format(amount / 100);
  } catch {
    return `$${(amount / 100).toFixed(2)}`;
  }
}

function itemLine(item: SaleNotificationItem) {
  const quantity = Math.max(1, Number(item.quantity) || 1);
  const id = item.productId ? ` #${item.productId}` : '';
  const price = formatMoney(item.unitAmount, 'usd') || item.priceLabel || '';
  return `${quantity}x${id} ${item.name}${price ? ` (${price})` : ''}`;
}

export function subjectFor(notification: SaleNotification) {
  const platform = notification.provider || 'Marketplace';
  const total = formatMoney(notification.amountTotal, notification.currency);
  const itemCount = notification.items.reduce((sum, item) => sum + Math.max(1, Number(item.quantity) || 1), 0);
  const order = notification.platformOrderId ? ` ${notification.platformOrderId}` : '';
  return `[${subjectPrefix}] ${platform}${order} sold ${itemCount} item${itemCount === 1 ? '' : 's'}${total ? ` - ${total}` : ''}`;
}

export function textBody(notification: SaleNotification) {
  const total = formatMoney(notification.amountTotal, notification.currency);
  const lines = [
    `${notification.provider || 'Marketplace'} sale received`,
    notification.platformOrderId ? `Order: ${notification.platformOrderId}` : '',
    notification.status ? `Status: ${notification.status}` : '',
    notification.buyerEmail ? `Buyer: ${notification.buyerEmail}` : '',
    total
      ? `Total: ${total}`
      : '',
    notification.occurredAt ? `When: ${notification.occurredAt}` : '',
    '',
    'Items:',
    ...notification.items.map((item) => `- ${itemLine(item)}`),
    notification.orderUrl ? `\nOrder URL: ${notification.orderUrl}` : '',
    notification.dashboardUrl ? `Dashboard URL: ${notification.dashboardUrl}` : ''
  ].filter((line) => line !== '');
  return lines.join('\n');
}

export function htmlBody(notification: SaleNotification) {
  const total = formatMoney(notification.amountTotal, notification.currency);
  const rows = notification.items.map((item) => `
    <tr>
      <td style="padding:8px;border-top:1px solid #ddd;">${escapeHtml(item.productId || '')}</td>
      <td style="padding:8px;border-top:1px solid #ddd;">${escapeHtml(item.name)}</td>
      <td style="padding:8px;border-top:1px solid #ddd;text-align:center;">${escapeHtml(Math.max(1, Number(item.quantity) || 1))}</td>
      <td style="padding:8px;border-top:1px solid #ddd;">${escapeHtml(formatMoney(item.unitAmount, notification.currency) || item.priceLabel || '')}</td>
    </tr>
  `).join('');
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.45;color:#1f2933;">
      <h2 style="margin:0 0 12px;">${escapeHtml(notification.provider || 'Marketplace')} sale received</h2>
      <p style="margin:0 0 16px;">
        ${notification.platformOrderId ? `<strong>Order:</strong> ${escapeHtml(notification.platformOrderId)}<br>` : ''}
        ${notification.status ? `<strong>Status:</strong> ${escapeHtml(notification.status)}<br>` : ''}
        ${notification.buyerEmail ? `<strong>Buyer:</strong> ${escapeHtml(notification.buyerEmail)}<br>` : ''}
        ${total ? `<strong>Total:</strong> ${escapeHtml(total)}<br>` : ''}
        ${notification.occurredAt ? `<strong>When:</strong> ${escapeHtml(notification.occurredAt)}<br>` : ''}
      </p>
      <table style="border-collapse:collapse;width:100%;max-width:760px;">
        <thead>
          <tr>
            <th style="padding:8px;text-align:left;">Listing</th>
            <th style="padding:8px;text-align:left;">Item</th>
            <th style="padding:8px;text-align:center;">Qty</th>
            <th style="padding:8px;text-align:left;">Price</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${notification.orderUrl ? `<p><a href="${escapeHtml(notification.orderUrl)}">Open order</a></p>` : ''}
      ${notification.dashboardUrl ? `<p><a href="${escapeHtml(notification.dashboardUrl)}">Open dashboard record</a></p>` : ''}
    </div>
  `;
}

export async function queueSaleNotification(admin: any, notification: SaleNotification) {
  const providerKey = String(notification.provider || 'marketplace').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const eventKey = `sale:${providerKey}:${notification.eventId}`;
  const [emailQueued, webhookQueued] = await Promise.all([
    queueEmailNotification(admin, eventKey, 'sale', {
      to: notificationRecipients,
      subject: subjectFor(notification),
      text: textBody(notification),
      html: htmlBody(notification),
      ...(notificationReplyTo ? { replyTo: notificationReplyTo } : {})
    }),
    queueWebhookNotification(admin, eventKey, 'sale', {
      type: 'sale_notification',
      notification
    })
  ]);
  let processing = { claimed: 0, sent: 0, failed: 0 };
  if (emailQueued || webhookQueued) {
    try {
      processing = await processNotificationOutbox(admin, 10);
    } catch (error) {
      console.error('[sale-notifications] Immediate outbox processing failed', error);
    }
  }
  return { queued: emailQueued || webhookQueued, emailQueued, webhookQueued, processing };
}
