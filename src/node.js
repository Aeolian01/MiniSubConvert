import { createServer } from "node:http";
import { ProxyUtils } from "@/core/proxy-utils";
import {
    ClientError,
    createRuntimeConfig,
    fetchRemoteText,
    fetchSubscriptionTexts,
    getIgnoredCompatParams,
    isAuthorizedPath,
    logRequest,
    normalizeTarget,
    parseProxyParseRequest,
    parseUpstreamUrls,
    safeErrorCode,
} from "@/server-utils";
import { buildMihomoConfig, isMihomoTarget } from "@/subconfig";

async function readNodeRequestTextWithLimit(req, byteLimit) {
    let raw = "";
    let size = 0;
    for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > byteLimit) {
            throw new ClientError(413, "body_too_large", "body too large");
        }
        raw += chunk;
    }
    return raw;
}

createServer(async (req, res) => {
    const method = (req.method || "").toUpperCase();
    const route = req.url || "";
    const url = new URL(route, "http://localhost");
    const pathname = url.pathname;
    const config = createRuntimeConfig(process.env);
    const userAgent = req.headers["user-agent"] || "";

    if (!isAuthorizedPath(method, pathname, config.secret)) {
        res.writeHead(403);
        res.end();
        logRequest("node_request_rejected", { status: 403 });
        return;
    }

    try {
        if (method === "POST") {
            const raw = await readNodeRequestTextWithLimit(req, config.maxPostBytes);
            const { data, client } = parseProxyParseRequest(raw);
            const target = normalizeTarget(client, userAgent);
            const proxies = ProxyUtils.parse(data);
            const par_res = ProxyUtils.produce(proxies, target);
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ status: "success", data: { par_res } }));
            logRequest("node_proxy_parse_ok", { target, proxyCount: proxies.length });
            return;
        }

        const target = url.searchParams.get("target");
        const rawUrls = url.searchParams.get("url");
        const rawConfigUrl = url.searchParams.get("config");
        const ignoredParams = getIgnoredCompatParams(url.searchParams);

        if (!target || !rawUrls) {
            throw new ClientError(400, "missing_target_or_url", "missing target or url");
        }

        const client = normalizeTarget(target, userAgent);
        const urls = parseUpstreamUrls(rawUrls, config);
        const { texts, failureCount } = await fetchSubscriptionTexts(
            urls,
            config,
            `${userAgent}`,
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
                    `${userAgent}`,
                    config.maxConfigBytes,
                ),
            )
            : ProxyUtils.produce(resultProxies, client);

        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(result);
        logRequest("node_subscription_convert_ok", {
            target: client,
            upstreamCount: urls.length,
            failedUpstreams: failureCount,
            ignoredParams: ignoredParams.join(","),
            proxyCount: resultProxies.length,
            configuredOutput: shouldUseSubconfig,
        });
    } catch (error) {
        const status = error instanceof ClientError ? error.status : 500;
        const code = safeErrorCode(error);
        res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(status >= 500 ? "internal error" : code);
        logRequest("node_request_failed", { status, code });
    }
}).listen(Number(process.env.PORT) || 3000, process.env.HOST || "0.0.0.0", () => {
    console.log(`Server is running at http://${process.env.HOST || "0.0.0.0"}:${Number(process.env.PORT) || 3000}`);
});
