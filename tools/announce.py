"""Post what's new on TreeNerd to the Telegram channel.

Run by .github/workflows/announce.yml after a push to main. The message is built only from entries
newly added to CHANGELOG.md in that push, so the channel says exactly what the changelog says.
Entries under an "Internal" heading are for developers and are never posted.

    python tools/announce.py OLD_CHANGELOG NEW_CHANGELOG            # print the message(s)
    python tools/announce.py OLD_CHANGELOG NEW_CHANGELOG --send     # post them

Sending needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the environment.
"""
from __future__ import annotations

import html
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

SITE = "https://treenerd.fyi"
SKIP_SECTIONS = {"internal"}
LIMIT = 3800  # Telegram allows 4096 characters per message


def parse(text: str) -> list[tuple[str, str, str]]:
    """(release title, section, bullet) for every bullet in a changelog."""
    out, release, section = [], "", ""
    for line in text.splitlines():
        if line.startswith("## "):
            release, section = line[3:].strip(), ""
        elif line.startswith("### "):
            section = line[4:].strip()
        elif line.startswith("- ") and release:
            out.append((release, section, line[2:].strip()))
    return out


def new_entries(old: str, new: str) -> list[tuple[str, str, str]]:
    """Bullets present in the new changelog and not in the old one, minus developer-only sections."""
    before = {bullet for _, _, bullet in parse(old)}
    return [e for e in parse(new) if e[2] not in before and e[1].lower() not in SKIP_SECTIONS]


def plain(markdown: str) -> str:
    """Changelog Markdown to Telegram HTML: drop code ticks and link syntax, keep bold."""
    s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", markdown)
    s = html.escape(s.replace("`", ""), quote=False)
    return re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", s)


def title_of(release: str) -> str:
    """'2026-11-10: Rankings and changes' -> 'Rankings and changes'."""
    return release.split(":", 1)[1].strip() if ":" in release else release


def messages(entries: list[tuple[str, str, str]]) -> list[str]:
    """One or more Telegram messages (HTML), split between sections when long."""
    if not entries:
        return []
    blocks, current = [], None
    for release, section, bullet in entries:
        key = (release, section)
        if key != current:
            head = f"<b>{plain(section)}</b>" if section else ""
            blocks.append([release, head, []])
            current = key
        blocks[-1][2].append(f"• {plain(bullet)}")
    out, body, release_shown = [], "", None
    header = "🌳 <b>TreeNerd update</b>"
    footer = f"\n\n{SITE}"
    for release, head, bullets in blocks:
        part = ""
        if release != release_shown:
            part += f"\n\n<i>{plain(title_of(release))}</i>"
        part += "\n\n" + "\n".join(([head] if head else []) + bullets)
        if body and len(header) + len(body) + len(part) + len(footer) > LIMIT:
            out.append(header + body + footer)
            body, part = "", f"\n\n<i>{plain(title_of(release))} (continued)</i>\n\n" + "\n".join(([head] if head else []) + bullets)
        body += part
        release_shown = release
    out.append(header + body + footer)
    return [m[:4090] for m in out]


def send(text: str, token: str, chat: str) -> None:
    data = urllib.parse.urlencode({"chat_id": chat, "text": text, "parse_mode": "HTML",
                                   "disable_web_page_preview": "true"}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", data=data)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            if not json.load(r).get("ok"):
                raise RuntimeError("Telegram did not accept the message")
    except urllib.error.HTTPError as e:  # never print the request URL: it contains the bot token
        detail = ""
        try:
            detail = json.load(e).get("description", "")
        except Exception:
            pass
        raise RuntimeError(f"Telegram returned {e.code}: {detail}") from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"could not reach Telegram: {e.reason}") from None


def main(argv: list[str]) -> int:
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 2:
        print(__doc__)
        return 2
    read = lambda p: open(p, encoding="utf-8").read() if os.path.exists(p) else ""
    msgs = messages(new_entries(read(args[0]), read(args[1])))
    if not msgs:
        print("No new changelog entries for visitors: nothing to announce.")
        return 0
    for m in msgs:
        print(m, "\n" + "-" * 40)
    if "--send" not in argv:
        return 0
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip(), os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not token or not chat:
        print("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set: not sent.")
        return 0
    for m in msgs:
        send(m, token, chat)
    print(f"Posted {len(msgs)} message(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
