export class MailComError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "MailComError";
    }
}
export class MailComApiError extends MailComError {
    status;
    method;
    url;
    body;
    constructor(input) {
        super(input.message);
        this.name = "MailComApiError";
        this.status = input.status;
        this.method = input.method;
        this.url = input.url;
        this.body = input.body;
    }
}
export class MailComAuthError extends MailComError {
    constructor(message) {
        super(message);
        this.name = "MailComAuthError";
    }
}
export class MailComValidationError extends MailComError {
    constructor(message) {
        super(message);
        this.name = "MailComValidationError";
    }
}
