const DEFAULT_LIMITS = {
    maxUpstreamUrls: 8,
    upstreamConcurrency: 3,
    maxUpstreamBytes: 5 * 1024 * 1024,
    maxConfigBytes: 256 * 1024,
    maxPostBytes: 1024 * 1024,
    upstreamTimeoutMs: 10000,
    dnsTimeoutMs: 3000,
    maxUpstreamRedirects: 5,
};

const SAFE_EXTRA_PARAMS = new Set([
    'config',
    'emoji',
    'fdn',
    'insert',
    'list',
    'new_name',
    'scv',
    'sort',
    'tfo',
    'udp',
    'ver',
]);

const EXACT_TARGETS = new Map([
    ['Clash', 'Clash'],
    ['ClashMeta', 'ClashMeta'],
    ['Egern', 'Egern'],
    ['Loon', 'Loon'],
    ['Mihomo', 'Mihomo'],
    ['QX', 'QX'],
    ['QuantumultX', 'QuantumultX'],
    ['ShadowRocket', 'ShadowRocket'],
    ['Shadowrocket', 'Shadowrocket'],
    ['Stash', 'Stash'],
    ['Surfboard', 'Surfboard'],
    ['Surge', 'Surge'],
    ['SurgeMac', 'SurgeMac'],
    ['URI', 'URI'],
    ['V2Ray', 'V2Ray'],
    ['json', 'json'],
    ['uri', 'uri'],
    ['v2ray', 'v2ray'],
]);

const WEAK_SECRET_VALUES = new Set([
    '123456',
    'admin',
    'changeme',
    'default',
    'minisubconvert',
    'password',
    'secret',
    'test',
]);

const MIN_SECRET_LENGTH = 16;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class ClientError extends Error {
    constructor(status, code, message = code) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

export function createRuntimeConfig(env = {}) {
    return {
        secret: readSecret(env.SECRET),
        maxUpstreamUrls: readPositiveInteger(
            env.MAX_UPSTREAM_URLS,
            DEFAULT_LIMITS.maxUpstreamUrls,
        ),
        upstreamConcurrency: readPositiveInteger(
            env.MAX_UPSTREAM_CONCURRENCY,
            DEFAULT_LIMITS.upstreamConcurrency,
        ),
        maxUpstreamBytes: readPositiveInteger(
            env.MAX_UPSTREAM_BYTES,
            DEFAULT_LIMITS.maxUpstreamBytes,
        ),
        maxConfigBytes: readPositiveInteger(
            env.MAX_CONFIG_BYTES,
            DEFAULT_LIMITS.maxConfigBytes,
        ),
        maxPostBytes: readPositiveInteger(
            env.MAX_POST_BYTES,
            DEFAULT_LIMITS.maxPostBytes,
        ),
        upstreamTimeoutMs: readPositiveInteger(
            env.UPSTREAM_TIMEOUT_MS,
            DEFAULT_LIMITS.upstreamTimeoutMs,
        ),
        dnsTimeoutMs: readPositiveInteger(
            env.DNS_TIMEOUT_MS,
            DEFAULT_LIMITS.dnsTimeoutMs,
        ),
        maxUpstreamRedirects: readPositiveInteger(
            env.MAX_UPSTREAM_REDIRECTS,
            DEFAULT_LIMITS.maxUpstreamRedirects,
        ),
        disableDnsGuard: env.DISABLE_DNS_GUARD === 'true',
    };
}

export function isAuthorizedPath(method, pathname, secret) {
    if (!secret) return false;
    return (
        (method === 'POST' && pathname === `/${secret}/api/proxy/parse`) ||
        (method === 'GET' && pathname === `/${secret}/sub`)
    );
}

export function normalizeTarget(rawTarget, _userAgent = '') {
    const target = `${rawTarget || ''}`.trim();
    const key = target.toLowerCase();

    if (!key) {
        throw new ClientError(400, 'missing_target', 'missing target');
    }

    if (target === 'Clash') {
        return 'Clash';
    }
    if (key === 'clash') {
        return 'mihomo';
    }

    const aliases = {
        clashmeta: 'mihomo',
        'clash.meta': 'mihomo',
        meta: 'mihomo',
        mihomo: 'mihomo',
        singbox: 'singbox',
        'sing-box': 'singbox',
        surge: 'surge',
        surgemac: 'SurgeMac',
        quanx: 'qx',
        qx: 'qx',
        quantumultx: 'QuantumultX',
        loon: 'Loon',
        mixed: 'v2ray',
        v2: 'v2ray',
        v2ray: 'v2ray',
        uri: 'uri',
        json: 'json',
        stash: 'stash',
        shadowrocket: 'shadowrocket',
        surfboard: 'surfboard',
        egern: 'egern',
    };

    const normalized = aliases[key] || EXACT_TARGETS.get(target);
    if (!normalized) {
        throw new ClientError(400, 'unsupported_target', 'unsupported target');
    }
    return normalized;
}

export function parseUpstreamUrls(rawUrls, config) {
    const urls = `${rawUrls || ''}`
        .split('|')
        .map((item) => item.trim())
        .filter(Boolean);

    if (urls.length === 0) {
        throw new ClientError(400, 'missing_url', 'missing url');
    }
    if (urls.length > config.maxUpstreamUrls) {
        throw new ClientError(400, 'too_many_upstreams', 'too many upstreams');
    }
    return urls;
}

export function logRequest(event, fields = {}) {
    const safeFields = {};
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined || value === null || value === '') continue;
        safeFields[key] = value;
    }
    console.log(JSON.stringify({ event, ...safeFields }));
}

