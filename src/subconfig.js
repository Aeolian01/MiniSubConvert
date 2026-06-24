export const DEFAULT_RULE_PROVIDER_PROXY = '♻️ 自动选择';

const DEFAULT_TEST_URL = 'http://www.gstatic.com/generate_204';
const DEFAULT_INTERVAL = 300;
const RULE_PROVIDER_INTERVAL = 86400;
const DEFAULT_RULE_PROVIDER_FORMAT = 'yaml';
const RULE_PROVIDER_FORMATS = {
    list: 'text',
    txt: 'text',
    yaml: 'yaml',
    yml: 'yaml',
};
const MIHOMO_TARGETS = new Set([
    'mihomo',
    'Mihomo',
    'meta',
    'clashmeta',
    'ClashMeta',
    'Clash.Meta',
    'clash.meta',
]);

const GROUP_TYPE_ALIASES = {
    select: 'select',
    'url-test': 'url-test',
    fallback: 'fallback',
    'load-balance': 'load-balance',
    relay: 'relay',
};

const SIMPLE_BUILTIN_RULE_TYPES = new Set([
    'DOMAIN',
    'DOMAIN-SUFFIX',
    'DOMAIN-KEYWORD',
    'DOMAIN-REGEX',
    'DST-PORT',
    'DSCP',
    'GEOIP',
    'GEOSITE',
    'IN-NAME',
    'IN-PORT',
    'IN-TYPE',
    'IN-USER',
    'IP-ASN',
    'IP-CIDR',
    'IP-CIDR6',
    'NETWORK',
    'PROCESS-NAME',
    'PROCESS-NAME-REGEX',
    'PROCESS-PATH',
    'PROCESS-PATH-REGEX',
    'RULE-SET',
    'SRC-GEOIP',
    'SRC-IP-ASN',
    'SRC-IP-CIDR',
    'SRC-PORT',
    'UID',
    'URL-REGEX',
    'USER-AGENT',
]);

export function isMihomoTarget(target) {
    return MIHOMO_TARGETS.has(`${target || ''}`);
}

export function parseSubconfig(rawText) {
    const lines = normalizeSubconfigLines(rawText);
    const proxyGroups = [];
    const rulesets = [];
    const unsupported = [];

    for (const line of lines) {
        if (line.startsWith('custom_proxy_group=')) {
            const group = parseCustomProxyGroup(line);
            if (group) {
                proxyGroups.push(group);
            } else {
                unsupported.push('custom_proxy_group');
            }
        } else if (line.startsWith('ruleset=')) {
            const ruleset = parseRuleset(line);
            if (ruleset?.type === 'unsupported') {
                unsupported.push(ruleset.reason);
            } else if (ruleset) {
                rulesets.push(ruleset);
            } else {
                unsupported.push('ruleset');
            }
        }
    }

    return { proxyGroups, rulesets, unsupported };
}

export function buildMihomoConfig(proxies, subconfigText, options = {}) {
    const proxyList = Array.isArray(proxies) ? proxies : [];
    const proxyNames = proxyList.map((proxy) => getProxyName(proxy)).filter(Boolean);
    const parsed = parseSubconfig(subconfigText);
    const proxyProviderName = options.ruleProviderProxy || DEFAULT_RULE_PROVIDER_PROXY;
    const proxyGroups = buildProxyGroups(
        parsed.proxyGroups,
        proxyNames,
        proxyProviderName,
    );
    const { ruleProviders, rules } = buildRules(parsed.rulesets, proxyProviderName);

    return stringifyMihomoConfig(prepareMihomoConfig({
        proxies: proxyList,
        proxyGroups,
        ruleProviders,
        rules,
    }));
}

export function normalizeSubconfigLines(rawText) {
    let text = `${rawText || ''}`.replace(/\r/g, '\n');
    for (const marker of [
        '[custom]',
        'ruleset=',
        'custom_proxy_group=',
        'enable_rule_generator=',
        'overwrite_original_rules=',
    ]) {
        text = text.replace(
            new RegExp(`([^\\n])(${escapeRegExp(marker)})`, 'g'),
            '$1\n$2',
        );
    }

    return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith(';') && !line.startsWith('#'));
}

function parseCustomProxyGroup(line) {
    const raw = line.slice('custom_proxy_group='.length).trim();
    const parts = raw.split('`').map((part) => part.trim());
    const [name, rawType, ...items] = parts;
    const type = GROUP_TYPE_ALIASES[`${rawType || ''}`.toLowerCase()];
    if (!name || !type) return null;
    return { name, type, items };
}

function parseRuleset(line) {
    const raw = line.slice('ruleset='.length).trim();
    const separator = raw.indexOf(',');
    if (separator <= 0) return null;
    const policy = raw.slice(0, separator).trim();
    const value = raw.slice(separator + 1).trim();
    if (!policy || !value) return null;
    if (/^https:\/\//i.test(value)) {
        return { type: 'remote', policy, url: value };
    }
    if (value.startsWith('[]')) {
        const rule = value.slice(2).trim();
        if (isSupportedBuiltinRule(rule)) {
            return { type: 'builtin', policy, rule };
        }
        return {
            type: 'unsupported',
            reason: `ruleset:unsupported_builtin:${builtinRuleType(rule) || 'EMPTY'}`,
        };
    }
    return null;
}

