from flask import Flask, render_template, request, redirect, url_for, jsonify
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import inspect, text
from flask_login import (
    LoginManager,
    UserMixin,
    login_user,
    logout_user,
    login_required,
)
from flask_socketio import SocketIO
import eventlet
eventlet.monkey_patch()
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
import os
import json
import requests
import smtplib

# 初始化 Flask
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, template_folder="templates", static_folder="static")
app.config["SECRET_KEY"] = "replace-this"
app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get("DATABASE_URL")
print(repr(os.getenv("DATABASE_URL")))


db = SQLAlchemy(app)
with app.app_context():
    db.create_all()

UTC = timezone.utc
NL_TZ = ZoneInfo("Europe/Amsterdam")

def to_nl(dt: datetime) -> datetime:
    """Convert naive UTC datetime to Europe/Amsterdam timezone."""
    if dt is None:
        return dt
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(NL_TZ)


# Socket.IO for real-time updates
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")


def send_telegram(message: str):
    """Send a Telegram message if tokens are configured."""
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    chat_id = os.getenv("TELEGRAM_CHAT_ID")
    if token and chat_id and message:
        try:
            resp = requests.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={"chat_id": chat_id, "text": message},
                timeout=5,
            )
            resp.raise_for_status()
            print("Telegram message sent")
        except Exception as e:
            print(f"Telegram send error: {e}")
    else:
        print("Telegram configuration missing or empty message")


def send_email(to_email: str, subject: str, body: str):
    """Send a confirmation email if SMTP settings are provided."""
    server = os.getenv("SMTP_SERVER")
    username = os.getenv("SMTP_USERNAME")
    password = os.getenv("SMTP_PASSWORD")
    from_email = os.getenv("FROM_EMAIL", username)
    port = int(os.getenv("SMTP_PORT", "587"))
    if not (server and username and password and to_email):
        print("Email configuration missing; skipping send")
        return
    try:
        with smtplib.SMTP(server, port) as smtp:
            smtp.starttls()
            smtp.login(username, password)
            msg = f"Subject: {subject}\n\n{body}"
            smtp.sendmail(from_email, to_email, msg)
        print("Email sent")
    except Exception as e:
        print(f"Email send error: {e}")

# 设置登录管理
login_manager = LoginManager(app)
login_manager.login_view = "login"

# 数据模型
class Order(db.Model):
    __tablename__ = 'orders'  # ✅ 避免使用 SQL 保留字
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

@login_manager.user_loader
def load_user(user_id: str):
    return User("admin") if user_id == "admin" else None

# 首页
@app.route('/')
def home():
    return render_template('index.html')

# POS
@app.route('/pos', methods=["GET", "POST"])
@login_required
def pos():
    if request.method == "POST":
        data = request.get_json() or {}
        order = Order(
            order_type=data.get("order_type") or data.get("orderType"),
            customer_name=data.get("customer_name") or data.get("name"),
            phone=data.get("phone"),
            email=data.get("email") or data.get("customerEmail"),
            pickup_time=data.get("pickup_time") or data.get("pickupTime"),
            delivery_time=data.get("delivery_time") or data.get("deliveryTime"),
            payment_method=data.get("payment_method") or data.get("paymentMethod"),
            postcode=data.get("postcode"),
            house_number=data.get("house_number"),
            street=data.get("street"),
            city=data.get("city"),
            items=json.dumps(data.get("items", {})),
        )
        db.session.add(order)
        db.session.commit()

        # Notify POS clients
        try:
            payload = {
                "id": order.id,
                "order_type": order.order_type,
                "customer_name": order.customer_name,
                "phone": order.phone,
                "email": order.email,
                "payment_method": order.payment_method,
                "pickup_time": order.pickup_time,
                "delivery_time": order.delivery_time,
                "pickupTime": order.pickup_time,
                "deliveryTime": order.delivery_time,
                "postcode": order.postcode,
                "house_number": order.house_number,
                "street": order.street,
                "city": order.city,
                "created_date": to_nl(order.created_at).strftime("%Y-%m-%d"),
                "created_at": to_nl(order.created_at).strftime("%H:%M"),
                "items": json.loads(order.items or "{}"),
            }
            socketio.emit("new_order", payload, broadcast=True)
        except Exception as e:
            print(f"Socket emit failed: {e}")

        resp = {"success": True}
        if str(order.payment_method).lower() == "online":
            url = os.getenv("TIKKIE_URL")
            if url:
                resp["paymentLink"] = url

        return jsonify(resp)
    today = datetime.now(NL_TZ).date()
    start_local = datetime.combine(today, datetime.min.time(), tzinfo=NL_TZ)
    start = start_local.astimezone(UTC).replace(tzinfo=None)
    orders = Order.query.filter(Order.created_at >= start).order_by(Order.created_at.desc()).all()
    for o in orders:
        try:
            o.items_dict = json.loads(o.items or "{}")
        except Exception:
            try:
                import ast
                o.items_dict = ast.literal_eval(o.items)
            except Exception as e:
                print(f"❌ JSON解析失败: {e}")
                o.items_dict = {}

        o.total = sum(float(i.get("price", 0)) * int(i.get("qty", 0)) for i in o.items_dict.values())
        o.created_at_local = to_nl(o.created_at)
    return render_template("pos.html", orders=orders)


