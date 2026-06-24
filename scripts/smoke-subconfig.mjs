import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import YAML from 'yaml';

const tmp = await mkdtemp(path.join(tmpdir(), 'minisubconvert-subconfig-'));
const bundlePath = path.join(tmp, 'subconfig.mjs');

try {
    await build({
        entryPoints: ['src/subconfig.js'],
        outfile: bundlePath,
        bundle: true,
        platform: 'node',
        format: 'esm',
        logLevel: 'silent',
    });

    const {
        DEFAULT_RULE_PROVIDER_PROXY,
        buildMihomoConfig,
        isMihomoTarget,
        normalizeSubconfigLines,
        parseSubconfig,
    } = await import(pathToFileURL(bundlePath));

    const subconfig = `[custom]
ruleset=🤖 OpenAi,https://raw.githubusercontent.com/example/OpenAI.list
ruleset=📄 Text Rules,https://raw.githubusercontent.com/example/TextRules.txt
ruleset=📦 YAML Rules,https://raw.githubusercontent.com/example/YamlRules.yaml
ruleset=Path/A,https://raw.githubusercontent.com/example/path-a.txt
ruleset=Path?A,https://raw.githubusercontent.com/example/path-b.txt
ruleset=🎯 全球直连,[]GEOIP,CN,no-resolve
ruleset=🧱 私有地址,[]IP-CIDR,10.0.0.0/8,no-resolve
ruleset=⚙️ 进程规则,[]PROCESS-NAME,Telegram
ruleset=🐟 漏网之鱼,[]FINAL
ruleset=未知规则,[]NOT-A-RULE
custom_proxy_group=🚀 节点选择\`select\`[]🇭🇰 香港节点\`[]☑️ 手动选择\`[]♻️ 自动选择
custom_proxy_group=☑️ 手动选择\`select\`.*
custom_proxy_group=♻️ 自动选择\`url-test\`.*\`http://www.gstatic.com/generate_204\`300,,50
custom_proxy_group=🇭🇰 香港节点\`url-test\`(港|HK|Hong Kong)\`http://www.gstatic.com/generate_204\`300,,50
custom_proxy_group=🤖 OpenAi\`select\`[]♻️ 自动选择\`[]DIRECT
custom_proxy_group=空组\`select\`NO_MATCH
custom_proxy_group=坏组\`unsupported\`.*`;

    const compactSubconfig = subconfig.replace(/\n/g, '');
    const compactLines = normalizeSubconfigLines(compactSubconfig);
    assert.ok(compactLines.includes('[custom]'));
    assert.ok(compactLines.some((line) => line.startsWith('ruleset=🤖 OpenAi,')));
    assert.ok(compactLines.some((line) => line.startsWith('custom_proxy_group=🚀 节点选择')));

    const parsed = parseSubconfig(subconfig);
    assert.equal(parsed.proxyGroups.length, 6);
    assert.equal(parsed.rulesets.length, 9);
    assert.deepEqual(parsed.unsupported, [
        'ruleset:unsupported_builtin:NOT-A-RULE',
        'custom_proxy_group',
    ]);

    const proxies = [
        {
            name: 'HK_Vision1_ai',
            type: 'vless',
            server: 'hk.example.com',
            port: 443,
            udp: null,
            _internalId: 'hk-internal',
            'ws-opts': {
                path: '/',
                headers: null,
                _source: 'internal',
                nested: {
                    keep: 'yes',
                    drop: undefined,
                    _secret: 'hidden',
                },
                list: [null, 'kept', undefined],
            },
        },
        {
            name: 'US_Vision1',
            type: 'vless',
            server: 'us.example.com',
            port: 443,
            _internalId: 'us-internal',
        },
    ];

    const output = buildMihomoConfig(proxies, compactSubconfig);
    const config = YAML.parse(output);
    assert.equal(isMihomoTarget('mihomo'), true);
    assert.equal(isMihomoTarget('clashmeta'), true);
    assert.equal(isMihomoTarget('singbox'), false);

    assert.equal(config.proxies.length, 2);
    assert.ok(config['proxy-groups'].length >= 6);
    assert.equal(
        config['rule-providers']['🤖 OpenAi'].proxy,
        DEFAULT_RULE_PROVIDER_PROXY,
    );
    assert.equal(config['rule-providers']['🤖 OpenAi'].format, 'text');
    assert.equal(
        config['rule-providers']['🤖 OpenAi'].path,
        './ruleset/OpenAi.list',
    );
    assert.equal(config['rule-providers']['📄 Text Rules'].format, 'text');
    assert.equal(config['rule-providers']['📦 YAML Rules'].format, 'yaml');
    const providerPaths = Object.values(config['rule-providers']).map(
        (provider) => provider.path,
    );
    assert.equal(new Set(providerPaths).size, providerPaths.length);
    assert.notEqual(
        config['rule-providers']['Path/A'].path,
        config['rule-providers']['Path?A'].path,
    );
    assert.ok(config.rules.includes('RULE-SET,🤖 OpenAi,🤖 OpenAi'));
    assert.ok(config.rules.includes('GEOIP,CN,🎯 全球直连,no-resolve'));
    assert.ok(config.rules.includes('IP-CIDR,10.0.0.0/8,🧱 私有地址,no-resolve'));
    assert.ok(config.rules.includes('PROCESS-NAME,Telegram,⚙️ 进程规则'));
    assert.ok(config.rules.includes('MATCH,🐟 漏网之鱼'));
    assert.ok(!config.rules.some((rule) => rule.includes('NOT-A-RULE')));

    assert.equal(config.proxies[0]._internalId, undefined);
    assert.equal(config.proxies[0].udp, undefined);
    assert.equal(config.proxies[0]['ws-opts'].headers, undefined);
    assert.equal(config.proxies[0]['ws-opts']._source, undefined);
    assert.equal(config.proxies[0]['ws-opts'].nested.keep, 'yes');
    assert.equal(config.proxies[0]['ws-opts'].nested.drop, undefined);
    assert.equal(config.proxies[0]['ws-opts'].nested._secret, undefined);
    assert.deepEqual(config.proxies[0]['ws-opts'].list, ['kept']);

    const hongKongGroup = config['proxy-groups'].find((group) => group.name === '🇭🇰 香港节点');
    assert.deepEqual(hongKongGroup.proxies, ['HK_Vision1_ai']);

    const emptyGroup = config['proxy-groups'].find((group) => group.name === '空组');
    assert.deepEqual(emptyGroup.proxies, [DEFAULT_RULE_PROVIDER_PROXY]);

    console.log('subconfig smoke checks passed');
} finally {
    await rm(tmp, { recursive: true, force: true });
}
