# utils/notifications.py
import requests, smtplib
from email.mime.text import MIMEText
from email.header import Header
from email.utils import formataddr
import os

def send_telegram_message(order_text):
    BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
    CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")
    if not BOT_TOKEN or not CHAT_ID:
        print("❌ Telegram config missing")
        return False
    try:
        response = requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
            json={"chat_id": CHAT_ID, "text": order_text},
            timeout=5
        )
        return response.status_code == 200
    except Exception as e:
        print(f"❌ Telegram error: {e}")
        return False

def send_email_notification(order_text):
    subject = "Nova Asia - Nieuwe bestelling"
    sender = os.getenv("SMTP_USERNAME")
    password = os.getenv("SMTP_PASSWORD")
    receiver = os.getenv("FROM_EMAIL") or sender
    server_addr = os.getenv("SMTP_SERVER", "smtp.gmail.com")
    port = int(os.getenv("SMTP_PORT", "587"))

    if not all([sender, password, receiver]):
        print("❌ Email config missing")
        return False

    msg = MIMEText(order_text, "plain", "utf-8")
    msg["Subject"] = Header(subject, "utf-8")
    msg["From"] = formataddr(("NovaAsia", sender))
    msg["To"] = receiver

    try:
        with smtplib.SMTP(server_addr, port) as server:
            server.starttls()
            server.login(sender, password)
            server.sendmail(sender, [receiver], msg.as_string())
        return True
    except Exception as e:
        print(f"❌ Email error: {e}")
        return False

def send_confirmation_email(order_text, customer_email):
    sender = os.getenv("SMTP_USERNAME")
    password = os.getenv("SMTP_PASSWORD")
    subject = "Nova Asia - Bevestiging van je bestelling"
    server_addr = os.getenv("SMTP_SERVER", "smtp.gmail.com")
    port = int(os.getenv("SMTP_PORT", "587"))

    msg = MIMEText(order_text.replace("\n", "<br>"), "html", "utf-8")
    msg["Subject"] = Header(subject, "utf-8")
    msg["From"] = formataddr(("NovaAsia", sender))
    msg["To"] = customer_email

    try:
        with smtplib.SMTP(server_addr, port) as server:
            server.starttls()
            server.login(sender, password)
            server.sendmail(sender, [customer_email], msg.as_string())
        return True
    except Exception as e:
        print(f"❌ Confirmation email error: {e}")
        return False

