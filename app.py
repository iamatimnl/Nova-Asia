from flask import Flask, render_template, request, redirect, url_for, jsonify
from flask_sqlalchemy import SQLAlchemy
from flask_login import (
    LoginManager,
    UserMixin,
    login_user,
    logout_user,
    login_required,
)
from flask_socketio import SocketIO
from sqlalchemy import text
import eventlet
eventlet.monkey_patch()
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
import os
import json
import requests
import smtplib
from flask_migrate import Migrate
from urllib.parse import quote
from flask import send_file
from io import BytesIO
import pandas as pd
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Table, TableStyle
from reportlab.lib import colors
import random
import string
import traceback



# 初始化 Flask
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, template_folder="templates", static_folder="static")
app.config["SECRET_KEY"] = "replace-this"
app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get("DATABASE_URL")
print(repr(os.getenv("DATABASE_URL")))


db = SQLAlchemy(app)
migrate = Migrate(app, db)
with app.app_context():
    db.create_all()
    try:
        inspector = db.inspect(db.engine)
        cols = {c["name"] for c in inspector.get_columns("orders")}
        if "opmerking" not in cols:
            with db.engine.begin() as conn:
                conn.execute(text("ALTER TABLE orders ADD COLUMN opmerking TEXT"))
    except Exception as e:
        print(f"DB init error: {e}")

UTC = timezone.utc
NL_TZ = ZoneInfo("Europe/Amsterdam")

def to_nl(dt: datetime) -> datetime:
    """Convert naive UTC datetime to Europe/Amsterdam timezone."""
    if dt is None:
        return dt
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(NL_TZ)
def generate_excel_today():
    today = datetime.now(NL_TZ).date()
    start_local = datetime.combine(today, datetime.min.time(), tzinfo=NL_TZ)
    start = start_local.astimezone(UTC).replace(tzinfo=None)

    orders = Order.query.filter(Order.created_at >= start).order_by(Order.created_at.desc()).all()
    data = []
    for o in orders:
        try:
            items = json.loads(o.items or "{}")
        except Exception:
            items = {}

        summary = ", ".join(f"{k} x {v.get('qty')}" for k, v in items.items())
        data.append({
            "Datum": to_nl(o.created_at).strftime("%Y-%m-%d"),
            "Tijd": to_nl(o.created_at).strftime("%H:%M"),
            "Naam": o.customer_name,
            "Telefoon": o.phone,
            "Email": o.email,
            "Adres": f"{o.street} {o.house_number}, {o.postcode} {o.city}",
            "Betaalwijze": o.payment_method,
            "Totaal": f"€{o.totaal:.2f}",
            "Items": summary,
        })

    df = pd.DataFrame(data)
    output = BytesIO()
    df.to_excel(output, index=False, engine='xlsxwriter')
    output.seek(0)
    return output


def generate_order_number(length=8):
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=length))



def generate_pdf_today():
    today = datetime.now(NL_TZ).date()
    start_local = datetime.combine(today, datetime.min.time(), tzinfo=NL_TZ)
    start = start_local.astimezone(UTC).replace(tzinfo=None)

    orders = Order.query.filter(Order.created_at >= start).order_by(Order.created_at.desc()).all()

    buffer = BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4)
    elements = []

    data = [["Datum", "Tijd", "Naam", "Totaal", "Items"]]
    for o in orders:
        try:
            items = json.loads(o.items or "{}")
        except Exception:
            items = {}

        summary = ", ".join(f"{k} x {v.get('qty')}" for k, v in items.items())
        data.append([
            to_nl(o.created_at).strftime("%Y-%m-%d"),
            to_nl(o.created_at).strftime("%H:%M"),
            o.customer_name,
            f"€{o.totaal:.2f}",
            summary
        ])

    table = Table(data, repeatRows=1)
    table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.lightblue),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('BOTTOMPADDING', (0, 0), (-1, 0), 12),
        ('BACKGROUND', (0, 1), (-1, -1), colors.beige),
        ('GRID', (0, 0), (-1, -1), 1, colors.black),
    ]))
    elements.append(table)
    doc.build(elements)
    buffer.seek(0)
    return buffer

