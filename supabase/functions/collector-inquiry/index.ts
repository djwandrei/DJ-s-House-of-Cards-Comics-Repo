import { createClient } from 'jsr:@supabase/supabase-js@2.105.1';
import {
  processNotificationOutbox,
  queueEmailNotification
} from '../_shared/notification-outbox.ts';
import { enforcePublicRateLimits } from '../_shared/request-security.ts';
import { readJsonBody } from '../_shared/http.ts';

const supabaseUrl = String(Deno.env.get('SUPABASE_URL') || '').trim();
const serviceRoleKey = String(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').trim();
const siteUrl = String(Deno.env.get('SITE_URL') || 'https://www.djshouseofcards-comics.com').replace(/\/+$/, '');
const notificationReplyTo = String(
  Deno.env.get('INQUIRY_NOTIFICATION_EMAIL_REPLY_TO') || Deno.env.get('SALE_NOTIFICATION_EMAIL_REPLY_TO') || ''
).trim();
const notificationRecipients = String(
  Deno.env.get('INQUIRY_NOTIFICATION_EMAIL_TO') || Deno.env.get('SALE_NOTIFICATION_EMAIL_TO') || ''
)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const uploadBucket = 'collector-inquiry-uploads';
const maxPhotos = 3;
const maxPhotoBytes = 6 * 1024 * 1024;
const maxTotalPhotoBytes = 6 * 1024 * 1024;
const maxRequestBodyBytes = 10 * 1024 * 1024;
const maxEncodedPhotoCharacters = Math.ceil(maxPhotoBytes / 3) * 4 + 4;
const supportedPhotoTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const supportedKinds = new Set(['contact', 'sell', 'trade', 'want_list', 'offer', 'bundle']);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

type InquiryPhoto = { name?: unknown; type?: unknown; data?: unknown };
type InquiryInput = {
  kind?: unknown;
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  preferredContact?: unknown;
  subject?: unknown;
  message?: unknown;
  offerAmount?: unknown;
  productIds?: unknown;
  sourcePath?: unknown;
  website?: unknown;
  photos?: unknown;
};

type PreparedPhoto = { path: string; bytes: Uint8Array; type: string };

const corsHeaders = {
  'Access-Control-Allow-Origin': siteUrl,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function safeText(value: unknown, limit: number) {
  return String(value ?? '').trim().slice(0, limit);
}

function allowedOrigin(request: Request) {
  const origin = String(request.headers.get('origin') || '').replace(/\/+$/, '');
  return !origin || origin === siteUrl;
}

function extensionFor(type: string) {
  if (type === 'image/png') return 'png';
  if (type === 'image/webp') return 'webp';
  return 'jpg';
}

function hasExpectedImageSignature(bytes: Uint8Array, type: string) {
  if (type === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (type === 'image/png') {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
  }
  if (type === 'image/webp') {
    return bytes.length >= 12
      && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
      && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  }
  return false;
}

function decodePhoto(photo: InquiryPhoto, inquiryId: string, index: number): PreparedPhoto {
  const type = safeText(photo.type, 80).toLowerCase();
  const rawData = String(photo.data || '').replace(/^data:[^;]+;base64,/i, '').trim();
  if (!supportedPhotoTypes.has(type) || !rawData) throw new Error('Use JPG, PNG, or WebP photos.');
  if (rawData.length > maxEncodedPhotoCharacters) throw new Error('Each photo must be 6 MB or smaller.');
  if (!/^[A-Za-z0-9+/=]+$/.test(rawData)) throw new Error('One photo could not be read.');

  let binary = '';
  try {
    binary = atob(rawData);
  } catch {
    throw new Error('One photo could not be read.');
  }
  if (!binary.length || binary.length > maxPhotoBytes) throw new Error('Each photo must be 6 MB or smaller.');
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (!hasExpectedImageSignature(bytes, type)) throw new Error('One attachment does not match its image type.');
  return {
    bytes,
    type,
    path: `${inquiryId}/${String(index + 1).padStart(2, '0')}-${crypto.randomUUID()}.${extensionFor(type)}`
  };
}

function normalizedProductIds(value: unknown) {
  const ids = Array.isArray(value) ? value : [];
  const unique = [...new Set(ids.map((id) => Number(id)).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (unique.length > 20) throw new Error('Choose up to 20 listings for one inquiry.');
  return unique;
}

function normalizedAmount(value: unknown) {
  if (value === '' || value == null) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) throw new Error('Enter a valid offer amount.');
  return Math.round(amount * 100) / 100;
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function queueNotification(input: {
  id: string;
  kind: string;
  name: string;
  email: string;
  phone: string;
  preferredContact: string;
  subject: string;
  message: string;
  offerAmount: number | null;
  productIds: number[];
  sourcePath: string;
  photoUrls: string[];
}) {
  const subject = `[DJHC Inquiry] ${input.kind.replaceAll('_', ' ')} from ${input.name}`;
  const photoLines = input.photoUrls.map((url, index) => `Photo ${index + 1}: ${url}`);
  const text = [
    `Inquiry: ${input.kind}`,
    `Reference: ${input.id}`,
    `From: ${input.name} <${input.email}>`,
    input.phone ? `Phone: ${input.phone}` : '',
    input.preferredContact ? `Preferred contact: ${input.preferredContact}` : '',
    input.subject ? `Subject: ${input.subject}` : '',
    input.offerAmount != null ? `Offer: $${input.offerAmount.toFixed(2)}` : '',
    input.productIds.length ? `Listings: ${input.productIds.join(', ')}` : '',
    input.sourcePath ? `Page: ${input.sourcePath}` : '',
    `Review in Admin Inbox: ${siteUrl}/inbox.html`,
    '',
    input.message,
    ...(photoLines.length ? ['', ...photoLines] : [])
  ].filter(Boolean).join('\n');
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.45;color:#1f2933;">
      <h2 style="margin:0 0 12px;">New ${escapeHtml(input.kind.replaceAll('_', ' '))} inquiry</h2>
      <p style="margin:0 0 16px;">
        <strong>From:</strong> ${escapeHtml(input.name)} &lt;${escapeHtml(input.email)}&gt;<br>
        ${input.phone ? `<strong>Phone:</strong> ${escapeHtml(input.phone)}<br>` : ''}
        ${input.preferredContact ? `<strong>Preferred contact:</strong> ${escapeHtml(input.preferredContact)}<br>` : ''}
        ${input.subject ? `<strong>Subject:</strong> ${escapeHtml(input.subject)}<br>` : ''}
        ${input.offerAmount != null ? `<strong>Offer:</strong> $${escapeHtml(input.offerAmount.toFixed(2))}<br>` : ''}
        ${input.productIds.length ? `<strong>Listings:</strong> ${escapeHtml(input.productIds.join(', '))}<br>` : ''}
       ${input.sourcePath ? `<strong>Page:</strong> ${escapeHtml(input.sourcePath)}<br>` : ''}
       <strong>Reference:</strong> ${escapeHtml(input.id)}
      </p>
      <p style="white-space:pre-wrap;">${escapeHtml(input.message)}</p>
      ${input.photoUrls.length ? `<p>${input.photoUrls.map((url, index) => `<a href="${escapeHtml(url)}">Open photo ${index + 1}</a>`).join('<br>')}</p>` : ''}
      <p><a href="${escapeHtml(`${siteUrl}/inbox.html`)}">Open the Admin Inbox</a></p>
    </div>
  `;
  const queued = await queueEmailNotification(admin, `inquiry:${input.id}:owner`, 'inquiry', {
    to: notificationRecipients,
    subject,
    text,
    html,
    replyTo: input.email || notificationReplyTo || undefined
  });
  if (queued) {
    try {
      await processNotificationOutbox(admin, 10);
    } catch (error) {
      console.error('[collector-inquiry] Immediate notification processing failed', error);
    }
  }
  return { queued };
}

async function cleanupFailedInquiry(inquiryId: string, photoPaths: string[]) {
  if (photoPaths.length) {
    const { error } = await admin.storage.from(uploadBucket).remove(photoPaths);
    if (error) console.error('[collector-inquiry] Uploaded-photo cleanup failed', error.message);
  }
  const { error } = await admin.from('collector_inquiries').delete().eq('id', inquiryId);
  if (error) console.error('[collector-inquiry] Failed-inquiry cleanup failed', error.message);
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);
  if (!allowedOrigin(request)) return jsonResponse({ error: 'This request origin is not allowed.' }, 403);
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: 'Inquiry service is not configured.' }, 503);

  let input: InquiryInput;
  try {
    input = await readJsonBody<InquiryInput>(request, maxRequestBodyBytes);
  } catch {
    return jsonResponse({ error: 'Please submit the form again.' }, 400);
  }

  // Honeypot fields receive a successful-looking response without creating a record.
  if (safeText(input.website, 200)) return jsonResponse({ accepted: true }, 202);

  const kind = safeText(input.kind, 30).toLowerCase();
  const name = safeText(input.name, 120);
  const email = safeText(input.email, 254).toLowerCase();
  const phone = safeText(input.phone, 80);
  const preferredContact = safeText(input.preferredContact, 40);
  const subject = safeText(input.subject, 180);
  const message = safeText(input.message, 5000);
  const sourcePath = safeText(input.sourcePath, 300);
  if (!supportedKinds.has(kind) || name.length < 2 || !emailPattern.test(email) || message.length < 3) {
    return jsonResponse({ error: 'Please provide your name, a valid email address, and a message.' }, 400);
  }

  let productIds: number[];
  let offerAmount: number | null;
  let photos: InquiryPhoto[];
  const preparedPhotos: PreparedPhoto[] = [];
  try {
    productIds = normalizedProductIds(input.productIds);
    offerAmount = normalizedAmount(input.offerAmount);
    photos = Array.isArray(input.photos) ? input.photos.slice(0, maxPhotos) as InquiryPhoto[] : [];
    if (Array.isArray(input.photos) && input.photos.length > maxPhotos) throw new Error('Attach no more than three photos.');
    const uploadGroupId = crypto.randomUUID();
    for (let index = 0; index < photos.length; index += 1) {
      preparedPhotos.push(decodePhoto(photos[index], uploadGroupId, index));
    }
    const totalBytes = preparedPhotos.reduce((total, photo) => total + photo.bytes.length, 0);
    if (totalBytes > maxTotalPhotoBytes) throw new Error('Your combined photos must be 6 MB or smaller.');
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Invalid inquiry details.' }, 400);
  }

  let submissionFingerprint = '';
  try {
    const rateLimit = await enforcePublicRateLimits(admin, request, {
      scope: 'collector-inquiry',
      discriminator: email,
      perIpLimit: 12,
      perIdentityLimit: 5,
      windowSeconds: 3600
    });
    submissionFingerprint = rateLimit.identityFingerprint;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/wait before|rate limit|too many/i.test(message)) {
      return jsonResponse({ error: 'Please wait before submitting another request.' }, 429);
    }
    console.error('[collector-inquiry] Rate limit failed', message);
    return jsonResponse({ error: 'Your request could not be verified. Please try again.' }, 503);
  }
  const { data: inquiryId, error: inquiryError } = await admin.rpc('create_collector_inquiry', {
    p_fingerprint: submissionFingerprint,
    p_kind: kind,
    p_name: name,
    p_email: email,
    p_phone: phone,
    p_preferred_contact: preferredContact,
    p_subject: subject,
    p_message: message,
    p_offer_amount: offerAmount,
    p_product_ids: productIds,
    p_source_path: sourcePath,
    p_metadata: { photo_count: photos.length }
  });
  if (inquiryError || !inquiryId) {
    const message = String(inquiryError?.message || 'Could not save the inquiry.');
    const status = /wait before/i.test(message) ? 429 : 400;
    console.error('[collector-inquiry] Record creation failed', message);
    return jsonResponse({ error: status === 429 ? 'Please wait before submitting another request.' : 'Could not send your inquiry. Please try again.' }, status);
  }

  const photoPaths: string[] = [];
  for (const photo of preparedPhotos) {
    const { error: uploadError } = await admin.storage.from(uploadBucket).upload(photo.path, photo.bytes, {
      contentType: photo.type,
      upsert: false
    });
    if (uploadError) {
      console.error('[collector-inquiry] Photo upload failed', uploadError.message);
      await cleanupFailedInquiry(String(inquiryId), photoPaths);
      return jsonResponse({ error: 'One photo could not be uploaded. No partial inquiry was saved.' }, 503);
    }
    photoPaths.push(photo.path);
  }
  if (photoPaths.length) {
    const { error: photoUpdateError } = await admin.from('collector_inquiries').update({ photo_paths: photoPaths }).eq('id', inquiryId);
    if (photoUpdateError) {
      console.error('[collector-inquiry] Could not attach photo paths', photoUpdateError.message);
      await cleanupFailedInquiry(String(inquiryId), photoPaths);
      return jsonResponse({ error: 'Your photos could not be attached. No partial inquiry was saved.' }, 503);
    }
  }

  const { data: signedRows, error: signedError } = photoPaths.length
    ? await admin.storage.from(uploadBucket).createSignedUrls(photoPaths, 7 * 24 * 60 * 60)
    : { data: [], error: null };
  if (signedError) console.error('[collector-inquiry] Photo URL signing failed', signedError.message);
  const photoUrls = (signedRows || []).map((row) => row.signedUrl || '').filter(Boolean);

  let notification = { queued: false };
  try {
    notification = await queueNotification({
      id: String(inquiryId), kind, name, email, phone, preferredContact,
      subject, message, offerAmount, productIds, sourcePath, photoUrls
    });
  } catch (error) {
    // The inquiry and any photos are already durable and visible in the admin
    // inbox. Do not tell the shopper the submission failed and invite a
    // duplicate merely because notification enqueueing was temporarily down.
    console.error('[collector-inquiry] Notification enqueue failed', error);
  }

  return jsonResponse({ accepted: true, notification: { queued: notification.queued } }, 201);
});
