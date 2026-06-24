import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const tmp = await mkdtemp(path.join(tmpdir(), 'minisubconvert-targets-'));
const bundlePath = path.join(tmp, 'proxy-utils.cjs');
const require = createRequire(import.meta.url);

try {
    await build({
        entryPoints: ['src/core/proxy-utils/index.js'],
        outfile: bundlePath,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        logLevel: 'silent',
        alias: {
            '@': path.resolve('src'),
        },
    });

    const { ProxyUtils } = require(bundlePath);
    const rawSubscription = 'trojan://password@example.com:443?security=tls&sni=example.com#ExampleNode';
    const proxies = ProxyUtils.parse(rawSubscription);
    assert.equal(proxies.length, 1);

    const mihomoOutput = ProxyUtils.produce(proxies, 'mihomo');
    assert.ok(mihomoOutput.includes('proxies:'));
    assert.ok(!mihomoOutput.includes('proxy-groups:'));
    assert.ok(!mihomoOutput.includes('rule-providers:'));

    const singboxOutput = ProxyUtils.produce(proxies, 'singbox');
    const singboxConfig = JSON.parse(singboxOutput);
    assert.ok(Array.isArray(singboxConfig.outbounds));
    assert.ok(singboxConfig.outbounds.some((outbound) => outbound.tag === 'ExampleNode'));

    console.log('target smoke checks passed');
} finally {
    await rm(tmp, { recursive: true, force: true });
}