@app.route("/admin/orders/download/pdf")
@login_required
def download_pdf():
    output = generate_pdf_today()
    return send_file(
        output,
        mimetype='application/pdf',
        as_attachment=True,
        download_name='bestellingen_vandaag.pdf'
    )
@app.route("/admin/orders/download/excel")
@login_required
def download_excel():
    output = generate_excel_today()
    return send_file(
        output,
        mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        as_attachment=True,
        download_name='bestellingen_vandaag.xlsx'
    )





def build_maps_link(street: str, house_number: str, postcode: str, city: str) -> str | None:
    """Create a Google Maps search URL for the given address."""
    if not all([street, house_number, postcode, city]):
        return None
    address = f"{street} {house_number}, {postcode} {city}"
    return f"https://www.google.com/maps?q={quote(address)}"


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
    order_number = db.Column(db.String(20))
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
    opmerking = db.Column(db.Text)
    items = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    totaal = db.Column(db.Float)


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
        order_number = generate_order_number()

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
            opmerking=data.get("opmerking") or data.get("remark"),
            items=json.dumps(data.get("items", {})),
            order_number=order_number
        )   
        db.session.add(order)
        db.session.commit()

        # Notify POS clients
        try:
            items = json.loads(order.items or "{}")
            total = sum(float(i.get("price", 0)) * int(i.get("qty", 0)) for i in items.values())

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
                "maps_link": build_maps_link(order.street, order.house_number, order.postcode, order.city),
                "opmerking": order.opmerking,
                "created_date": to_nl(order.created_at).strftime("%Y-%m-%d"),
                "created_at": to_nl(order.created_at).strftime("%H:%M"),
                "items": items,
                "total": total,
                "totaal": total,
                "order_number": order.order_number
                
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

    # GET 请求：加载今日订单展示到 POS 界面
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
        o.maps_link = build_maps_link(o.street, o.house_number, o.postcode, o.city)

    return render_template("pos.html", orders=orders)


