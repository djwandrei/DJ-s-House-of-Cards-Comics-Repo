import {
  isShopifyConfigured,
  shopifyRest,
  shopifyShopDomain
} from '../_shared/shopify.ts';

const serviceRoleKey = String(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').trim();
const THEME_LAYOUT_KEY = 'layout/theme.liquid';
const DEFAULT_STYLE_ASSET_KEY = 'assets/djhc-custom.css';
const DEFAULT_STYLE_MARKER = 'djhc-custom.css';
const DEFAULT_STYLE_TAG = "{{ 'djhc-custom.css' | asset_url | stylesheet_tag }}";
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

type Theme = {
  id: number | string;
  name?: string;
  role?: string;
};

type ThemePayload = {
  themes?: Theme[];
};

type AssetPayload = {
  asset?: {
    key?: string;
    value?: string;
  };
};

type ThemeRequest = {
  action?: string;
  css?: string;
  inspectKeys?: string[];
  styleAssetKey?: string;
  styleMarker?: string;
  styleTag?: string;
  themeId?: string | number;
  includeLayoutBackup?: boolean;
  logo?: {
    assetKey?: string;
    attachment?: string;
  } | null;
  themeAssets?: Array<{
    key?: string;
    value?: string;
  }>;
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String((error as { message?: string })?.message || error || '');
}

function bearerToken(request: Request) {
  return String(request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
}

function requireServiceRole(request: Request) {
  if (!serviceRoleKey || bearerToken(request) !== serviceRoleKey) {
    throw new Error('Service role authorization is required.');
  }
}

function cleanAssetKey(value: unknown, fallback: string) {
  const key = String(value || fallback).trim();
  if (!/^assets\/[A-Za-z0-9._-]+$/.test(key)) throw new Error(`Invalid Shopify asset key: ${key}`);
  return key;
}

function cleanReadableThemeKey(value: unknown) {
  const key = String(value || '').trim();
  if (!/^(?:config|layout|sections|templates)\/[A-Za-z0-9._\/-]+\.(?:json|liquid)$/.test(key)) {
    throw new Error(`Invalid readable theme asset key: ${key}`);
  }
  return key;
}

function cleanWritableJsonThemeKey(value: unknown) {
  const key = String(value || '').trim();
  if (!/^(?:config|sections|templates)\/[A-Za-z0-9._\/-]+\.json$/.test(key)) {
    throw new Error(`Invalid writable theme JSON key: ${key}`);
  }
  return key;
}

function injectStylesheet(layoutLiquid: string, styleMarker: string, styleTag: string) {
  if (layoutLiquid.includes(styleMarker)) {
    return { value: layoutLiquid, changed: false };
  }
  const injection = [
    '  {% comment %} DJHC custom storefront styling injected by Codex. {% endcomment %}',
    `  ${styleTag}`
  ].join('\n');
  if (layoutLiquid.includes('</head>')) {
    return {
      value: layoutLiquid.replace('</head>', `${injection}\n</head>`),
      changed: true
    };
  }
  return { value: `${layoutLiquid.trimEnd()}\n${injection}\n`, changed: true };
}

async function getMainTheme(themeId?: string | number) {
  const payload = await shopifyRest<ThemePayload>('GET', 'themes.json');
  const themes = Array.isArray(payload.themes) ? payload.themes : [];
  if (!themes.length) throw new Error('No Shopify themes were returned for this store.');
  if (themeId) {
    const selected = themes.find((theme) => String(theme.id) === String(themeId));
    if (!selected) throw new Error(`Theme id ${themeId} was not found.`);
    return selected;
  }
  return themes.find((theme) => theme.role === 'main') || themes[0];
}

async function getThemeAsset(themeId: string | number, key: string) {
  const params = new URLSearchParams({ 'asset[key]': key });
  const payload = await shopifyRest<AssetPayload>('GET', `themes/${themeId}/assets.json?${params}`);
  const value = payload.asset?.value;
  if (!value) throw new Error(`Theme asset ${key} did not return editable text.`);
  return value;
}

async function putThemeAsset(themeId: string | number, asset: Record<string, unknown>) {
  await shopifyRest('PUT', `themes/${themeId}/assets.json`, { asset });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405);

  try {
    requireServiceRole(request);
    if (!isShopifyConfigured()) throw new Error('Shopify Admin API is not configured.');

    const body = await request.json().catch(() => ({})) as ThemeRequest;
    const action = String(body.action || 'plan').trim().toLowerCase();
    if (!['plan', 'apply', 'inspect'].includes(action)) throw new Error('Action must be plan, apply, or inspect.');

    const theme = await getMainTheme(body.themeId);
    if (action === 'inspect') {
      const keys = Array.isArray(body.inspectKeys) ? body.inspectKeys.slice(0, 12).map(cleanReadableThemeKey) : [];
      if (!keys.length) throw new Error('Provide at least one inspectKeys entry.');
      const assets: Record<string, string> = {};
      for (const key of keys) {
        assets[key] = await getThemeAsset(theme.id, key);
      }
      return jsonResponse({
        ok: true,
        action,
        shopDomain: shopifyShopDomain(),
        theme: {
          id: theme.id,
          name: theme.name || '',
          role: theme.role || ''
        },
        assets
      });
    }

    const css = String(body.css || '').trim();
    const shouldApplyStyles = Boolean(css);
    if (shouldApplyStyles && !css.includes('--djhc-blue')) {
      throw new Error('Theme CSS payload is missing the DJHC brand layer.');
    }

    const styleAssetKey = shouldApplyStyles ? cleanAssetKey(body.styleAssetKey, DEFAULT_STYLE_ASSET_KEY) : null;
    const styleMarker = String(body.styleMarker || DEFAULT_STYLE_MARKER).trim() || DEFAULT_STYLE_MARKER;
    const styleTag = String(body.styleTag || DEFAULT_STYLE_TAG).trim() || DEFAULT_STYLE_TAG;
    const logoAssetKey = body.logo ? cleanAssetKey(body.logo.assetKey, 'assets/dj-logo.png') : null;
    const logoAttachment = String(body.logo?.attachment || '').trim();
    const themeAssets = Array.isArray(body.themeAssets)
      ? body.themeAssets.slice(0, 8).map((asset) => {
        const key = cleanWritableJsonThemeKey(asset?.key);
        const value = String(asset?.value || '').trim();
        if (!value) throw new Error(`Theme asset ${key} is empty.`);
        JSON.parse(value);
        return { key, value };
      })
      : [];

    if (!shouldApplyStyles && !themeAssets.length && !logoAssetKey) {
      throw new Error('Provide CSS, a logo asset, or themeAssets to apply.');
    }

    const layoutLiquid = shouldApplyStyles ? await getThemeAsset(theme.id, THEME_LAYOUT_KEY) : '';
    const injection = shouldApplyStyles
      ? injectStylesheet(layoutLiquid, styleMarker, styleTag)
      : { value: layoutLiquid, changed: false };

    const summary: Record<string, unknown> = {
      ok: true,
      action,
      shopDomain: shopifyShopDomain(),
      theme: {
        id: theme.id,
        name: theme.name || '',
        role: theme.role || ''
      },
      changes: {
        stylesheetAsset: styleAssetKey,
        layoutNeedsStylesheetTag: shouldApplyStyles ? injection.changed : false,
        logoAsset: logoAssetKey,
        themeAssets: themeAssets.map((asset) => asset.key)
      }
    };

    if (action === 'apply') {
      if (shouldApplyStyles && styleAssetKey) {
        await putThemeAsset(theme.id, {
          key: styleAssetKey,
          value: css
        });
        if (injection.changed) {
          await putThemeAsset(theme.id, {
            key: THEME_LAYOUT_KEY,
            value: injection.value
          });
        }
      }
      if (logoAssetKey && logoAttachment) {
        await putThemeAsset(theme.id, {
          key: logoAssetKey,
          attachment: logoAttachment
        });
      }
      for (const asset of themeAssets) {
        await putThemeAsset(theme.id, {
          key: asset.key,
          value: asset.value
        });
      }
      summary.applied = {
        stylesheetAsset: shouldApplyStyles,
        layoutStylesheetTag: shouldApplyStyles ? (injection.changed ? 'inserted' : 'already-present') : 'not-requested',
        logoAsset: Boolean(logoAssetKey && logoAttachment),
        themeAssets: themeAssets.map((asset) => asset.key)
      };
      if (body.includeLayoutBackup) summary.layoutBackup = layoutLiquid;
    }

    return jsonResponse(summary);
  } catch (error) {
    console.error('[shopify-theme-apply]', error);
    return jsonResponse({ ok: false, error: errorMessage(error) || 'Shopify theme update failed.' }, 500);
  }
});
