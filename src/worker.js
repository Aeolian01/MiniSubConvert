import { ProxyUtils } from "@/core/proxy-utils";
import {
    ClientError,
    createJsonResponse,
    createRuntimeConfig,
    createTextResponse,
    fetchRemoteText,
    fetchSubscriptionTexts,
    getIgnoredCompatParams,
    isAuthorizedPath,
    logRequest,
    normalizeTarget,
    parseProxyParseRequest,
    parseUpstreamUrls,
    readWebRequestTextWithLimit,
    safeErrorCode,
} from "@/server-utils";
import { buildMihomoConfig, isMihomoTarget } from "@/subconfig";

export default {
    async fetch(request, env) {
        return handleRequest(request, env);
    }
};

async function handleRequest(request, env = {}) {
    const method = request.method.toUpperCase();
    const pathname = new URL(request.url).pathname;
    const config = createRuntimeConfig(env);
    const userAgent = request.headers.get("user-agent") || "";

    if (!isAuthorizedPath(method, pathname, config.secret)) {
        return new Response(null, { status: 403 });
    }

    try {
        if (method === "POST") {
            const rawBody = await readWebRequestTextWithLimit(request, config.maxPostBytes);
            const { data, client } = parseProxyParseRequest(rawBody);
            const target = normalizeTarget(client, userAgent);
            const proxies = ProxyUtils.parse(data);
            const par_res = ProxyUtils.produce(proxies, target);
            logRequest("proxy_parse_ok", { target, proxyCount: proxies.length });

            return createJsonResponse(
                {
                    status: "success",
                    data: { par_res },
                },
            );
        }

        if (method === "GET") {
            const searchParams = new URL(request.url).searchParams;
            const target = searchParams.get("target");
            const rawUrls = searchParams.get("url");
            const rawConfigUrl = searchParams.get("config");
            const ignoredParams = getIgnoredCompatParams(searchParams);

            if (!target || !rawUrls) {
                throw new ClientError(400, "missing_target_or_url", "missing target or url");
            }

            const client = normalizeTarget(target, userAgent);
            const urls = parseUpstreamUrls(rawUrls, config);
            const { texts, failureCount } = await fetchSubscriptionTexts(
                urls,
                config,
                userAgent,
            );
            const proxies = texts.flatMap((subContent) => ProxyUtils.parse(subContent));
            const shouldUseSubconfig = Boolean(rawConfigUrl && isMihomoTarget(client));
            const resultProxies = shouldUseSubconfig
                ? ProxyUtils.produce(proxies, client, "internal")
                : proxies;
            const result = shouldUseSubconfig
                ? buildMihomoConfig(
                    resultProxies,
                    await fetchRemoteText(
                        rawConfigUrl,
                        config,
                        userAgent,
                        config.maxConfigBytes,
                    ),
                )
                : ProxyUtils.produce(resultProxies, client);
            logRequest("subscription_convert_ok", {
                target: client,
                upstreamCount: urls.length,
                failedUpstreams: failureCount,
                ignoredParams: ignoredParams.join(","),
                proxyCount: resultProxies.length,
                configuredOutput: shouldUseSubconfig,
            });

            return createTextResponse(result);
        }

        return new Response(null, { status: 403 });
    } catch (error) {
        const status = error instanceof ClientError ? error.status : 500;
        const code = safeErrorCode(error);
        logRequest("request_failed", { status, code });
        return createTextResponse(status >= 500 ? "internal error" : code, status);
    }
}