# 接收前端订单提交
@app.route('/api/orders', methods=["POST"])
def api_orders():
    try:
        data = request.get_json() or {}
        order_number = generate_order_number()

        # 1. 构造订单对象（初始字段）
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
            opmerking=data.get("opmerking") or data.get("remark"),
            items=json.dumps(data.get("items", {})),
            order_number=order_number
        )

        # 2. 计算 subtotal / totaal
        items = json.loads(order.items or "{}")
        subtotal = sum(
            float(i.get("price", 0)) * int(i.get("qty", 0))
            for i in items.values()
        )
        order.totaal = float(data.get("totaal") or subtotal)

        # 3. 保存订单到数据库
        db.session.add(order)
        db.session.commit()

        # 4. 推送给 POS via SocketIO
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
                "maps_link": build_maps_link(order.street, order.house_number, order.postcode, order.city),
                "opmerking": order.opmerking,
                "created_date": to_nl(order.created_at).strftime("%Y-%m-%d"),
                "created_at": to_nl(order.created_at).strftime("%H:%M"),
                "items": items,
                "total": subtotal,
                "totaal": order.totaal,
                "order_number": order.order_number,
            }
            socketio.emit("new_order", order_payload, broadcast=True)
        except Exception as e:
            print(f"❌ Socket emit failed: {e}")

        # 4.5 向 App B 推送订单
        try:
            notifier_url = os.getenv("ORDER_FORWARD_URL")
            if notifier_url:
                forward_payload = {
                    "order_number": order.order_number,
                    "customer_name": order.customer_name,
                    "email": order.email,
                    "phone": order.phone,
                    "items": items,
                    "totaal": order.totaal,
                    "pickup_time": order.pickup_time,
                    "delivery_time": order.delivery_time,
                    "order_type": order.order_type,
                    "remark": order.opmerking,
                }
                forward_headers = {
                    "Authorization": f"Bearer {os.getenv('ORDER_FORWARD_TOKEN', '')}"
                }
                response = requests.post(
                    notifier_url,
                    json=forward_payload,
                    headers=forward_headers,
                    timeout=5
                )
                print(f"✅ Order forwarded to notifier: {response.status_code}")
            else:
                print("⚠️ No notifier URL configured.")
        except Exception as e:
            print(f"❌ Failed to forward order: {e}")

        # 5. Telegram / Email 通知（保留原逻辑）
        if data.get("message"):
            order_number_line = f"🧾 Bestelnummer: {order.order_number}\n"
            full_message = order_number_line + data["message"]

            send_telegram(full_message)
            if order.email:
                send_email(order.email, "Orderbevestiging", full_message)

        print("✅ 接收到订单:", data)

        # 6. 返回响应
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
@app.route('/api/send', methods=['POST'])
def send_notification():
    try:
        # 获取 Telegram 和邮件环境变量
        TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
        TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")
        SMTP_USERNAME = os.getenv("SMTP_USERNAME")
        SMTP_PASSWORD = os.getenv("SMTP_PASSWORD")
        SMTP_SERVER = os.getenv("SMTP_SERVER")
        SMTP_PORT = int(os.getenv("SMTP_PORT", 587))
        FROM_EMAIL = os.getenv("FROM_EMAIL")

        # 读取 JSON 内容
        data = request.get_json(force=True)  # 加 force=True 可以绕过 content-type 检查
        message = data.get('message', '📩 Nieuwe melding')

        if not message:
            return jsonify({'error': 'Message is required'}), 400

        # 发送 Telegram 通知
        if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID:
            telegram_url = f'https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage'
            payload = {
                'chat_id': TELEGRAM_CHAT_ID,
                'text': message
            }
            res = requests.post(telegram_url, json=payload)
            res.raise_for_status()

        # 发送邮件通知
        if SMTP_SERVER and SMTP_USERNAME and SMTP_PASSWORD and FROM_EMAIL:
            msg = MIMEText(message)
            msg['Subject'] = 'Nieuwe bestelling'
            msg['From'] = FROM_EMAIL
            msg['To'] = FROM_EMAIL

            with smtplib.SMTP(SMTP_SERVER, SMTP_PORT) as server:
                server.starttls()
                server.login(SMTP_USERNAME, SMTP_PASSWORD)
                server.send_message(msg)

        return jsonify({'status': '通知已发送'}), 200

    except Exception as e:
        print("❌ Fout in /api/send:", str(e))
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500




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

        o.created_at_local = to_nl(o.created_at)
        # 不再重新计算 o.totaal，而是使用数据库字段的原值
        order_data.append({
            "order": o,
            "items": items,
            "total": o.totaal or 0,  # 显示数据库值，如果为空则为0
            "totaal": o.totaal or 0,
        })

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

        # ✅ 正确使用数据库中的 totaal
        totaal = o.totaal or 0

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
            f"📦 Nieuwe bestelling bij *Nova Asia*:\n\n"
            f"Bestelnummer: {o.order_number}\n"  # ✅ 插入编号
            f"{summary}\n{details}\nTotaal: €{totaal:.2f}"

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
            "maps_link": build_maps_link(o.street, o.house_number, o.postcode, o.city),
            "opmerking": o.opmerking,
            "created_date": to_nl(o.created_at).strftime("%Y-%m-%d"),
            "created_at": to_nl(o.created_at).strftime("%H:%M"),
            "items": o.items_dict,
            "total": totaal,   # ✅ 关键是这里：使用数据库中的 totaal
            "totaal": totaal,
            "order_number": o.order_number  # ✅ 加上这行
        })

    if request.args.get("json"):
        return jsonify(order_dicts)

    return render_template("pos_orders.html", orders=orders)
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





























































































































































































































































