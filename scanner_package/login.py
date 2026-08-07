# -*- coding: utf-8 -*-
"""One-time Telethon login helper. Usage: python login.py <code> [2fa_password]"""
import asyncio
import sys
from telethon import TelegramClient

API_ID = 10870161
API_HASH = "81ca4e214e172c32768809cbb9463d51"
PHONE = "+916381445515"
SESSION_PATH = "telethon_session"


async def main():
    code = sys.argv[1] if len(sys.argv) > 1 else None
    password = sys.argv[2] if len(sys.argv) > 2 else None

    client = TelegramClient(SESSION_PATH, API_ID, API_HASH)

    async def code_callback():
        return code if code else input("Please enter the code you received: ")

    async def password_callback():
        return password if password else input("Please enter your 2FA password: ")

    await client.start(phone=PHONE, code_callback=code_callback, password=password_callback)
    me = await client.get_me()
    print("\nLogged in as:", me.username or me.first_name, "| session saved to", SESSION_PATH)
    await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())