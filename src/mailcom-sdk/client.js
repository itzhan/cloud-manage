import { createHash, randomBytes } from "node:crypto";
import { ANDROID_CLIENT_ID, ANDROID_REDIRECT_URI, APP_HEADERS, DEFAULT_ANDROID_OAUTH_BASIC_AUTH, DEFAULT_EXCLUDED_FOLDERS, FULL_ACCESS_SCOPE, HSP2_BASE_URL, MAX_TOTAL_ATTACHMENT_BYTES, MIME, MOBSI_BASE_URL, OAUTH_BASE_URL, WEBVIEW_USER_AGENT, } from "./constants.js";
import { MailComAuthError, MailComError, MailComValidationError } from "./errors.js";
import { MailComHttpClient } from "./http.js";
import { folderUri, mailUri, normalizeAttachmentId, normalizeFolderId, normalizeMailId, parseUriList } from "./id.js";
import { FileSessionStore } from "./session-store.js";
import { parseMailSubmissionResult, parseSseJsonData } from "./sse.js";
const LIST_INCOMING_FOLDER_CONCURRENCY = 5;
export class MailComClient {
    auth;
    folders;
    mail;
    drafts;
    actions;
    attachments;
    account;
    email;
    password;
    fetchImpl;
    sessionStore;
    http;
    session = null;
    loginInFlight = null;
    refreshInFlight = null;
    currentTokenBasicAuth;
    constructor(options) {
        this.email = options.email;
        this.password = options.password;
        this.fetchImpl = options.fetch ?? fetch;
        this.sessionStore = options.sessionStore ?? new FileSessionStore(options.sessionDir);
        this.currentTokenBasicAuth = DEFAULT_ANDROID_OAUTH_BASIC_AUTH;
        this.http = new MailComHttpClient(this.fetchImpl, () => this.session?.accessToken, () => this.refreshWithLock().then(() => undefined));
        this.auth = {
            login: () => this.loginWithLock(),
            refresh: (refreshToken) => this.refreshWithLock(refreshToken),
            validateToken: (token) => this.validateToken(token),
            logout: () => this.logout(),
        };
        this.folders = {
            list: () => this.listFolders(),
            create: (input) => this.createFolder(input),
            rename: (folderId, name) => this.renameFolder(folderId, name),
            move: (folderId, parentFolderId) => this.moveFolder(folderId, parentFolderId),
            setExpireDays: (folderId, days) => this.setFolderExpireDays(folderId, days),
            delete: (folderId) => this.deleteFolder(folderId),
        };
        this.mail = {
            search: (query, options) => this.search(query, options),
            listByFolder: (folderId, options) => this.listByFolder(folderId, options),
            listIncoming: (options) => this.listIncoming(options),
            listAll: (options) => this.listIncoming(options),
            findBySubject: (subject, options) => this.findBySubject(subject, options),
            findBySender: (sender, options) => this.findBySender(sender, options),
            syncFolder: (folderId, options) => this.syncFolder(folderId, options),
            getBody: (mailId, options) => this.getBody(mailId, options),
            getPreview: (mailIds) => this.getPreview(mailIds),
            send: (input) => this.send(input),
            reply: (input) => this.reply(input),
            forward: (input) => this.forward(input),
        };
        this.drafts = {
            list: () => this.listDrafts(),
            create: (input) => this.createDraft(input),
            update: (draftId, input) => this.updateDraft(draftId, input),
            delete: (mailIds) => this.moveToTrash(mailIds),
        };
        this.actions = {
            markRead: (mailIds) => this.batchUpdate(mailIds, { read: true }),
            markUnread: (mailIds) => this.batchUpdate(mailIds, { read: false }),
            star: (mailIds) => this.batchUpdate(mailIds, { flagged: true }),
            unstar: (mailIds) => this.batchUpdate(mailIds, { flagged: false }),
            markSpam: (mailIds) => this.markSpam(mailIds),
            markNotSpam: (mailIds) => this.markNotSpam(mailIds),
            moveToFolder: (mailIds, folderId) => this.moveToFolder(mailIds, folderId),
            moveToTrash: (mailIds) => this.moveToTrash(mailIds),
            deletePermanent: (mailIds) => this.deletePermanent(mailIds),
            emptyTrash: () => this.emptyTrash(),
        };
        this.attachments = {
            listFromMessage: (message) => message.attachments?.attachment ?? [],
            download: (mailId, attachmentId) => this.downloadAttachment(mailId, attachmentId),
            thumbnail: (mailId, attachmentId, options) => this.downloadAttachment(mailId, attachmentId, options),
        };
        this.account = {
            aliases: () => this.aliases(),
            updateAliasDisplayName: (address, displayName) => this.updateAliasDisplayName(address, displayName),
            quota: () => this.accountGet("/MailAccount/accountId/Quota", MIME.quotas),
            settings: () => this.accountGet("/MailAccount/accountId/Setting", MIME.settings),
            userData: () => this.userData(),
            validateRecipients: (addresses) => this.validateRecipients(addresses),
        };
    }
    async login() {
        let cached = await this.sessionStore.load(this.email);
        if (cached && !this.isSessionBoundToClient(cached)) {
            await this.sessionStore.delete(this.email);
            cached = null;
        }
        if (cached?.accessToken && (await this.validateToken(cached.accessToken))) {
            this.session = cached;
            return cached;
        }
        if (cached?.refreshToken) {
            this.session = cached;
            try {
                return await this.refresh(cached.refreshToken);
            }
            catch {
                await this.sessionStore.delete(this.email);
                this.session = null;
            }
        }
        if (!this.password) {
            throw new MailComAuthError("Password is required when no valid cached session exists.");
        }
        return this.loginWithAndroidOAuth();
    }
    async refresh(refreshToken = this.session?.refreshToken, tokenBasicAuth = this.currentTokenBasicAuth) {
        if (!refreshToken)
            throw new MailComAuthError("No refresh token available.");
        const token = await this.oauthToken({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            scope: FULL_ACCESS_SCOPE,
        }, tokenBasicAuth);
        if (!token.access_token) {
            throw new MailComAuthError(token.error_description ?? token.error ?? "mail.com token refresh failed.");
        }
        const session = this.toSession(token, refreshToken);
        this.session = session;
        this.currentTokenBasicAuth = tokenBasicAuth;
        await this.sessionStore.save(this.email, session);
        return session;
    }
    async validateToken(token = this.session?.accessToken) {
        if (!token)
            return false;
        try {
            const response = await this.fetchImpl(`${MOBSI_BASE_URL}/UserData`, {
                method: "HEAD",
                headers: {
                    ...APP_HEADERS,
                    Accept: "application/json",
                    Authorization: `Bearer ${token}`,
                },
            });
            return response.ok;
        }
        catch {
            return false;
        }
    }
    async logout() {
        try {
            if (this.session?.refreshToken) {
                await this.http.request(`${OAUTH_BASE_URL}/token`, {
                    method: "DELETE",
                    responseType: "void",
                    headers: {
                        Accept: "*/*",
                        refresh_token: this.session.refreshToken,
                    },
                });
            }
        }
        finally {
            this.session = null;
            await this.sessionStore.delete(this.email);
        }
    }
    async listFolders() {
        await this.ensureLoggedIn();
        const data = await this.http.request(`${this.mailboxBase()}/folders?absoluteURI=false`, {
            auth: true,
            headers: { Accept: MIME.folders },
        });
        return data.folders ?? [];
    }
    async createFolder(input) {
        await this.ensureLoggedIn();
        const payload = typeof input === "string" ? { folderName: input, folderType: "USER_DEFINED" } : {
            folderName: input.name,
            folderType: input.folderType ?? "USER_DEFINED",
        };
        return this.http.request(`${this.mailboxBase()}/Folder?absoluteURI=false`, {
            method: "POST",
            auth: true,
            headers: {
                Accept: MIME.folder,
                "Content-Type": MIME.folderCreate,
            },
            json: payload,
        });
    }
    renameFolder(folderId, name) {
        return this.updateFolder(folderId, { folderName: name });
    }
    async moveFolder(folderId, parentFolderId) {
        return this.updateFolder(folderId, { parentFolderURI: folderUri(parentFolderId) });
    }
    setFolderExpireDays(folderId, days) {
        return this.updateFolder(folderId, { expire: days });
    }
    async updateFolder(folderId, patch) {
        await this.ensureLoggedIn();
        return this.http.request(`${this.mailboxBase()}/Folder/${encodeURIComponent(normalizeFolderId(folderId))}?absoluteURI=false`, {
            method: "POST",
            auth: true,
            headers: {
                Accept: MIME.folder,
                "Content-Type": MIME.folderUpdate,
            },
            json: patch,
        });
    }
    async deleteFolder(folderId) {
        await this.ensureLoggedIn();
        await this.http.request(`${this.mailboxBase()}/Folder/${encodeURIComponent(normalizeFolderId(folderId))}?absoluteURI=false`, {
            method: "DELETE",
            auth: true,
            responseType: "void",
            headers: { Accept: "application/json" },
        });
    }
    async search(query, options = {}) {
        await this.ensureLoggedIn();
        const body = {
            amount: options.amount ?? 25,
            excludeFolderTypeOrId: options.excludeFolderTypeOrId ?? DEFAULT_EXCLUDED_FOLDERS,
            include: [{ conditions: [`mail.header:from,replyTo,cc,bcc,to,subject:${escapeMailConditionValue(query)}`] }],
            orderBy: options.orderBy ?? "INTERNALDATE desc",
            preferAbsoluteURIs: false,
        };
        return this.http.request(`${this.mailboxBase()}/Mail/Query?absoluteURI=false`, {
            method: "POST",
            auth: true,
            headers: {
                Accept: MIME.messages,
                "Content-Type": MIME.mailQuery,
            },
            json: body,
        });
    }
    async findBySubject(subject, options) {
        const response = await this.search(subject, options);
        const needle = subject.toLowerCase();
        return (response.mail ?? []).filter((message) => (message.mailHeader?.subject ?? "").toLowerCase().includes(needle));
    }
    async findBySender(sender, options) {
        const response = await this.search(sender, options);
        const needle = sender.toLowerCase();
        return (response.mail ?? []).filter((message) => (message.mailHeader?.from ?? "").toLowerCase().includes(needle));
    }
    async listByFolder(folderId, options = {}) {
        await this.ensureLoggedIn();
        const params = new URLSearchParams({ absoluteURI: "false" });
        params.set("orderBy", options.orderBy ?? "INTERNALDATE desc");
        if (options.amount !== undefined)
            params.set("amount", String(options.amount));
        if (options.condition)
            params.set("condition", options.condition);
        if (options.tagsShowAll !== undefined)
            params.set("tagsShowAll", String(options.tagsShowAll));
        const accept = options.format === "uris" ? MIME.uriList : MIME.messages;
        const text = await this.http.request(`${this.mailboxBase()}/Folder/${encodeURIComponent(normalizeFolderId(folderId))}/Mail?${params}`, {
            auth: true,
            responseType: "text",
            headers: { Accept: accept },
        });
        const trimmed = text.trim();
        if (trimmed.startsWith("{"))
            return JSON.parse(trimmed);
        return { mailIds: parseUriList(text), raw: text };
    }
    async listIncoming(options = {}) {
        const excludedFolderTypeOrId = new Set((options.excludeFolderTypeOrId ?? DEFAULT_EXCLUDED_FOLDERS).map((value) => value.toUpperCase()));
        if (options.includeSpam === false)
            excludedFolderTypeOrId.add("SPAM");
        const folders = this.flattenFolders(await this.listFolders()).filter((folder) => {
            const folderType = folder.attribute?.folderType;
            const folderIdentifier = folder.folderIdentifier;
            if (!folderIdentifier || !folderType)
                return false;
            return !excludedFolderTypeOrId.has(folderType.toUpperCase()) && !excludedFolderTypeOrId.has(folderIdentifier.toUpperCase());
        });
        const sourceFolders = folders.flatMap((folder) => {
            const folderIdentifier = folder.folderIdentifier;
            const folderType = folder.attribute?.folderType;
            if (!folderIdentifier || !folderType)
                return [];
            const folderName = folder.attribute?.folderName ?? folder.attribute?.folderFullname;
            return [
                {
                    folderIdentifier,
                    folderType,
                    ...(folderName !== undefined ? { folderName } : {}),
                },
            ];
        });
        const responses = await mapWithConcurrency(sourceFolders, LIST_INCOMING_FOLDER_CONCURRENCY, async (sourceFolder) => {
            const listOptions = {
                amount: options.amount ?? 25,
                tagsShowAll: options.tagsShowAll ?? true,
                format: "messages",
            };
            if (options.orderBy !== undefined)
                listOptions.orderBy = options.orderBy;
            if (options.condition !== undefined)
                listOptions.condition = options.condition;
            const response = await this.listByFolder(sourceFolder.folderIdentifier, listOptions);
            if (isUriListResponse(response))
                return [];
            return (response.mail ?? []).map((mail) => ({ ...mail, sourceFolder }));
        });
        const mail = responses
            .flat()
            .sort((left, right) => (right.mailHeader?.date ?? 0) - (left.mailHeader?.date ?? 0));
        return {
            mail,
            totalCount: mail.length,
            unreadCount: mail.filter((message) => message.attribute?.read === false).length,
            folders: sourceFolders,
        };
    }
    async syncFolder(folderId, options = {}) {
        const listOptions = { format: "uris" };
        if (options.orderBy !== undefined)
            listOptions.orderBy = options.orderBy;
        if (options.condition !== undefined) {
            listOptions.condition = options.condition;
        }
        else if (options.after !== undefined) {
            const timestamp = options.after instanceof Date ? options.after.getTime() : options.after;
            listOptions.condition = `mail.internaldate.after:${timestamp}`;
        }
        const response = await this.listByFolder(folderId, listOptions);
        if (!isUriListResponse(response)) {
            return {
                mailIds: (response.mail ?? []).flatMap((mail) => mail.attribute?.mailIdentifier ?? []),
                raw: "",
            };
        }
        return response;
    }
    async getBody(mailId, options = {}) {
        await this.ensureLoggedIn();
        const normalizedMailId = normalizeMailId(mailId);
        const body = await this.http.request(`${this.mailboxBase()}/Mail/${encodeURIComponent(normalizedMailId)}/Body?absoluteURI=false`, {
            auth: true,
            responseType: "text",
            headers: { Accept: options.format === "text" ? "text/plain" : MIME.bodyHtml },
        });
        if (options.markRead !== false)
            await this.markReadAfterBodyFetch(normalizedMailId).catch(() => undefined);
        return body;
    }
    async getPreview(mailIds) {
        await this.ensureLoggedIn();
        const form = new URLSearchParams();
        for (const mailId of this.arrayOf(mailIds))
            form.append("mailIdentifier", normalizeMailId(mailId));
        const sse = await this.http.request(`${this.mailboxBase()}/Mail/bodypreviews`, {
            method: "POST",
            auth: true,
            form,
            responseType: "sse",
            headers: { Accept: MIME.bodyPreviewSse },
        });
        return parseSseJsonData(sse);
    }
    async send(input) {
        await this.ensureLoggedIn();
        const url = this.submissionUrl({ uuid: input.uuid, includeSubmissionMetadata: true });
        return this.submitMessage(url, await this.buildPayload(input));
    }
    async reply(input) {
        await this.ensureLoggedIn();
        const to = input.to ?? input.originalMail?.mailHeader?.from;
        if (!to) {
            throw new MailComValidationError("reply requires `to` or `originalMail.mailHeader.from`.");
        }
        const payload = await this.buildPayload({
            ...input,
            to,
            subject: input.subject ?? replySubject(input.originalMail?.mailHeader?.subject),
        });
        return this.submitMessage(this.submissionUrl({
            uuid: input.uuid,
            inReplyTo: normalizeMailId(input.originalMailId),
        }), payload);
    }
    async forward(input) {
        await this.ensureLoggedIn();
        const payload = await this.buildPayload({
            ...input,
            subject: input.subject ?? forwardSubject(input.originalMail?.mailHeader?.subject),
        });
        return this.submitMessage(this.submissionUrl({
            uuid: input.uuid,
            forwardedOriginal: normalizeMailId(input.originalMailId),
        }), payload);
    }
    async listDrafts() {
        const response = await this.listByFolder("DRAFTS", { format: "messages" });
        if (isUriListResponse(response))
            return { mail: [], totalCount: response.mailIds.length };
        return response;
    }
    async createDraft(input) {
        await this.ensureLoggedIn();
        const payload = await this.buildPayload(input);
        const response = await this.http.request(`${this.mailboxBase()}/Folder/DRAFTS/Mail?absoluteURI=false&MailSizeLimitExceededExceptionMapper.explicitCode=true`, {
            method: "POST",
            auth: true,
            responseType: "raw",
            headers: {
                Accept: "application/json",
                "Content-Type": MIME.minimalMailMessage,
            },
            json: payload,
        });
        return this.draftFromWriteResponse(response, "Draft create");
    }
    async updateDraft(draftId, input) {
        await this.ensureLoggedIn();
        const payload = await this.buildPayload(input);
        const response = await this.http.request(`${this.mailboxBase()}/Mail/${encodeURIComponent(normalizeMailId(draftId))}?absoluteURI=false&MailSizeLimitExceededExceptionMapper.explicitCode=true`, {
            method: "POST",
            auth: true,
            responseType: "raw",
            headers: {
                Accept: "application/vnd.ui.trinity.message+json",
                "Content-Type": MIME.minimalMailMessage,
            },
            json: payload,
        });
        return this.draftFromWriteResponse(response, "Draft update");
    }
    async batchUpdate(mailIds, patch) {
        await this.ensureLoggedIn();
        return this.http.request(`${this.mailboxBase()}/MailBatchUpdate`, {
            method: "POST",
            auth: true,
            headers: {
                Accept: MIME.batchUpdateResult,
                "Content-Type": MIME.batchUpdate,
            },
            json: {
                ...patch,
                mailURIs: this.arrayOf(mailIds).map(mailUri),
            },
        });
    }
    async markReadAfterBodyFetch(mailId) {
        await this.batchUpdate(mailId, { read: true });
    }
    moveToFolder(mailIds, folderId) {
        return this.batchUpdate(mailIds, { folderURI: folderUri(folderId) });
    }
    markSpam(mailIds) {
        return this.batchUpdate(mailIds, { folderType: "SPAM", flagged: false });
    }
    markNotSpam(mailIds) {
        return this.batchUpdate(mailIds, { folderType: "INBOX", flagged: false });
    }
    moveToTrash(mailIds) {
        return this.batchUpdate(mailIds, { folderType: "TRASH", flagged: false });
    }
    async deletePermanent(mailIds) {
        await this.ensureLoggedIn();
        const form = new URLSearchParams();
        for (const id of this.arrayOf(mailIds))
            form.append("mailURI", mailUri(id));
        form.set("moveToTrash", "false");
        await this.http.request(`${this.mailboxBase()}/MailBatchDelete`, {
            method: "POST",
            auth: true,
            form,
            responseType: "void",
            headers: { Accept: "*/*" },
        });
    }
    async emptyTrash() {
        await this.ensureLoggedIn();
        await this.http.request(`${this.mailboxBase()}/Folder/TRASH/Mail?absoluteURI=false&moveToTrash=false`, {
            method: "DELETE",
            auth: true,
            responseType: "void",
            headers: { Accept: "application/json" },
        });
    }
    async downloadAttachment(mailId, attachmentId, thumbnail) {
        await this.ensureLoggedIn();
        const headers = {};
        if (thumbnail) {
            headers.Accept = `image/vnd.ui.trinity.thumbnail+jpg; width="${thumbnail.width ?? 100}"; height="${thumbnail.height ?? 100}";`;
        }
        const response = await this.http.request(`${this.mailboxBase()}/Mail/${encodeURIComponent(normalizeMailId(mailId))}/Attachment/${encodeURIComponent(normalizeAttachmentId(attachmentId))}`, {
            auth: true,
            responseType: "binary",
            headers,
        });
        return {
            data: response.data,
            contentType: response.headers.get("content-type"),
            filename: filenameFromContentDisposition(response.headers.get("content-disposition")),
        };
    }
    async aliases() {
        return this.accountGet("/MailAccount/accountId/emailaddresses?absoluteURI=false&q.type.in=SENDER,MAIL_COLLECT&q.state.in=ACTIVE", MIME.mailAddresses);
    }
    async updateAliasDisplayName(address, displayName) {
        await this.ensureLoggedIn();
        const aliases = await this.aliases();
        const alias = aliases.mailaddresslist?.find((item) => item.address.toLowerCase() === address.toLowerCase());
        if (!alias)
            throw new MailComValidationError(`Alias not found: ${address}`);
        await this.http.request(`${HSP2_BASE_URL}/massrv/MailAccount/accountId/EmailAddress/${encodeMailAddressPath(alias.address)}`, {
            method: "PUT",
            auth: true,
            responseType: "void",
            headers: { "Content-Type": MIME.minimalMailAddress },
            json: {
                displayName,
                type: alias.type,
                entryDate: alias.entryDate,
                address: alias.address,
                defaultSenderAddress: alias.defaultSenderAddress,
                defaultReceiverAddress: alias.defaultReceiverAddress,
                pgpEnabled: alias.pgpEnabled,
                deletable: alias.deletable,
            },
        });
    }
    async accountGet(path, accept) {
        await this.ensureLoggedIn();
        return this.http.request(`${HSP2_BASE_URL}/massrv${path}`, {
            auth: true,
            headers: { Accept: accept },
        });
    }
    async userData() {
        await this.ensureLoggedIn();
        return this.http.request(`${MOBSI_BASE_URL}/UserData`, {
            auth: true,
            headers: { Accept: "application/json" },
        });
    }
    async validateRecipients(addresses) {
        await this.ensureLoggedIn();
        return this.http.request(`${HSP2_BASE_URL}/massrv/MailAccount/emailaddressvalidations`, {
            method: "POST",
            auth: true,
            headers: {
                Accept: MIME.validationResponse,
                "Content-Type": MIME.validationRequest,
            },
            json: this.arrayOf(addresses),
        });
    }
    async submitMessage(url, payload) {
        const sse = await this.http.request(url, {
            method: "POST",
            auth: true,
            responseType: "sse",
            headers: {
                Accept: MIME.eventStream,
                "Content-Type": MIME.minimalMailMessage,
            },
            json: payload,
        });
        return parseMailSubmissionResult(sse);
    }
    async buildPayload(input) {
        const attachments = input.attachments ?? [];
        validateAttachments(attachments);
        const from = input.from ?? (await this.defaultSender());
        return {
            mailHeader: {
                from,
                to: this.arrayOf(input.to),
                cc: this.arrayOf(input.cc),
                bcc: this.arrayOf(input.bcc),
                subject: input.subject ?? "",
                date: input.date ?? Date.now(),
                priority: input.priority ?? "3",
                ...(input.dispositionNotificationTo
                    ? { dispositionNotificationTo: this.arrayOf(input.dispositionNotificationTo) }
                    : {}),
            },
            htmlBody: input.htmlBody,
            attachments: attachments.map(encodeAttachment),
        };
    }
    async draftFromWriteResponse(response, label) {
        const responseText = await response.text();
        if (responseText.trim())
            return JSON.parse(responseText);
        const location = response.headers.get("location");
        if (!location) {
            throw new MailComError(`${label} succeeded but mail.com returned no body and no Location header.`);
        }
        return this.findDraftById(normalizeMailId(location), label);
    }
    async findDraftById(draftId, label) {
        const drafts = await this.listDrafts();
        const match = drafts.mail?.find((mail) => mailMatchesId(mail, draftId));
        if (!match) {
            throw new MailComError(`${label} succeeded but draft ${draftId} could not be found after refetch.`);
        }
        return match;
    }
    async defaultSender() {
        const aliases = await this.aliases().catch(() => null);
        const sender = aliases?.mailaddresslist?.find((alias) => alias.defaultSenderAddress) ?? aliases?.mailaddresslist?.[0];
        if (!sender?.address)
            return this.email;
        return sender.displayName ? `${formatDisplayName(sender.displayName)} <${sender.address}>` : sender.address;
    }
    flattenFolders(folders) {
        return folders.flatMap((folder) => [folder, ...this.flattenFolders(folder.folders ?? [])]);
    }
    async ensureLoggedIn() {
        if (this.session?.accessToken)
            return;
        await this.loginWithLock();
    }
    async loginWithLock() {
        if (!this.loginInFlight) {
            this.loginInFlight = this.login().finally(() => {
                this.loginInFlight = null;
            });
        }
        return this.loginInFlight;
    }
    async refreshWithLock(refreshToken = this.session?.refreshToken, tokenBasicAuth = this.currentTokenBasicAuth) {
        const key = `${tokenBasicAuth}\0${refreshToken ?? ""}`;
        if (!this.refreshInFlight || this.refreshInFlight.key !== key) {
            const promise = this.refresh(refreshToken, tokenBasicAuth).finally(() => {
                if (this.refreshInFlight?.key === key) {
                    this.refreshInFlight = null;
                }
            });
            this.refreshInFlight = { key, promise };
        }
        return this.refreshInFlight.promise;
    }
    async loginWithAndroidOAuth() {
        if (!this.password) {
            throw new MailComAuthError("Password is required for Android OAuth login.");
        }
        const verifier = base64Url(randomBytes(48));
        const challenge = base64Url(createHash("sha256").update(verifier).digest());
        const state = base64Url(randomBytes(48));
        const cookies = new CookieJar();
        const authorizeUrl = new URL(`${OAUTH_BASE_URL}/authorize`);
        authorizeUrl.search = new URLSearchParams({
            client_id: ANDROID_CLIENT_ID,
            redirect_uri: ANDROID_REDIRECT_URI,
            response_type: "code",
            state,
            code_challenge: challenge,
            login_hint: this.email,
            code_challenge_method: "S256",
        }).toString();
        const authorize = await this.webviewRequest(authorizeUrl, cookies);
        const loginAppUrl = this.requiredLocation(authorize, "authorize redirect");
        const authcodeContext = new URL(loginAppUrl).searchParams.get("authcode-context");
        if (!authcodeContext)
            throw new MailComAuthError("Android OAuth login did not return authcode-context.");
        await this.webviewRequest(loginAppUrl, cookies);
        const loginFailedUrl = new URL("https://auth.mail.com/loginapp/oauth2");
        loginFailedUrl.searchParams.set("status", "login_failed");
        loginFailedUrl.searchParams.set("login_hint", this.email);
        loginFailedUrl.searchParams.set("authcode-context", authcodeContext);
        const loginForm = new URLSearchParams({
            password: this.password,
            service: "oauth2",
            successURL: `${OAUTH_BASE_URL}/authcode?authcode-context=${authcodeContext}`,
            loginFailedURL: loginFailedUrl.toString(),
            loginErrorURL: "https://auth.mail.com/login/error",
            statistics: "",
            username: this.email,
        });
        const login = await this.webviewRequest("https://login.mail.com/login", cookies, {
            method: "POST",
            headers: {
                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Content-Type": "application/x-www-form-urlencoded",
                Origin: "https://auth.mail.com",
                Referer: loginAppUrl,
            },
            body: loginForm,
        });
        const authcodeUrl = this.requiredLocation(login, "login redirect");
        const authcode = await this.webviewRequest(authcodeUrl, cookies);
        const appRedirect = this.requiredLocation(authcode, "authcode redirect");
        const redirectUrl = new URL(appRedirect);
        const code = redirectUrl.searchParams.get("code");
        const returnedState = redirectUrl.searchParams.get("state");
        if (!code)
            throw new MailComAuthError("Android OAuth login did not return authorization code.");
        if (returnedState !== state)
            throw new MailComAuthError("Android OAuth state mismatch.");
        const token = await this.oauthToken({
            grant_type: "authorization_code",
            code,
            redirect_uri: ANDROID_REDIRECT_URI,
            client_id: ANDROID_CLIENT_ID,
            code_verifier: verifier,
        }, DEFAULT_ANDROID_OAUTH_BASIC_AUTH);
        if (!token.access_token || !token.refresh_token) {
            throw new MailComAuthError(token.error_description ?? token.error ?? "mail.com Android OAuth token exchange failed.");
        }
        this.currentTokenBasicAuth = DEFAULT_ANDROID_OAUTH_BASIC_AUTH;
        this.session = this.toSession(token);
        return this.refresh(token.refresh_token, DEFAULT_ANDROID_OAUTH_BASIC_AUTH);
    }
    async webviewRequest(url, cookies, init = {}) {
        const headers = new Headers(init.headers);
        headers.set("User-Agent", WEBVIEW_USER_AGENT);
        headers.set("Accept-Language", "en-IN,en-GB;q=0.9,en;q=0.8");
        const cookieHeader = cookies.header();
        if (cookieHeader)
            headers.set("Cookie", cookieHeader);
        const response = await this.fetchImpl(url, {
            ...init,
            headers,
            redirect: "manual",
        });
        cookies.absorb(response.headers);
        return response;
    }
    requiredLocation(response, label) {
        const location = response.headers.get("location");
        if (!location)
            throw new MailComAuthError(`Android OAuth ${label} did not include Location header.`);
        return location;
    }
    async oauthToken(formInput, authorization = this.currentTokenBasicAuth) {
        const form = new URLSearchParams(formInput);
        const response = await this.fetchImpl(`${OAUTH_BASE_URL}/token`, {
            method: "POST",
            headers: {
                ...APP_HEADERS,
                Accept: "*/*",
                Authorization: authorization,
                "Content-Type": 'application/x-www-form-urlencoded;charset="UTF-8"',
            },
            body: form,
        });
        const json = (await response.json().catch(() => ({})));
        if (!response.ok) {
            throw new MailComAuthError(json.error_description ?? json.error ?? `OAuth token request failed with ${response.status}`);
        }
        return json;
    }
    toSession(token, retainedRefreshToken) {
        if (!token.access_token)
            throw new MailComAuthError("OAuth response did not include access_token.");
        const now = Date.now();
        return {
            accessToken: token.access_token,
            refreshToken: token.refresh_token ?? retainedRefreshToken ?? this.session?.refreshToken ?? "",
            accountEmail: this.accountKey(),
            createdAt: this.session?.createdAt ?? now,
            updatedAt: now,
            ...(token.expires_in ? { expiresAt: now + token.expires_in * 1000 } : {}),
        };
    }
    isSessionBoundToClient(session) {
        return session.accountEmail === this.accountKey();
    }
    accountKey() {
        return this.email.trim().toLowerCase();
    }
    submissionUrl(input = {}) {
        const params = new URLSearchParams();
        if (input.inReplyTo)
            params.set("@SUBMISSION-TRANSIENT-IN-REPLY-TO", input.inReplyTo);
        if (input.forwardedOriginal)
            params.set("@SUBMISSION-TRANSIENT-FORWARDED-ORIGINAL", input.forwardedOriginal);
        if (input.includeSubmissionMetadata || input.uuid || input.inReplyTo || input.forwardedOriginal) {
            params.set("@SUBMISSION-TRANSIENT-UUID", input.uuid ?? crypto.randomUUID());
            params.set("MailSizeLimitExceededExceptionMapper.explicitCode", "true");
        }
        const query = params.toString();
        return `${this.mailboxBase()}/Mailsubmission${query ? `?${query}` : ""}`;
    }
    mailboxBase() {
        return `${HSP2_BASE_URL}/msgsrv/Mailbox/primaryMailbox`;
    }
    arrayOf(value) {
        if (value === undefined)
            return [];
        return Array.isArray(value) ? value : [value];
    }
}
function mailMatchesId(mail, mailId) {
    const candidate = mail.attribute?.mailIdentifier ?? mail.mailURI;
    return typeof candidate === "string" && normalizeMailId(candidate) === mailId;
}
function escapeMailConditionValue(value) {
    return value
        .replace(/\\/g, "\\\\")
        .replace(/:/g, "\\:")
        .replace(/\r\n?|\n/g, " ");
}
async function mapWithConcurrency(items, concurrency, mapper) {
    const results = [];
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (nextIndex < items.length) {
            const currentIndex = nextIndex;
            nextIndex += 1;
            results[currentIndex] = await mapper(items[currentIndex], currentIndex);
        }
    });
    await Promise.all(workers);
    return results;
}
function encodeAttachment(input) {
    validateAttachmentData(input);
    return {
        contentType: input.contentType,
        filename: input.filename,
        base64data: input.base64data ?? (input.data === undefined ? "" : toBase64(input.data)),
    };
}
function formatDisplayName(name) {
    if (/[",()<>[\]:;@\\]/.test(name)) {
        return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return name;
}
function replySubject(subject) {
    const trimmed = subject?.trim();
    if (!trimmed)
        return "Re:";
    return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}
function forwardSubject(subject) {
    const trimmed = subject?.trim();
    if (!trimmed)
        return "Fwd:";
    return /^fwd?:/i.test(trimmed) ? trimmed : `Fwd: ${trimmed}`;
}
function validateAttachments(attachments) {
    for (const attachment of attachments)
        validateAttachmentData(attachment);
    validateAttachmentSize(attachments);
}
function validateAttachmentData(attachment) {
    if (attachment.data === undefined && attachment.base64data === undefined) {
        throw new MailComValidationError(`Attachment "${attachment.filename}" requires data or base64data.`);
    }
    if (attachment.data !== undefined && attachment.base64data !== undefined) {
        throw new MailComValidationError(`Attachment "${attachment.filename}" must not include both data and base64data.`);
    }
}
function validateAttachmentSize(attachments) {
    const totalBytes = attachments.reduce((total, attachment) => total + attachmentByteLength(attachment), 0);
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
        throw new MailComValidationError(`Attachments exceed the 25 MB limit (${totalBytes} bytes > ${MAX_TOTAL_ATTACHMENT_BYTES} bytes).`);
    }
}
function attachmentByteLength(attachment) {
    if (attachment.data !== undefined)
        return dataByteLength(attachment.data);
    if (attachment.base64data !== undefined)
        return base64ByteLength(attachment.base64data);
    return 0;
}
function dataByteLength(data) {
    if (typeof data === "string")
        return Buffer.byteLength(data, "utf8");
    if (data instanceof ArrayBuffer)
        return data.byteLength;
    return data.byteLength;
}
function base64ByteLength(base64data) {
    const normalized = base64data.replace(/\s/g, "");
    if (!normalized)
        return 0;
    const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
    return Math.floor((normalized.length * 3) / 4) - padding;
}
function encodeMailAddressPath(address) {
    return encodeURIComponent(address).replace(/%40/gi, "@");
}
function toBase64(data) {
    if (typeof data === "string")
        return Buffer.from(data, "utf8").toString("base64");
    if (data instanceof ArrayBuffer)
        return Buffer.from(data).toString("base64");
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64");
}
function filenameFromContentDisposition(value) {
    if (!value)
        return null;
    const utf8 = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    if (utf8)
        return safeAttachmentFilename(safeDecode(utf8));
    const quoted = value.match(/filename="([^"]+)"/i)?.[1];
    if (quoted)
        return safeAttachmentFilename(quoted);
    const unquoted = value.match(/filename=([^;]+)/i)?.[1] ?? null;
    return unquoted ? safeAttachmentFilename(unquoted) : null;
}
function safeDecode(value) {
    try {
        return decodeURIComponent(value);
    }
    catch {
        return value;
    }
}
function safeAttachmentFilename(value) {
    const filename = value.replace(/\0/g, "").trim().split(/[\\/]+/).filter(Boolean).at(-1);
    if (!filename || filename === "." || filename === "..")
        return null;
    return filename;
}
function isUriListResponse(response) {
    return Array.isArray(response.mailIds);
}
function base64Url(data) {
    return data.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
class CookieJar {
    values = new Map();
    header() {
        return [...this.values.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
    }
    absorb(headers) {
        for (const cookie of getSetCookies(headers)) {
            const [pair] = cookie.split(";");
            if (!pair)
                continue;
            const index = pair.indexOf("=");
            if (index <= 0)
                continue;
            this.values.set(pair.slice(0, index), pair.slice(index + 1));
        }
    }
}
function getSetCookies(headers) {
    const withNodeHelper = headers;
    const cookies = withNodeHelper.getSetCookie?.();
    if (cookies?.length)
        return cookies;
    const combined = headers.get("set-cookie");
    return combined ? [combined] : [];
}