export function createTextResponse(body, status = 200, headers = {}) {
    return new Response(body, {
        status,
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            ...headers,
        },
    });
}

export function createJsonResponse(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...headers,
        },
    });
}

export async function readWebRequestTextWithLimit(request, byteLimit) {
    if (!request.body) return '';
    return readWebStreamTextWithLimit(request.body, byteLimit);
}

export async function fetchSubscriptionTexts(urls, config, userAgent) {
    const results = await settleWithConcurrency(
        urls,
        Math.min(config.upstreamConcurrency, config.maxUpstreamUrls),
        (url) => fetchSubscriptionText(url, config, userAgent),
    );

    const texts = [];
    const failures = [];
    for (const result of results) {
        if (result.status === 'fulfilled') {
            texts.push(result.value);
        } else {
            failures.push(result.reason);
        }
    }

    if (texts.length === 0) {
        const firstClientError = failures.find((error) => error instanceof ClientError);
        if (firstClientError) throw firstClientError;
        throw new ClientError(502, 'all_upstreams_failed', 'upstream fetch failed');
    }

    return { texts, failureCount: failures.length };
}

export function normalizeSubscriptionText(rawText) {
    const text = `${rawText || ''}`;
    const decoded = decodeBase64Subscription(text);
    return decoded || text;
}

export async function fetchRemoteText(rawUrl, config, userAgent, byteLimit) {
    let url = await validateUpstreamUrl(rawUrl, config);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);

    try {
        for (let redirects = 0; redirects <= config.maxUpstreamRedirects; redirects += 1) {
            const response = await fetch(url.toString(), {
                headers: {
                    'User-Agent': userAgent || 'MiniSubConvert/Private',
                },
                redirect: 'manual',
                signal: controller.signal,
            });

            if (REDIRECT_STATUSES.has(response.status)) {
                if (redirects >= config.maxUpstreamRedirects) {
                    throw new ClientError(400, 'too_many_upstream_redirects', 'too many upstream redirects');
                }

                const location = response.headers.get('Location');
                if (!location) {
                    throw new ClientError(502, 'upstream_redirect_missing_location', 'upstream redirect missing location');
                }

                url = await validateUpstreamUrl(new URL(location, url).toString(), config);
                continue;
            }

            if (!response.ok) {
                throw new ClientError(502, 'upstream_bad_status', 'upstream fetch failed');
            }
            return await readWebStreamTextWithLimit(
                response.body,
                byteLimit || config.maxUpstreamBytes,
            );
        }
        throw new ClientError(400, 'too_many_upstream_redirects', 'too many upstream redirects');
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new ClientError(504, 'upstream_timeout', 'upstream fetch timed out');
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

export function getIgnoredCompatParams(searchParams) {
    const ignored = [];
    for (const key of searchParams.keys()) {
        if (SAFE_EXTRA_PARAMS.has(key)) ignored.push(key);
    }
    return [...new Set(ignored)];
}

export function safeErrorCode(error) {
    if (error instanceof ClientError) return error.code;
    return 'internal_error';
}

export function parseProxyParseRequest(rawBody) {
    let body;
    try {
        body = JSON.parse(rawBody || '{}');
    } catch {
        throw new ClientError(400, 'invalid_json', 'invalid json');
    }

    if (!body || typeof body !== 'object') {
        throw new ClientError(400, 'invalid_json', 'invalid json');
    }
    if (typeof body.data !== 'string' || !body.data.trim()) {
        throw new ClientError(400, 'missing_data', 'missing data');
    }
    if (typeof body.client !== 'string' || !body.client.trim()) {
        throw new ClientError(400, 'missing_target', 'missing target');
    }
    return body;
}

async function fetchSubscriptionText(rawUrl, config, userAgent) {
    const text = await fetchRemoteText(
        rawUrl,
        config,
        userAgent,
        config.maxUpstreamBytes,
    );
    return normalizeSubscriptionText(text);
}

async function settleWithConcurrency(items, concurrency, task) {
    const limit = Math.max(1, Math.min(items.length, concurrency || 1));
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;
            try {
                results[index] = {
                    status: 'fulfilled',
                    value: await task(items[index], index),
                };
            } catch (reason) {
                results[index] = {
                    status: 'rejected',
                    reason,
                };
            }
        }
    }

    await Promise.all(Array.from({ length: limit }, worker));
    return results;
}