# 接收前端订单提交
@app.route('/api/orders', methods=["POST"])
def api_orders():
    try:
        data = request.get_json() or {}

        order = Order(
            order_type=data.get("orderType") or data.get("order_type"),
            customer_name=data.get("name") or data.get("customer_name"),
            phone=data.get("phone"),
            email=data.get("customerEmail") or data.get("email"),
            pickup_time=data.get("pickup_time") or data.get("pickupTime"),
            delivery_time=data.get("delivery_time") or data.get("deliveryTime"),
            payment_method=data.get("paymentMethod") or data.get("payment_method"),
            postcode=data.get("postcode"),
            house_number=data.get("house_number"),
            street=data.get("street"),
            city=data.get("city"),
            items=json.dumps(data.get("items", {})),
        )

        db.session.add(order)
        db.session.commit()

        # Broadcast new order to connected POS clients
        try:
            order_payload = {
                "id": order.id,
                "order_type": order.order_type,
                "customer_name": order.customer_name,
                "phone": order.phone,
                "email": order.email,
                "payment_method": order.payment_method,
                "pickup_time": order.pickup_time,
                "delivery_time": order.delivery_time,
                "pickupTime": order.pickup_time,
                "deliveryTime": order.delivery_time,
                "postcode": order.postcode,
                "house_number": order.house_number,
                "street": order.street,
                "city": order.city,
                "created_date": to_nl(order.created_at).strftime("%Y-%m-%d"),
                "created_at": to_nl(order.created_at).strftime("%H:%M"),
                "items": json.loads(order.items or "{}"),
            }
            socketio.emit("new_order", order_payload, broadcast=True)
        except Exception as e:
            print(f"Socket emit failed: {e}")

        # Optional notifications
        if data.get("message"):
            send_telegram(data.get("message"))
            if order.email:
                send_email(order.email, "Order Confirmation", data.get("message"))

        print("✅ 接收到订单:", data)  # 可选日志

        # Include payment link when using online method
        resp = {"status": "ok"}
        if str(order.payment_method).lower() == "online":
            pay_url = os.getenv("TIKKIE_URL")
            if pay_url:
                resp["paymentLink"] = pay_url

        return jsonify(resp), 200

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"status": "fail", "error": str(e)}), 500
        
@app.route('/submit_order', methods=["POST"])
def submit_order():
    # 兼容旧接口，转发数据到现有逻辑
    return api_orders()


# Telegram 通知接口
@app.route('/api/send', methods=["POST"])
def api_send():
    data = request.get_json() or {}
    message = data.get("message", "")
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    chat_id = os.getenv("TELEGRAM_CHAT_ID")
    if token and chat_id and message:
        try:
            resp = requests.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={"chat_id": chat_id, "text": message},
                timeout=5,
            )
            resp.raise_for_status()
        except Exception as e:
            return jsonify({"status": "error", "error": str(e)}), 500
    return jsonify({"status": "ok"})

