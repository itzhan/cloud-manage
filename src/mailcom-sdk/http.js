import { APP_HEADERS } from "./constants.js";
import { MailComApiError } from "./errors.js";
export class MailComHttpClient {
    fetchImpl;
    getAccessToken;
    onUnauthorized;
    constructor(fetchImpl, getAccessToken, onUnauthorized) {
        this.fetchImpl = fetchImpl;
        this.getAccessToken = getAccessToken;
        this.onUnauthorized = onUnauthorized;
    }
    async request(url, options = {}, retried = false) {
        const method = options.method ?? "GET";
        const headers = new Headers(APP_HEADERS);
        for (const [key, value] of new Headers(options.headers)) {
            headers.set(key, value);
        }
        let body = options.body;
        if (options.json !== undefined) {
            body = JSON.stringify(options.json);
            if (!headers.has("Content-Type"))
                headers.set("Content-Type", "application/json");
        }
        if (options.form) {
            body = options.form;
            if (!headers.has("Content-Type"))
                headers.set("Content-Type", "application/x-www-form-urlencoded");
        }
        if (options.auth) {
            const accessToken = this.getAccessToken();
            if (accessToken)
                headers.set("Authorization", `Bearer ${accessToken}`);
        }
        const requestInit = { method, headers };
        if (body !== undefined)
            requestInit.body = body;
        const response = await this.fetchImpl(url, requestInit);
        if (response.status === 401 && options.auth && !retried) {
            await this.onUnauthorized();
            return this.request(url, options, true);
        }
        if (!response.ok) {
            const errorBody = await response.text().catch(() => undefined);
            const bodySnippet = errorBody?.trim();
            const errorInput = {
                message: bodySnippet
                    ? `${method} ${url} failed with ${response.status}: ${truncate(bodySnippet)}`
                    : `${method} ${url} failed with ${response.status}`,
                status: response.status,
                method,
                url,
                ...(errorBody !== undefined ? { body: errorBody } : {}),
            };
            throw new MailComApiError(errorInput);
        }
        const responseType = options.responseType ?? "json";
        if (responseType === "raw")
            return response;
        if (responseType === "void" || response.status === 204)
            return undefined;
        if (responseType === "text" || responseType === "sse")
            return (await response.text());
        if (responseType === "binary") {
            return { data: await response.arrayBuffer(), headers: response.headers };
        }
        return (await response.json());
    }
}
function truncate(value, length = 300) {
    return value.length > length ? `${value.slice(0, length)}...` : value;
}