function decodeBase64Subscription(rawText) {
    const compact = `${rawText || ''}`.replace(/\s/g, '');
    if (
        compact.length < 16 ||
        compact.length % 4 === 1 ||
        !/^[A-Za-z0-9+/_=-]+$/.test(compact)
    ) {
        return '';
    }

    try {
        const padded = compact
            .replace(/-/g, '+')
            .replace(/_/g, '/')
            .padEnd(Math.ceil(compact.length / 4) * 4, '=');
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
        }
        const decoded = new TextDecoder().decode(bytes);
        return looksLikeSubscriptionText(decoded) ? decoded : '';
    } catch {
        return '';
    }
}

function looksLikeSubscriptionText(text) {
    return (
        /(^|\n)\s*(ss|ssr|vmess|vless|trojan|hysteria2|hy2|tuic|wireguard):\/\//i.test(text) ||
        /(^|\n)\s*proxies:\s*(\n|\[)/i.test(text) ||
        (text.includes('"outbounds"') && text.includes('"inbounds"'))
    );
}

async function validateUpstreamUrl(rawUrl, config) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new ClientError(400, 'invalid_upstream_url', 'invalid upstream url');
    }

    if (!['https:', 'http:'].includes(url.protocol)) {
        throw new ClientError(400, 'unsupported_upstream_protocol', 'unsupported upstream protocol');
    }
    if (url.protocol === 'http:') {
        throw new ClientError(400, 'http_upstream_not_allowed', 'http upstream not allowed');
    }

    const hostname = normalizeHostname(url.hostname);
    if (isBlockedHostname(hostname)) {
        throw new ClientError(400, 'blocked_upstream_host', 'blocked upstream host');
    }
    if (isBlockedIp(hostname)) {
        throw new ClientError(400, 'blocked_upstream_ip', 'blocked upstream ip');
    }
    if (!config.disableDnsGuard && !isIpLiteral(hostname)) {
        await assertDnsIsPublic(hostname, config);
    }
    return url;
}

async function assertDnsIsPublic(hostname, config) {
    const records = await resolvePublicDns(hostname, 'A', config);
    const aaaRecords = await resolvePublicDns(hostname, 'AAAA', config);
    const all = [...records, ...aaaRecords];
    if (all.length === 0) {
        throw new ClientError(400, 'dns_lookup_failed', 'dns lookup failed');
    }
    if (all.some((record) => isBlockedIp(record))) {
        throw new ClientError(400, 'blocked_upstream_dns', 'blocked upstream dns');
    }
}