@app.route('/create_db')
def create_db():
    try:
        inspector = inspect(db.engine)
        cols = set()
        if inspector.has_table("orders"):
            cols = {c["name"] for c in inspector.get_columns("orders")}

        with db.engine.begin() as conn:
            if "remark" not in cols:
                conn.execute(text("ALTER TABLE orders ADD COLUMN remark TEXT"))
            if "maps_link" not in cols:
                conn.execute(text("ALTER TABLE orders ADD COLUMN maps_link VARCHAR(255)"))

        db.create_all()
        return "✅ Database tables created!"
    except Exception as e:
        return f"❌ Error: {e}"




# 管理页面
@app.route('/admin')
@login_required
def admin():
    return render_template('admin.html')

@app.route('/admin/orders')
@login_required
def admin_orders():
    orders = Order.query.order_by(Order.created_at.desc()).all()
    order_data = []
    for o in orders:
        try:
            items = json.loads(o.items or "{}")
        except Exception:
            try:
                import ast
                items = ast.literal_eval(o.items)
            except Exception:
                items = {}
        total = sum(float(i.get("price", 0)) * int(i.get("qty", 0)) for i in items.values())
        o.created_at_local = to_nl(o.created_at)
        order_data.append({"order": o, "total": total})
    return render_template("admin_orders.html", order_data=order_data)

@app.route('/pos/orders_today')
@login_required
def pos_orders_today():
    today = datetime.now(NL_TZ).date()
    start_local = datetime.combine(today, datetime.min.time(), tzinfo=NL_TZ)
    start = start_local.astimezone(UTC).replace(tzinfo=None)
    orders = Order.query.filter(Order.created_at >= start).order_by(Order.created_at.desc()).all()
    order_dicts = []
    for o in orders:
        try:
            o.items_dict = json.loads(o.items or "{}")
        except Exception:
            try:
                import ast
                o.items_dict = ast.literal_eval(o.items)
            except Exception as e:
                print(f"❌ JSON解析失败: {e}")
                o.items_dict = {}

        total = sum(float(i.get("price", 0)) * int(i.get("qty", 0)) for i in o.items_dict.values())
        o.total = total
        o.created_at_local = to_nl(o.created_at)
        summary = "\n".join(f"{name} x {item['qty']}" for name, item in o.items_dict.items())

        is_pickup = o.order_type in ["afhalen", "pickup"]
        if is_pickup:
            details = f"[Afhalen]\nNaam: {o.customer_name}\nTelefoon: {o.phone}"
            if o.email:
                details += f"\nEmail: {o.email}"
            details += f"\nAfhaaltijd: {o.pickup_time}\nBetaalwijze: {o.payment_method}"
        else:
            details = f"[Bezorgen]\nNaam: {o.customer_name}\nTelefoon: {o.phone}"
            if o.email:
                details += f"\nEmail: {o.email}"
            details += (
                f"\nAdres: {o.street} {o.house_number}"\
                f"\nPostcode: {o.postcode}\nBezorgtijd: {o.delivery_time}"\
                f"\nBetaalwijze: {o.payment_method}"
            )

        o.formatted = (
            f"📦 Nieuwe bestelling bij *Nova Asia*:\n\n{summary}\n{details}\nTotaal: €{total:.2f}"
        )

        order_dicts.append({
            "id": o.id,
            "order_type": o.order_type,
            "customer_name": o.customer_name,
            "phone": o.phone,
            "email": o.email,
            "payment_method": o.payment_method,
            "pickup_time": o.pickup_time,
            "delivery_time": o.delivery_time,
            "pickupTime": o.pickup_time,
            "deliveryTime": o.delivery_time,
            "postcode": o.postcode,
            "house_number": o.house_number,
            "street": o.street,
            "city": o.city,
            "created_date": to_nl(o.created_at).strftime("%Y-%m-%d"),
            "created_at": to_nl(o.created_at).strftime("%H:%M"),
            "items": o.items_dict,
            "total": total,
        })

    if request.args.get("json"):
        return jsonify(order_dicts)

    return render_template("pos_orders.html", orders=orders)
# 登录
@app.route('/login', methods=["GET", "POST"])
def login():
    if request.method == "POST":
        username = request.form.get("username")
        password = request.form.get("password")
        if username == "admin" and password == "novaasia3693":
            login_user(User("admin"))
            return redirect(url_for("pos"))
        return render_template("login.html", error=True)
    return render_template("login.html")

# 登出
@app.route("/logout")
@login_required
def logout():
    logout_user()
    return redirect(url_for("login"))

# 启动
if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=5000)







