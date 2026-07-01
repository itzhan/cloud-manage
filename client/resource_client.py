"""
Resource Hub 客户端 — 集中式资源管理服务器的 Python 客户端

用法:
    from resource_client import ResourceHub

    hub = ResourceHub("http://192.168.1.100:4800", "your-api-key", "win-server-01")

    # 拉取资源
    result = hub.pull_cards(count=5, platform="claude", brand="小马哥-2")
    cards = result["cards"]

    # 上报结果
    hub.report_card(card_id="card_xxx", platform="claude", success=True)

    # 释放未使用的资源
    hub.release_cards(["card_yyy"], platform="claude")

    # 查看统计
    stats = hub.stats()
"""

import socket
import requests
from typing import Optional, List, Dict, Any


class ResourceHub:
    def __init__(self, base_url: str, api_key: str, machine_id: str = None):
        self.base_url = base_url.rstrip("/")
        self.machine_id = machine_id or socket.gethostname()
        self.session = requests.Session()
        self.session.headers["X-API-Key"] = api_key
        self.session.headers["Content-Type"] = "application/json"

    def _post(self, path: str, data: dict) -> dict:
        r = self.session.post(f"{self.base_url}{path}", json=data, timeout=30)
        r.raise_for_status()
        return r.json()

    def _get(self, path: str) -> dict:
        r = self.session.get(f"{self.base_url}{path}", timeout=30)
        r.raise_for_status()
        return r.json()

    # ── Cards ──

    def pull_cards(self, count: int = 1, platform: str = "claude",
                   brand: str = None, min_balance: float = None) -> dict:
        data: Dict[str, Any] = {"count": count, "machineId": self.machine_id, "platform": platform}
        if brand is not None:
            data["brand"] = brand
        if min_balance is not None:
            data["minBalance"] = min_balance
        return self._post("/api/cards/pull", data)

    def release_cards(self, card_ids: List[str], platform: str = "claude") -> dict:
        return self._post("/api/cards/release", {
            "machineId": self.machine_id, "cardIds": card_ids, "platform": platform,
        })

    def report_card(self, card_id: str, platform: str, success: bool,
                    email: str = None, deduct_balance: float = None) -> dict:
        report: Dict[str, Any] = {"cardId": card_id, "platform": platform, "success": success}
        if email:
            report["email"] = email
        if deduct_balance is not None:
            report["deductBalance"] = deduct_balance
        return self._post("/api/cards/report", {
            "machineId": self.machine_id, "reports": [report],
        })

    # ── Google ──

    def pull_google(self, count: int = 1, require_2fa: bool = False) -> dict:
        return self._post("/api/google/pull", {
            "count": count, "machineId": self.machine_id, "require2fa": require_2fa,
        })

    def release_google(self, emails: List[str]) -> dict:
        return self._post("/api/google/release", {
            "machineId": self.machine_id, "emails": emails,
        })

    def report_google(self, email: str, result: str, reason: str = None) -> dict:
        report: Dict[str, Any] = {"email": email, "result": result}
        if reason:
            report["reason"] = reason
        return self._post("/api/google/report", {
            "machineId": self.machine_id, "reports": [report],
        })

    # ── Mail.com ──

    def pull_mailcom(self, count: int = 1) -> dict:
        return self._post("/api/mailcom/pull", {
            "count": count, "machineId": self.machine_id,
        })

    def release_mailcom(self, emails: List[str]) -> dict:
        return self._post("/api/mailcom/release", {
            "machineId": self.machine_id, "emails": emails,
        })

    def report_mailcom(self, email: str, result: str, error: str = None) -> dict:
        report: Dict[str, Any] = {"email": email, "result": result}
        if error:
            report["error"] = error
        return self._post("/api/mailcom/report", {
            "machineId": self.machine_id, "reports": [report],
        })

    # ── Proxies ──

    def pull_proxies(self, count: int = 1, purpose: str = "claude",
                     region: str = None, pool: str = None) -> dict:
        data: Dict[str, Any] = {"count": count, "machineId": self.machine_id, "purpose": purpose}
        if region is not None:
            data["region"] = region
        if pool is not None:
            data["pool"] = pool
        return self._post("/api/proxies/pull", data)

    def release_proxies(self, proxies: List[dict]) -> dict:
        return self._post("/api/proxies/release", {
            "machineId": self.machine_id, "proxies": proxies,
        })

    def report_proxy(self, host: str, port: str, purpose: str, success: bool,
                     bad: bool = False, reason: str = None) -> dict:
        report: Dict[str, Any] = {"host": host, "port": str(port), "purpose": purpose, "success": success}
        if bad:
            report["result"] = "bad"
            report["reason"] = reason
        return self._post("/api/proxies/report", {
            "machineId": self.machine_id, "reports": [report],
        })

    # ── Codex ──

    def pull_codex(self, count: int = 1, min_remaining_invites: int = 1) -> dict:
        return self._post("/api/codex/pull", {
            "count": count, "machineId": self.machine_id,
            "minRemainingInvites": min_remaining_invites,
        })

    def release_codex(self, ids: List[str]) -> dict:
        return self._post("/api/codex/release", {
            "machineId": self.machine_id, "ids": ids,
        })

    def report_codex(self, cred_id: str, used_invites: int = None,
                     invites: list = None, access_token: str = None) -> dict:
        report: Dict[str, Any] = {"id": cred_id}
        if used_invites is not None:
            report["usedInvites"] = used_invites
        if invites is not None:
            report["invites"] = invites
        if access_token:
            report["accessToken"] = access_token
        return self._post("/api/codex/report", {
            "machineId": self.machine_id, "reports": [report],
        })

    # ── Stats ──

    def stats(self) -> dict:
        return self._get("/api/stats")

    # ── Import ──

    def import_cards(self, cards: list, payment_accounts: list = None) -> dict:
        data: Dict[str, Any] = {"cards": cards}
        if payment_accounts:
            data["paymentAccounts"] = payment_accounts
        return self._post("/api/cards/import", data)

    def import_google(self, accounts: list) -> dict:
        return self._post("/api/google/import", {"accounts": accounts})

    def import_mailcom(self, accounts: list) -> dict:
        return self._post("/api/mailcom/import", {"accounts": accounts})

    def import_proxies(self, proxies: list) -> dict:
        return self._post("/api/proxies/import", {"proxies": proxies})

    def import_codex(self, credentials: list) -> dict:
        return self._post("/api/codex/import", {"credentials": credentials})
