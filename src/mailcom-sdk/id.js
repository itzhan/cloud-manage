export function normalizeMailId(input) {
    const decoded = safeDecode(input.trim());
    const match = decoded.match(/(?:^|\/)Mail\/([^/?#]+)/);
    if (match?.[1])
        return match[1];
    return decoded.replace(/^(\.\.\/)*Mail\//, "").replace(/^\/+/, "");
}
export function normalizeAttachmentId(input) {
    const decoded = safeDecode(input.trim());
    const match = decoded.match(/(?:^|\/)Attachment\/([^/?#]+)/);
    if (match?.[1])
        return match[1];
    return decoded.replace(/^(\.\.\/)*Attachment\//, "").replace(/^\/+/, "");
}
export function normalizeFolderId(input) {
    const decoded = safeDecode(input.trim());
    const match = decoded.match(/(?:^|\/)Folder\/([^/?#]+)/);
    if (match?.[1])
        return match[1];
    return decoded.replace(/^(\.\.\/)*Folder\//, "").replace(/^\/+/, "");
}
export function mailUri(mailId) {
    return `../../Mail/${normalizeMailId(mailId)}`;
}
export function folderUri(folderId) {
    return `/Folder/${normalizeFolderId(folderId)}`;
}
export function parseUriList(text) {
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"))
        .map(normalizeMailId);
}
function safeDecode(value) {
    try {
        return decodeURIComponent(value);
    }
    catch {
        return value;
    }
}
