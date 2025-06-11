import eventlet

# Patch for SocketIO
eventlet.monkey_patch()

from flask import Flask, render_template, request, redirect, url_for, jsonify
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, logout_user, login_required
from flask_socketio import SocketIO
from flask_cors import CORS
from datetime import datetime
import os
import json
import requests
import smtplib
from utils.notifications import send_telegram_message, send_email_notification, send_confirmation_email, generate_order_text

app = Flask(__name__, template_folder="templates", static_folder="static")
CORS(app, resources={r"/*": {"origins": "*"}})
app.config["SECRET_KEY"] = "replace-this"
app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get("DATABASE_URL")
print(repr(os.getenv("DATABASE_URL")))

db = SQLAlchemy(app)
with app.app_context():
    db.create_all()

socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")

class Order(db.Model):
    __tablename__ = 'orders'
    id = db.Column(db.Integer, primary_key=True)
    order_type = db.Column(db.String(20))
    customer_name = db.Column(db.String(100))
    phone = db.Column(db.String(20))
    email = db.Column(db.String(120))
    pickup_time = db.Column(db.String(20))
    delivery_time = db.Column(db.String(20))
    payment_method = db.Column(db.String(20))
    postcode = db.Column(db.String(10))
    house_number = db.Column(db.String(10))
    street = db.Column(db.String(100))
    city = db.Column(db.String(100))
    items = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

class User(UserMixin):
    def __init__(self, user_id: str):
        self.id = user_id

login_manager = LoginManager(app)
login_manager.login_view = "login"

@login_manager.user_loader
def load_user(user_id: str):
    return User("admin") if user_id == "admin" else None

@app.route("/submit_order", methods=["POST"])
def submit_order():
    return api_orders()

@app.route("/api/orders", methods=["POST"])
def api_orders():
    try:
        data = request.get_json() or {}
        order = Order(
            order_type=data.get("orderType") or data.get("order_type"),
            customer_name=data.get("name") or data.get("customer_name"),
            phone=data.get("phone"),
            email=data.get("customerEmail") or data.get("email"),
            pickup_time=data.get("pickup_time"),
            delivery_time=data.get("delivery_time"),
            payment_method=data.get("paymentMethod") or data.get("payment_method"),
            postcode=data.get("postcode"),
            house_number=data.get("house_number"),
            street=data.get("street"),
            city=data.get("city"),
            items=json.dumps(data.get("items", {})),
        )
        db.session.add(order)
        db.session.commit()

        order_text = generate_order_text(order)
        try:
            send_telegram_message(order_text)
        except Exception as e:
            print(f"❌ Telegram 错误: {e}")
        try:
            send_email_notification("Nieuwe bestelling via Nova Asia", order_text, "qianchennl@gmail.com")
        except Exception as e:
            print(f"❌ 店主邮件发送失败: {e}")
        if order.email:
            try:
                send_confirmation_email("Uw bestelling bij Nova Asia", order_text, order.email)
            except Exception as e:
                print(f"❌ 顾客确认邮件发送失败: {e}")

        try:
            socketio.emit("new_order", {
                "id": order.id,
                "order_type": order.order_type,
                "customer_name": order.customer_name,
                "phone": order.phone,
                "email": order.email,
                "payment_method": order.payment_method,
                "pickup_time": order.pickup_time,
                "delivery_time": order.delivery_time,
                "postcode": order.postcode,
                "house_number": order.house_number,
                "street": order.street,
                "city": order.city,
                "created_at": order.created_at.strftime("%H:%M"),
                "items": json.loads(order.items or "{}")
            }, broadcast=True)
        except Exception as e:
            print(f"Socket emit failed: {e}")

        print("✅ 接收到订单:", data)

        resp = {"status": "ok"}
        if str(order.payment_method).lower() == "online":
            url = os.getenv("TIKKIE_URL")
            if url:
                resp["payment_url"] = url
        return jsonify(resp), 200

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"status": "fail", "error": str(e)}), 500

@app.route("/test_telegram", methods=["POST"])
def test_telegram():
    data = request.get_json()
    message = data.get("message", "测试消息")
    try:
        success = send_telegram_message(message)
        return jsonify({"status": "ok" if success else "fail"})
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500

@app.route("/test_dns")
def test_dns():
    import socket
    try:
        ip = socket.gethostbyname('api.telegram.org')
        return f"Resolved Telegram IP: {ip}"
    except Exception as e:
        return f"DNS error: {e}"

if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=5000)


