import { fetchWithTimeout } from './http.ts';

type AdminClient = {
  from: (table: string) => any;
  rpc: (name: string, params: Record<string, unknown>) => PromiseLike<{
    data?: unknown;
    error?: { message?: string } | null;
  }>;
};

export type EmailNotificationPayload = {
  to: string[];
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
};

type OutboxRow = {
  id: string;
  event_key: string;
  channel: 'email' | 'webhook';
  notification_type: string;
  payload: Record<string, unknown>;
  attempt_count: number;
};

const resendApiKey = String(Deno.env.get('RESEND_API_KEY') || '').trim();
const emailFromByType: Record<string, string> = {
  sale: String(Deno.env.get('SALE_NOTIFICATION_EMAIL_FROM') || '').trim(),
  offer: String(Deno.env.get('OFFER_NOTIFICATION_EMAIL_FROM') || '').trim(),
  inquiry: String(Deno.env.get('INQUIRY_NOTIFICATION_EMAIL_FROM') || '').trim()
};
const fallbackEmailFrom = emailFromByType.sale || emailFromByType.offer || emailFromByType.inquiry;
const notificationWebhookUrl = String(Deno.env.get('SALE_NOTIFICATION_WEBHOOK_URL') || '').trim();
const notificationWebhookSecret = String(Deno.env.get('SALE_NOTIFICATION_WEBHOOK_SECRET') || '').trim();

function senderFor(notificationType: string) {
  return emailFromByType[String(notificationType || '').trim().toLowerCase()] || fallbackEmailFrom;
}

async function insertOutbox(admin: AdminClient, row: Record<string, unknown>) {
  const { error } = await admin.from('notification_outbox').upsert(row, {
    onConflict: 'event_key,channel',
    ignoreDuplicates: true
  });
  if (error) throw new Error(`Notification outbox enqueue failed: ${error.message || 'unknown database error'}`);
}

export async function queueEmailNotification(
  admin: AdminClient,
  eventKey: string,
  notificationType: string,
  payload: EmailNotificationPayload
) {
  const recipients = payload.to.map((value) => String(value || '').trim()).filter(Boolean);
  if (!resendApiKey || !senderFor(notificationType) || !recipients.length) return false;
  await insertOutbox(admin, {
    event_key: eventKey,
    channel: 'email',
    notification_type: notificationType,
    payload: { ...payload, to: recipients },
    status: 'pending',
    next_attempt_at: new Date().toISOString()
  });
  return true;
}

export async function queueWebhookNotification(
  admin: AdminClient,
  eventKey: string,
  notificationType: string,
  payload: Record<string, unknown>
) {
  if (!notificationWebhookUrl) return false;
  await insertOutbox(admin, {
    event_key: eventKey,
    channel: 'webhook',
    notification_type: notificationType,
    payload,
    status: 'pending',
    next_attempt_at: new Date().toISOString()
  });
  return true;
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  idempotencyKey: string
) {
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey.slice(0, 200),
      ...headers
    },
    body: JSON.stringify(body)
  }, 12_000);
  if (response.ok) return;
  const detail = await response.text().catch(() => '');
  throw new Error(`Notification request failed (${response.status}): ${detail.slice(0, 400)}`);
}

async function deliver(row: OutboxRow) {
  if (row.channel === 'email') {
    const payload = row.payload as unknown as EmailNotificationPayload;
    const from = senderFor(row.notification_type);
    if (!resendApiKey || !from || !Array.isArray(payload.to) || !payload.to.length) {
      throw new Error('Email notification delivery is not configured.');
    }
    await postJson('https://api.resend.com/emails', {
      from,
      to: payload.to,
      subject: String(payload.subject || '').slice(0, 500),
      text: String(payload.text || ''),
      html: String(payload.html || ''),
      ...(payload.replyTo ? { reply_to: payload.replyTo } : {})
    }, { Authorization: `Bearer ${resendApiKey}` }, row.event_key);
    return;
  }
  if (!notificationWebhookUrl) throw new Error('Notification webhook delivery is not configured.');
  await postJson(notificationWebhookUrl, row.payload, notificationWebhookSecret
    ? { 'X-DJHC-Notification-Secret': notificationWebhookSecret }
    : {}, row.event_key);
}

export async function processNotificationOutbox(admin: AdminClient, limit = 25) {
  const workerToken = crypto.randomUUID();
  const { data, error } = await admin.rpc('claim_notification_outbox', {
    p_worker_token: workerToken,
    p_limit: Math.max(1, Math.min(100, Math.floor(limit))),
    p_lease_seconds: 120
  });
  if (error) throw new Error(`Notification outbox claim failed: ${error.message || 'unknown database error'}`);
  const rows = Array.isArray(data) ? data as OutboxRow[] : [];
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await deliver(row);
      const { data: completed, error: completeError } = await admin.rpc('complete_notification_outbox', {
        p_id: row.id,
        p_worker_token: workerToken
      });
      if (completeError) throw new Error(completeError.message || 'Could not complete notification outbox row.');
      if (completed !== true) throw new Error('Notification outbox lease was lost before completion.');
      sent += 1;
    } catch (deliveryError) {
      failed += 1;
      const retrySeconds = Math.min(86_400, 30 * (2 ** Math.min(10, Math.max(0, Number(row.attempt_count) - 1))));
      const { data: failureRecorded, error: failError } = await admin.rpc('fail_notification_outbox', {
        p_id: row.id,
        p_worker_token: workerToken,
        p_error: deliveryError instanceof Error ? deliveryError.message : String(deliveryError),
        p_retry_seconds: retrySeconds
      });
      if (failError) console.error('[notification-outbox] Could not persist failure', failError.message);
      else if (failureRecorded !== true) console.error('[notification-outbox] Failure lease was no longer owned', row.id);
    }
  }
  return { claimed: rows.length, sent, failed };
}
