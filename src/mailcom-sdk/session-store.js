import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
export class MemorySessionStore {
    sessions = new Map();
    async load(email) {
        return this.sessions.get(accountKey(email)) ?? null;
    }
    async save(email, session) {
        this.sessions.set(accountKey(email), bindSessionToEmail(email, session));
    }
    async delete(email) {
        this.sessions.delete(accountKey(email));
    }
}
export class FileSessionStore {
    directory;
    constructor(directory = join(process.cwd(), ".sessions")) {
        this.directory = directory;
    }
    async load(email) {
        const latestPath = await this.latestPathFor(email);
        return latestPath ? this.readSession(latestPath) : null;
    }
    async save(email, session) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await chmod(this.directory, 0o700);
        const boundSession = bindSessionToEmail(email, session);
        const sessionPath = this.pathFor(email, boundSession);
        await writeFile(sessionPath, `${JSON.stringify(boundSession, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await chmod(sessionPath, 0o600);
        await this.deleteMatching(email, sessionPath);
    }
    async delete(email) {
        await this.deleteMatching(email);
    }
    pathFor(email, session) {
        const timestamp = session.createdAt || session.updatedAt || Date.now();
        return join(this.directory, `${this.filePrefix(email)}-${timestamp}.json`);
    }
    async latestPathFor(email) {
        const prefix = `${this.filePrefix(email)}-`;
        let files;
        try {
            files = await readdir(this.directory);
        }
        catch (error) {
            if (error.code === "ENOENT")
                return null;
            throw error;
        }
        const matches = files
            .map((file) => {
            const timestamp = file.startsWith(prefix) && file.endsWith(".json") ? Number(file.slice(prefix.length, -".json".length)) : Number.NaN;
            return { file, timestamp };
        })
            .filter((match) => Number.isFinite(match.timestamp))
            .sort((left, right) => right.timestamp - left.timestamp);
        return matches[0] ? join(this.directory, matches[0].file) : null;
    }
    async deleteMatching(email, exceptPath) {
        const prefix = `${this.filePrefix(email)}-`;
        let files;
        try {
            files = await readdir(this.directory);
        }
        catch (error) {
            if (error.code === "ENOENT")
                return;
            throw error;
        }
        await Promise.all(files
            .filter((file) => file.startsWith(prefix) && file.endsWith(".json"))
            .map((file) => join(this.directory, file))
            .filter((path) => path !== exceptPath)
            .map(unlinkIfExists));
    }
    filePrefix(email) {
        const key = accountKey(email);
        const digest = createHash("sha256").update(key).digest("hex").slice(0, 12);
        return `acct-${digest}`;
    }
    async readSession(path) {
        const text = await readFile(path, "utf8");
        return JSON.parse(text);
    }
}
function accountKey(email) {
    return email.trim().toLowerCase();
}
function bindSessionToEmail(email, session) {
    return { ...session, accountEmail: accountKey(email) };
}
async function unlinkIfExists(path) {
    try {
        await unlink(path);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
}
