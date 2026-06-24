import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tmp = await mkdtemp(path.join(tmpdir(), 'minisubconvert-smoke-'));
const bundlePath = path.join(tmp, 'server-utils.mjs');
const originalFetch = globalThis.fetch;
const STRONG_SECRET = 'test-secret-value-32-bytes';

try {
    await build({
        entryPoints: ['src/server-utils.js'],
        outfile: bundlePath,
        bundle: true,
        platform: 'node',
        format: 'esm',
        logLevel: 'silent',
    });

    const {
        createRuntimeConfig,
        fetchRemoteText,
        fetchSubscriptionTexts,
        isAuthorizedPath,
        normalizeSubscriptionText,
        normalizeTarget,
        parseProxyParseRequest,
        parseUpstreamUrls,
    } = await import(pathToFileURL(bundlePath));
    const config = (overrides = {}) => createRuntimeConfig({
        SECRET: STRONG_SECRET,
        ...overrides,
    });

    assert.equal(createRuntimeConfig().secret, null);
    assert.equal(createRuntimeConfig({ SECRET: 'secret' }).secret, null);
    assert.equal(isAuthorizedPath('GET', '/secret/sub', createRuntimeConfig().secret), false);
    assert.equal(isAuthorizedPath('GET', `/${STRONG_SECRET}/sub`, config().secret), true);
    assert.equal(isAuthorizedPath('POST', `/${STRONG_SECRET}/api/proxy/parse`, config().secret), true);
    assert.equal(isAuthorizedPath('GET', '/wrong/sub', config().secret), false);
    assert.throws(() => parseProxyParseRequest('{bad-json'), { code: 'invalid_json' });
    assert.throws(() => parseProxyParseRequest('{"client":"mihomo"}'), { code: 'missing_data' });
    assert.throws(() => parseProxyParseRequest('{"data":"trojan://p@example.com:443#n"}'), { code: 'missing_target' });
    assert.deepEqual(
        parseProxyParseRequest('{"client":"mihomo","data":"trojan://p@example.com:443#n"}'),
        { client: 'mihomo', data: 'trojan://p@example.com:443#n' },
    );

    assert.equal(normalizeTarget('clash', 'Mihomo/1.0'), 'mihomo');
    assert.equal(normalizeTarget('clash', 'Clash/1.0'), 'mihomo');
    assert.equal(normalizeTarget('Clash', 'Clash/1.0'), 'Clash');
    assert.equal(normalizeTarget('mixed', 'v2rayN/SubClient'), 'v2ray');
    assert.equal(normalizeTarget('quanx', ''), 'qx');
    assert.throws(() => normalizeTarget('unknown-client', ''), {
        code: 'unsupported_target',
    });
    assert.equal(config({ MAX_CONFIG_BYTES: '10' }).maxConfigBytes, 10);

    assert.deepEqual(
        parseUpstreamUrls('https://a.example/sub|https://b.example/sub', config()),
        ['https://a.example/sub', 'https://b.example/sub'],
    );
    assert.throws(
        () => parseUpstreamUrls('https://a|https://b', config({ MAX_UPSTREAM_URLS: '1' })),
        { code: 'too_many_upstreams' },
    );

    let fetchCalled = false;
    globalThis.fetch = async () => {
        fetchCalled = true;
        return new Response('unexpected');
    };
    await assert.rejects(
        fetchSubscriptionTexts(
            ['http://example.com/sub'],
            config({ DISABLE_DNS_GUARD: 'true' }),
            '',
        ),
        { code: 'http_upstream_not_allowed' },
    );
    assert.equal(fetchCalled, false);

    fetchCalled = false;
    globalThis.fetch = async () => {
        fetchCalled = true;
        return new Response('unexpected');
    };
    await assert.rejects(
        fetchSubscriptionTexts(
            ['https://127.0.0.1/sub'],
            config({
                DISABLE_DNS_GUARD: 'true',
            }),
            '',
        ),
        { code: 'blocked_upstream_ip' },
    );
    assert.equal(fetchCalled, false);

    fetchCalled = false;
    globalThis.fetch = async () => {
        fetchCalled = true;
        return new Response('unexpected');
    };
    await assert.rejects(
        fetchRemoteText(
            'https://127.0.0.1/config.ini',
            config({
                DISABLE_DNS_GUARD: 'true',
            }),
            '',
            1024,
        ),
        { code: 'blocked_upstream_ip' },
    );
    assert.equal(fetchCalled, false);

    fetchCalled = false;
    globalThis.fetch = async () => {
        fetchCalled = true;
        return new Response('unexpected');
    };
    await assert.rejects(
        fetchRemoteText(
            'https://[::ffff:7f00:1]/config.ini',
            config({ DISABLE_DNS_GUARD: 'true' }),
            '',
            1024,
        ),
        { code: 'blocked_upstream_ip' },
    );
    assert.equal(fetchCalled, false);

    fetchCalled = false;
    globalThis.fetch = async () => {
        fetchCalled = true;
        return new Response('unexpected');
    };
    await assert.rejects(
        fetchRemoteText(
            'https://[fe90::1]/config.ini',
            config({ DISABLE_DNS_GUARD: 'true' }),
            '',
            1024,
        ),
        { code: 'blocked_upstream_ip' },
    );
    assert.equal(fetchCalled, false);

    globalThis.fetch = async () => new Response('abcdef');
    await assert.rejects(
        fetchSubscriptionTexts(
            ['https://example.com/sub'],
            config({
                DISABLE_DNS_GUARD: 'true',
                MAX_UPSTREAM_BYTES: '5',
            }),
            '',
        ),
        { code: 'body_too_large' },
    );
    await assert.rejects(
        fetchRemoteText(
            'https://example.com/config.ini',
            config({ DISABLE_DNS_GUARD: 'true' }),
            '',
            5,
        ),
        { code: 'body_too_large' },
    );

    globalThis.fetch = async (_url, init = {}) =>
        new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
            });
        });
    await assert.rejects(
        fetchSubscriptionTexts(
            ['https://example.com/sub'],
            config({
                DISABLE_DNS_GUARD: 'true',
                UPSTREAM_TIMEOUT_MS: '1',
            }),
            '',
        ),
        { code: 'upstream_timeout' },
    );

    globalThis.fetch = async () => new Response('trojan://password@example.com:443#node');
    const result = await fetchSubscriptionTexts(
        ['https://example.com/sub'],
        config({ DISABLE_DNS_GUARD: 'true' }),
        '',
    );
    assert.deepEqual(result.texts, ['trojan://password@example.com:443#node']);
    assert.equal(result.failureCount, 0);

    const encodedSubscription = btoa('trojan://password@example.com:443#base64-node');
    assert.equal(
        normalizeSubscriptionText(encodedSubscription),
        'trojan://password@example.com:443#base64-node',
    );
    globalThis.fetch = async () => new Response(encodedSubscription);
    const decodedResult = await fetchSubscriptionTexts(
        ['https://example.com/base64-sub'],
        config({ DISABLE_DNS_GUARD: 'true' }),
        '',
    );
    assert.deepEqual(decodedResult.texts, ['trojan://password@example.com:443#base64-node']);

    const redirectUrls = [];
    globalThis.fetch = async (url, init = {}) => {
        redirectUrls.push(url);
        assert.equal(init.redirect, 'manual');
        if (redirectUrls.length === 1) {
            return new Response('', {
                status: 302,
                headers: { Location: '/next-sub' },
            });
        }
        return new Response('trojan://password@example.com:443#redirected');
    };
    assert.equal(
        await fetchRemoteText(
            'https://example.com/source',
            config({ DISABLE_DNS_GUARD: 'true' }),
            '',
            1024,
        ),
        'trojan://password@example.com:443#redirected',
    );
    assert.deepEqual(redirectUrls, [
        'https://example.com/source',
        'https://example.com/next-sub',
    ]);

    let redirectAttempts = 0;
    globalThis.fetch = async () => {
        redirectAttempts += 1;
        return new Response('', {
            status: 302,
            headers: { Location: 'http://example.com/insecure' },
        });
    };
    await assert.rejects(
        fetchRemoteText(
            'https://example.com/source',
            config({ DISABLE_DNS_GUARD: 'true' }),
            '',
            1024,
        ),
        { code: 'http_upstream_not_allowed' },
    );
    assert.equal(redirectAttempts, 1);

    redirectAttempts = 0;
    globalThis.fetch = async () => {
        redirectAttempts += 1;
        return new Response('', {
            status: 302,
            headers: { Location: 'https://127.0.0.1/private' },
        });
    };
    await assert.rejects(
        fetchRemoteText(
            'https://example.com/source',
            config({ DISABLE_DNS_GUARD: 'true' }),
            '',
            1024,
        ),
        { code: 'blocked_upstream_ip' },
    );
    assert.equal(redirectAttempts, 1);

    redirectAttempts = 0;
    globalThis.fetch = async () => {
        redirectAttempts += 1;
        return new Response('', {
            status: 302,
            headers: { Location: 'https://metadata.google.internal/latest' },
        });
    };
    await assert.rejects(
        fetchRemoteText(
            'https://example.com/source',
            config({ DISABLE_DNS_GUARD: 'true' }),
            '',
            1024,
        ),
        { code: 'blocked_upstream_host' },
    );
    assert.equal(redirectAttempts, 1);

    redirectAttempts = 0;
    globalThis.fetch = async () => {
        redirectAttempts += 1;
        return new Response('', {
            status: 302,
            headers: { Location: `/redirect-${redirectAttempts}` },
        });
    };
    await assert.rejects(
        fetchRemoteText(
            'https://example.com/source',
            config({
                DISABLE_DNS_GUARD: 'true',
                MAX_UPSTREAM_REDIRECTS: '1',
            }),
            '',
            1024,
        ),
        { code: 'too_many_upstream_redirects' },
    );
    assert.equal(redirectAttempts, 2);

    let activeFetches = 0;
    let maxActiveFetches = 0;
    globalThis.fetch = async () => {
        activeFetches += 1;
        maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
        await new Promise((resolve) => {
            setTimeout(resolve, 5);
        });
        activeFetches -= 1;
        return new Response('trojan://password@example.com:443#limited');
    };
    const limitedConcurrencyResult = await fetchSubscriptionTexts(
        [
            'https://example.com/sub-1',
            'https://example.com/sub-2',
            'https://example.com/sub-3',
            'https://example.com/sub-4',
        ],
        config({
            DISABLE_DNS_GUARD: 'true',
            MAX_UPSTREAM_CONCURRENCY: '2',
        }),
        '',
    );
    assert.equal(maxActiveFetches, 2);
    assert.equal(limitedConcurrencyResult.texts.length, 4);

    console.log('security smoke checks passed');
} finally {
    globalThis.fetch = originalFetch;
    await rm(tmp, { recursive: true, force: true });
}
