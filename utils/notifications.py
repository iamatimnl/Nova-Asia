import os
import json
import requests
import smtplib
from datetime import datetime, date
from email.mime.text import MIMEText
from email.header import Header
from email.utils import formataddr

from flask import Flask, request, jsonify
from flask_cors import CORS
from flask_socketio import SocketIO

# === Flask App Setup ===
app = Flask(__name__)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*")

# === 配置 ===
BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")
SENDER_EMAIL = os.getenv("SMTP_USERNAME")
SENDER_PASSWORD = os.getenv("SMTP_PASSWORD")
RECEIVER_EMAIL = os.getenv("FROM_EMAIL", SENDER_EMAIL)
SMTP_SERVER = os.getenv("SMTP_SERVER", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))

POS_API_URL = "https://nova-asia.onrender.com/api/orders"
TIKKIE_PAYMENT_LINK = "https://tikkie.me/pay/example"

ORDERS = []  # 简单的内存订单记录

# === 功能函数 ===
def generate_order_text(order):
    """Create a human readable summary for an Order object."""
    try:
        items = json.loads(order.items or "{}")
    except Exception:
        try:
            import ast
            items = ast.literal_eval(order.items)
        except Exception:
            items = {}

    summary = "\n".join(
        f"{name} x {item.get('qty')}" for name, item in items.items()
    )
    total = sum(
        float(item.get("price", 0)) * int(item.get("qty", 0))
        for item in items.values()
    )

    is_pickup = order.order_type in ["afhalen", "pickup"]
    if is_pickup:
        details = f"[Afhalen]\nNaam: {order.customer_name}\nTelefoon: {order.phone}"
        if order.email:
            details += f"\nEmail: {order.email}"
        details += (
            f"\nAfhaaltijd: {order.pickup_time}\nBetaalwijze: {order.payment_method}"
        )
    else:
        details = f"[Bezorgen]\nNaam: {order.customer_name}\nTelefoon: {order.phone}"
        if order.email:
            details += f"\nEmail: {order.email}"
        details += (
            f"\nAdres: {order.street} {order.house_number}"
            f"\nPostcode: {order.postcode}\nBezorgtijd: {order.delivery_time}"
            f"\nBetaalwijze: {order.payment_method}"
        )

    return (
        f"📦 Nieuwe bestelling bij *Nova Asia*:\n\n{summary}\n{details}\nTotaal: €{total:.2f}"
    )

def send_telegram_message(text):
    if not BOT_TOKEN or not CHAT_ID:
        print("❌ 缺少 Telegram 配置")
        return False
    try:
        url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
        res = requests.post(url, json={"chat_id": CHAT_ID, "text": text}, timeout=5)
        return res.status_code == 200
    except Exception as e:
        print("❌ Telegram 错误:", e)
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

def send_pos_order(order_data):
    try:
        response = requests.post(POS_API_URL, json=order_data)
        if response.status_code == 200:
            return True, None
        return False, f"Status {response.status_code}: {response.text}"
    except Exception as e:
        return False, str(e)

def record_order(data, pos_ok):
    ORDERS.append({
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "name": data.get("name"),
        "items": data.get("items"),
        "paymentMethod": data.get("paymentMethod"),
        "orderType": data.get("orderType"),
        "pos_ok": pos_ok,
    })
def send_confirmation_email(subject, content, recipient):
    from email.mime.text import MIMEText
    from email.header import Header
    import smtplib
    from email.utils import formataddr
    import os

    sender = os.getenv("SMTP_USERNAME")
    password = os.getenv("SMTP_PASSWORD")
    receiver = recipient
    server_addr = os.getenv("SMTP_SERVER", "smtp.gmail.com")
    port = int(os.getenv("SMTP_PORT", "587"))

    msg = MIMEText(content, "plain", "utf-8")
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
        print(f"❌ Email confirmation failed: {e}")
        return False

def _orders_overview():
    today = date.today()
    return [
        {
            "time": datetime.fromisoformat(o["timestamp"]).strftime("%H:%M"),
            "customerName": o["name"],
            "items": o["items"],
            "paymentMethod": o["paymentMethod"],
            "orderType": o["orderType"],
            "pos_ok": o["pos_ok"]
        }
        for o in ORDERS if datetime.fromisoformat(o["timestamp"]).date() == today
    ]

# === 路由 ===

@app.route("/api/orders/today", methods=["GET"])
def get_orders_today():
    return jsonify(_orders_overview())

@app.route("/submit_order", methods=["POST"])
def submit_order():
    data = request.get_json()
    message = data.get("message", "")
    remark = data.get("remark", "")
    email = data.get("email", "")
    payment_method = data.get("paymentMethod", "").lower()

    full_message = message + (f"\nOpmerking: {remark}" if remark else "")

    telegram_ok = send_telegram_message(full_message)
    email_ok = send_email_notification(full_message)  # ✅ 发给商家自己
    pos_ok, pos_error = send_pos_order(data)
    record_order(data, pos_ok)

    if email:
        send_confirmation_email("Bestelbevestiging", full_message, email)  # ✅ 发给客户

    socketio.emit("new_order", data)

    if telegram_ok and email_ok and pos_ok:
        response = {"status": "ok"}
        if payment_method != "cash":
            response["paymentLink"] = TIKKIE_PAYMENT_LINK
        return jsonify(response), 200

    error_msg = "Beide mislukt"
    if not telegram_ok:
        error_msg = "Telegram-fout"
    elif not email_ok:
        error_msg = "E-mailfout"
    elif not pos_ok:
        error_msg = f"POS-fout: {pos_error}"
    return jsonify({"status": "fail", "error": error_msg}), 500
# === 启动 ===
if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=5000)