function buildProxyGroups(definitions, proxyNames, autoGroupName) {
    const groups = definitions.map((definition) =>
        buildProxyGroup(definition, proxyNames),
    );

    if (!groups.some((group) => group.name === autoGroupName)) {
        groups.push(createAutoGroup(autoGroupName, proxyNames));
    }

    for (const group of groups) {
        if (!Array.isArray(group.proxies) || group.proxies.length === 0) {
            group.proxies = group.name === autoGroupName
                ? fallbackProxyNames(proxyNames)
                : [autoGroupName];
        }
    }

    return groups;
}

function buildProxyGroup(definition, proxyNames) {
    const group = {
        name: definition.name,
        type: definition.type,
        proxies: [],
    };

    for (const item of definition.items) {
        if (!item) continue;
        if (item.startsWith('[]')) {
            const reference = item.slice(2).trim();
            if (reference) group.proxies.push(reference);
            continue;
        }
        if (isHttpUrl(item)) {
            if (!group.url) group.url = item;
            continue;
        }
        const interval = parseInterval(item);
        if (interval) {
            group.interval = interval.interval;
            if (interval.tolerance) group.tolerance = interval.tolerance;
            continue;
        }

        group.proxies.push(...matchProxyNames(proxyNames, item));
    }

    group.proxies = unique(group.proxies);

    if (['url-test', 'fallback', 'load-balance'].includes(group.type)) {
        group.url = group.url || DEFAULT_TEST_URL;
        group.interval = group.interval || DEFAULT_INTERVAL;
    }

    return group;
}

function createAutoGroup(name, proxyNames) {
    return {
        name,
        type: 'url-test',
        proxies: fallbackProxyNames(proxyNames),
        url: DEFAULT_TEST_URL,
        interval: DEFAULT_INTERVAL,
    };
}

function buildRules(rulesets, proxyProviderName) {
    const ruleProviders = {};
    const rules = [];
    const usedProviderNames = new Set();
    const usedProviderPaths = new Set();

    rulesets.forEach((ruleset, index) => {
        if (ruleset.type === 'remote') {
            const providerName = uniqueProviderName(ruleset.policy, usedProviderNames);
            const providerFormat = inferRuleProviderFormat(ruleset.url);
            ruleProviders[providerName] = {
                type: 'http',
                behavior: 'classical',
                format: providerFormat.format,
                url: ruleset.url,
                path: uniqueProviderPath(
                    providerName,
                    index,
                    providerFormat.extension,
                    usedProviderPaths,
                ),
                interval: RULE_PROVIDER_INTERVAL,
                proxy: proxyProviderName,
            };
            rules.push(`RULE-SET,${providerName},${ruleset.policy}`);
            return;
        }

        const builtinRule = buildBuiltinRule(ruleset.rule, ruleset.policy);
        if (builtinRule) rules.push(builtinRule);
    });

    return { ruleProviders, rules };
}

function buildBuiltinRule(rawRule, policy) {
    const rule = `${rawRule || ''}`.trim();
    const upper = rule.toUpperCase();
    if (upper === 'FINAL' || upper === 'MATCH') {
        return `MATCH,${policy}`;
    }
    const [type, value, ...options] = splitRuleParts(rule);
    if (!SIMPLE_BUILTIN_RULE_TYPES.has(type.toUpperCase()) || !value) return '';
    return [type, value, policy, ...options].join(',');
}

function stringifyMihomoConfig({ proxies, proxyGroups, ruleProviders, rules }) {
    let output = '';
    if (proxies.length > 0) {
        output += 'proxies:\n';
        output += proxies.map((proxy) => `  - ${JSON.stringify(proxy)}\n`).join('');
    } else {
        output += 'proxies: []\n';
    }

    if (proxyGroups.length > 0) {
        output += '\nproxy-groups:\n';
        for (const group of proxyGroups) {
            output += `  - name: ${yamlScalar(group.name)}\n`;
            output += `    type: ${yamlScalar(group.type)}\n`;
            if (group.url) output += `    url: ${yamlScalar(group.url)}\n`;
            if (group.interval) output += `    interval: ${group.interval}\n`;
            if (group.tolerance) output += `    tolerance: ${group.tolerance}\n`;
            output += '    proxies:\n';
            for (const proxy of group.proxies) {
                output += `      - ${yamlScalar(proxy)}\n`;
            }
        }
    }

    const providerEntries = Object.entries(ruleProviders);
    if (providerEntries.length > 0) {
        output += '\nrule-providers:\n';
        for (const [name, provider] of providerEntries) {
            output += `  ${yamlKey(name)}:\n`;
            output += `    type: ${yamlScalar(provider.type)}\n`;
            output += `    behavior: ${yamlScalar(provider.behavior)}\n`;
            output += `    format: ${yamlScalar(provider.format)}\n`;
            output += `    url: ${yamlScalar(provider.url)}\n`;
            output += `    path: ${yamlScalar(provider.path)}\n`;
            output += `    interval: ${provider.interval}\n`;
            output += `    proxy: ${yamlScalar(provider.proxy)}\n`;
        }
    }

    if (rules.length > 0) {
        output += '\nrules:\n';
        for (const rule of rules) {
            output += `  - ${yamlScalar(rule)}\n`;
        }
    }

    return output;
}

