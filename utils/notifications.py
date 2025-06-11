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

# === 基本配置 ===
BOT_TOKEN = "7509433067:AAGoLc1NVWqmgKGcrRVb3DwMh1o5_v5Fyio"
CHAT_ID = "-1001643565671"

SMTP_SERVER = "smtp.gmail.com"
SMTP_PORT = 587
SMTP_USERNAME = "qianchennl@gmail.com"
SMTP_PASSWORD = "wtuyxljsjwftyzfm"
SENDER_EMAIL = SMTP_USERNAME  # ✅ 正确引用

POS_API_URL = "https://nova-asia.onrender.com/api/orders"
TIKKIE_PAYMENT_LINK = "https://tikkie.me/pay/example"

ORDERS = []  # 内存记录今日订单（非数据库）

# === 初始化 Flask 应用 ===
app = Flask(__name__)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*")

# === 工具函数 ===
def send_telegram_message(text):
    try:
        url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
        res = requests.post(url, json={"chat_id": CHAT_ID, "text": text}, timeout=5)
        return res.status_code == 200
    except Exception as e:
        print("❌ Telegram 错误:", e)
        return False

def send_email_notification(subject, body, to_email):
    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = Header(subject, "utf-8")
    msg["From"] = formataddr(("NovaAsia", SMTP_USERNAME))
    msg["To"] = to_email

    try:
        with smtplib.SMTP(SMTP_SERVER, SMTP_PORT) as server:
            server.starttls()
            server.login(SMTP_USERNAME, SMTP_PASSWORD)
            server.sendmail(SMTP_USERNAME, [to_email], msg.as_string())
        return True
    except Exception as e:
        print(f"❌ Email 错误: {e}")
        return False

def generate_order_text(order):
    import json, ast

    # 如果传进来是 SQLAlchemy 对象
    if hasattr(order, '__table__'):
        # 手动转换为 dict
        order_dict = {
            "order_type": order.order_type,
            "customer_name": order.customer_name,
            "phone": order.phone,
            "email": order.email,
            "pickup_time": order.pickup_time,
            "delivery_time": order.delivery_time,
            "payment_method": order.payment_method,
            "postcode": order.postcode,
            "house_number": order.house_number,
            "street": order.street,
            "city": order.city,
            "created_at": order.created_at.strftime("%Y-%m-%d %H:%M"),
        }

        try:
            order_dict["items"] = json.loads(order.items or "{}")
        except Exception:
            order_dict["items"] = ast.literal_eval(order.items or "{}")
    else:
        # 否则就是字典，直接用
        order_dict = order

    # 以下逻辑使用 order_dict（不再用 order.get）
    items = order_dict.get("items", {})
    ...

def send_pos_order(data):
    try:
        res = requests.post(POS_API_URL, json=data)
        if res.status_code == 200:
            return True, None
        return False, f"Status {res.status_code}: {res.text}"
    except Exception as e:
        return False, str(e)

def record_order(data, pos_ok):
    ORDERS.append({
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "name": data.get("name"),
        "items": data.get("items"),
        "paymentMethod": data.get("paymentMethod"),
        "orderType": data.get("orderType"),
        "pos_ok": pos_ok
    })

def orders_today():
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
    return jsonify(orders_today())

@app.route("/submit_order", methods=["POST"])
def submit_order():
    data = request.get_json()
    if not data:
        return jsonify({"status": "fail", "error": "Leeg verzoek"}), 400

    message = data.get("message", "")
    remark = data.get("remark", "")
    email = data.get("email", "")
    payment_method = data.get("paymentMethod", "").lower()

    order_text = message + (f"\nOpmerking: {remark}" if remark else "")

    telegram_ok = send_telegram_message(order_text)
    email_ok = send_email_notification("Nova Asia - Nieuwe bestelling", order_text, SENDER_EMAIL)  # 商家
    pos_ok, pos_error = send_pos_order(data)
    record_order(data, pos_ok)

    if email:
        send_email_notification("Bestelbevestiging", order_text, email)  # 客户

    socketio.emit("new_order", data)

    if telegram_ok and email_ok and pos_ok:
        response = {"status": "ok"}
        if payment_method != "cash":
            response["paymentLink"] = TIKKIE_PAYMENT_LINK
        return jsonify(response), 200

    # 报错信息反馈
    if not telegram_ok:
        error_msg = "Telegram-fout"
    elif not email_ok:
        error_msg = "E-mailfout"
    elif not pos_ok:
        error_msg = f"POS-fout: {pos_error}"
    else:
        error_msg = "Onbekende fout"

    return jsonify({"status": "fail", "error": error_msg}), 500
def send_confirmation_email(subject, content, recipient):
    msg = MIMEText(content, "plain", "utf-8")
    msg["Subject"] = Header(subject, "utf-8")
    msg["From"] = formataddr(("NovaAsia", SMTP_USERNAME))
    msg["To"] = recipient

    try:
        with smtplib.SMTP(SMTP_SERVER, SMTP_PORT) as server:
            server.starttls()
            server.login(SMTP_USERNAME, SMTP_PASSWORD)
            server.sendmail(SMTP_USERNAME, [recipient], msg.as_string())
        return True
    except Exception as e:
        print(f"❌ Email confirmation failed: {e}")
        return False

# === 启动服务 ===
if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=5000)