async function resolvePublicDns(hostname, type, config) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.dnsTimeoutMs);
    try {
        const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`;
        const response = await fetch(url, {
            headers: { Accept: 'application/dns-json' },
            signal: controller.signal,
        });
        if (!response.ok) return [];
        const body = await response.json();
        return (body.Answer || [])
            .filter((answer) => answer.type === (type === 'A' ? 1 : 28))
            .map((answer) => `${answer.data || ''}`.trim())
            .filter(Boolean);
    } catch {
        throw new ClientError(400, 'dns_lookup_failed', 'dns lookup failed');
    } finally {
        clearTimeout(timer);
    }
}

async function readWebStreamTextWithLimit(stream, byteLimit) {
    if (!stream) return '';
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > byteLimit) {
            try {
                await reader.cancel();
            } catch {
                // best effort cancellation
            }
            throw new ClientError(413, 'body_too_large', 'body too large');
        }
        text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
}

function readPositiveInteger(value, fallback) {
    const parsed = Number.parseInt(`${value ?? ''}`, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readSecret(value) {
    const secret = `${value ?? ''}`.trim();
    if (
        !secret ||
        secret.length < MIN_SECRET_LENGTH ||
        /[\s/?#]/.test(secret) ||
        WEAK_SECRET_VALUES.has(secret.toLowerCase())
    ) {
        return null;
    }
    return secret;
}

function normalizeHostname(hostname) {
    return `${hostname || ''}`.replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '').toLowerCase();
}

function isBlockedHostname(hostname) {
    return (
        hostname === 'metadata' ||
        hostname === 'localhost' ||
        hostname === 'metadata.google.internal' ||
        hostname.endsWith('.metadata.google.internal') ||
        hostname.endsWith('.localhost') ||
        hostname.endsWith('.local')
    );
}

function isIpLiteral(hostname) {
    return isIPv4(hostname) || isIPv6(hostname);
}

function isBlockedIp(hostname) {
    return isBlockedIPv4(hostname) || isBlockedIPv6(hostname);
}

function isIPv4(hostname) {
    return parseIPv4(hostname) !== null;
}

function isIPv6(hostname) {
    return hostname.includes(':');
}

function isBlockedIPv4(hostname) {
    const parts = parseIPv4(hostname);
    if (!parts) return false;
    return isBlockedIPv4Parts(parts);
}

function isBlockedIPv4Parts(parts) {
    const [a, b] = parts;

    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 0) ||
        (a === 192 && b === 168) ||
        (a === 198 && (b === 18 || b === 19)) ||
        a >= 224
    );
}

function isBlockedIPv6(hostname) {
    const host = normalizeHostname(hostname);
    if (!isIPv6(host)) return false;
    const mapped = parseIPv4MappedIPv6(host);
    if (mapped) return isBlockedIPv4Parts(mapped);

    const parts = expandIPv6(host);
    if (!parts) return false;
    if (isBlockedIPv6Parts(parts)) {
        return true;
    }
    return false;
}

function isBlockedIPv6Parts(parts) {
    const first = parts[0];
    const isUnspecified = parts.every((part) => part === 0);
    const isLoopback = parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1;
    return (
        isUnspecified ||
        isLoopback ||
        (first & 0xfe00) === 0xfc00 ||
        (first & 0xffc0) === 0xfe80 ||
        (first & 0xff00) === 0xff00
    );
}

function parseIPv4MappedIPv6(hostname) {
    const dotted = hostname.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    if (dotted) return parseIPv4(dotted[1]);

    const hex = hostname.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (!hex) return null;

    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    if (!Number.isInteger(high) || !Number.isInteger(low)) return null;
    return [
        (high >> 8) & 255,
        high & 255,
        (low >> 8) & 255,
        low & 255,
    ];
}

function expandIPv6(hostname) {
    const parts = `${hostname || ''}`.toLowerCase().split('::');
    if (parts.length > 2) return null;

    const head = parseIPv6Hextets(parts[0]);
    const tail = parts.length === 2 ? parseIPv6Hextets(parts[1]) : [];
    if (!head || !tail) return null;

    if (parts.length === 1) {
        return head.length === 8 ? head : null;
    }

    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    return [...head, ...Array(missing).fill(0), ...tail];
}

function parseIPv6Hextets(segment) {
    if (!segment) return [];
    const hextets = segment.split(':').map((part) => {
        if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
        return Number.parseInt(part, 16);
    });
    return hextets.some((part) => part === null) ? null : hextets;
}

function parseIPv4(hostname) {
    const match = hostname.match(/^(\d{1,3})(?:\.(\d{1,3})){3}$/);
    if (!match) return null;
    const parts = hostname.split('.').map((part) => Number.parseInt(part, 10));
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        return null;
    }
    return parts;
}