function prepareMihomoConfig(config) {
    const cleaned = cleanMihomoValue(config) || {};
    return {
        proxies: Array.isArray(cleaned.proxies) ? cleaned.proxies : [],
        proxyGroups: Array.isArray(cleaned.proxyGroups) ? cleaned.proxyGroups : [],
        ruleProviders: cleaned.ruleProviders && typeof cleaned.ruleProviders === 'object'
            ? cleaned.ruleProviders
            : {},
        rules: Array.isArray(cleaned.rules) ? cleaned.rules : [],
    };
}

function cleanMihomoValue(value) {
    if (value === null || value === undefined) return undefined;

    if (Array.isArray(value)) {
        return value
            .map((item) => cleanMihomoValue(item))
            .filter((item) => item !== undefined);
    }

    if (typeof value === 'object') {
        const cleaned = {};
        for (const [key, item] of Object.entries(value)) {
            if (key.startsWith('_')) continue;
            const cleanedValue = cleanMihomoValue(item);
            if (cleanedValue !== undefined) {
                cleaned[key] = cleanedValue;
            }
        }
        return cleaned;
    }

    return value;
}

function getProxyName(proxy) {
    if (proxy?.name) return `${proxy.name}`;
    if (proxy?.type && proxy?.server && proxy?.port) {
        return `${proxy.type} ${proxy.server}:${proxy.port}`;
    }
    return '';
}

function fallbackProxyNames(proxyNames) {
    return proxyNames.length > 0 ? unique(proxyNames) : ['DIRECT'];
}

function matchProxyNames(proxyNames, pattern) {
    if (pattern === '.*') return proxyNames;
    try {
        const regex = new RegExp(pattern, 'i');
        return proxyNames.filter((name) => regex.test(name));
    } catch {
        return [];
    }
}

function parseInterval(item) {
    const match = `${item}`.match(/^(\d+)(?:,,(\d+))?$/);
    if (!match) return null;
    return {
        interval: Number.parseInt(match[1], 10),
        tolerance: match[2] ? Number.parseInt(match[2], 10) : undefined,
    };
}

function unique(items) {
    return [...new Set(items.filter(Boolean))];
}

function uniqueProviderName(policy, usedNames) {
    let name = policy;
    let suffix = 2;
    while (usedNames.has(name)) {
        name = `${policy}-${suffix}`;
        suffix += 1;
    }
    usedNames.add(name);
    return name;
}

function inferRuleProviderFormat(url) {
    const extension = ruleProviderExtension(url);
    const format = RULE_PROVIDER_FORMATS[extension] || DEFAULT_RULE_PROVIDER_FORMAT;
    return {
        format,
        extension: format === 'text' ? extension : 'yaml',
    };
}

function ruleProviderExtension(url) {
    try {
        const pathname = new URL(url).pathname.toLowerCase();
        const match = pathname.match(/\.([a-z0-9]+)$/);
        return match ? match[1] : '';
    } catch {
        return '';
    }
}

function uniqueProviderPath(name, index, extension, usedPaths) {
    const base = safeProviderPath(name, index);
    let path = `${base}.${extension}`;
    let suffix = 2;
    while (usedPaths.has(path)) {
        const trimmedBase = base.slice(0, Math.max(1, 48 - `${suffix}`.length - 1));
        path = `${trimmedBase}-${suffix}.${extension}`;
        suffix += 1;
    }
    usedPaths.add(path);
    return `./ruleset/${path}`;
}

function safeProviderPath(name, index) {
    const cleaned = `${name}`
        .normalize('NFKD')
        .replace(/[^\w.-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    return cleaned || `rule-${index + 1}`;
}

function isSupportedBuiltinRule(rawRule) {
    const rule = `${rawRule || ''}`.trim();
    const upper = rule.toUpperCase();
    if (upper === 'FINAL' || upper === 'MATCH') return true;
    const [type, value] = splitRuleParts(rule);
    return SIMPLE_BUILTIN_RULE_TYPES.has(type.toUpperCase()) && Boolean(value);
}

function builtinRuleType(rawRule) {
    return splitRuleParts(rawRule)[0]?.toUpperCase() || '';
}

function splitRuleParts(rule) {
    return `${rule || ''}`.split(',').map((part) => part.trim());
}

function yamlScalar(value) {
    if (typeof value === 'number' || typeof value === 'boolean') return `${value}`;
    return JSON.stringify(`${value}`);
}

function yamlKey(value) {
    return JSON.stringify(`${value}`);
}

function isHttpUrl(value) {
    return /^https?:\/\//i.test(`${value}`);
}

function escapeRegExp(value) {
    return `${value}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
