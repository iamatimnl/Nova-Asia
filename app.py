from flask import Flask, render_template, request, redirect, url_for, jsonify
from flask_sqlalchemy import SQLAlchemy
from flask_login import (
    LoginManager,
    UserMixin,
    login_user,
    logout_user,
    login_required,
)
from datetime import datetime
import os
import json
import requests

# 初始化 Flask
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, template_folder="templates", static_folder="static")
app.config["SECRET_KEY"] = "replace-this"
app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get("DATABASE_URL")
print("📡 DATABASE_URL from env =", app.config["SQLALCHEMY_DATABASE_URI"])



db = SQLAlchemy(app)
with app.app_context():
    db.create_all()

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
        data = request.get_json()
        order = Order(
            order_type=data.get("order_type"),
            customer_name=data.get("customer_name"),
            phone=data.get("phone"),
            email=data.get("email"),
            pickup_time=data.get("pickup_time"),
            delivery_time=data.get("delivery_time"),
            payment_method=data.get("payment_method"),
            postcode=data.get("postcode"),
            house_number=data.get("house_number"),
            street=data.get("street"),
            city=data.get("city"),
            items=json.dumps(data.get("items", {})),
        )
        db.session.add(order)
        db.session.commit()
        return jsonify({"success": True})
    return render_template("pos.html")


# 接收前端订单提交
@app.route('/api/orders', methods=["POST"])
def api_orders():
    try:
        data = request.get_json()

        order = Order(
    order_type=data.get("orderType"),              # ✅ 正确字段
    customer_name=data.get("name"),                # ✅ 正确字段
    phone=data.get("phone"),                       # ✅ 没有的话可以留空
    email=data.get("customerEmail"),               # ✅ 正确字段
    pickup_time=data.get("pickup_time"),           # ❓ 如果没传，也可以不填
    delivery_time=data.get("delivery_time"),       # ❓ 同上
    payment_method=data.get("paymentMethod"),      # ✅ 正确字段
    postcode=data.get("postcode"),                 # ❓ 如果没用可以删掉
    house_number=data.get("house_number"),
    street=data.get("street"),
    city=data.get("city"),
    items=json.dumps(data.get("items", {})),       # ✅ 正常工作
)

        db.session.add(order)
        db.session.commit()

        print("✅ 接收到订单:", data)  # 可选日志
        return jsonify({"status": "ok"}), 200

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"status": "fail", "error": str(e)}), 500


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


@app.route('/init_db')
def init_db():
    with app.app_context():
        db.create_all()
    return "✅ Database tables created!"


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
            items = {}
        total = sum(float(i.get("price", 0)) * int(i.get("qty", 0)) for i in items.values())
        order_data.append({"order": o, "total": total})
    return render_template("admin_orders.html", order_data=order_data)

@app.route('/pos/orders_today')
@login_required
def pos_orders_today():
    today = datetime.utcnow().date()
    start = datetime.combine(today, datetime.min.time())
    orders = Order.query.filter(Order.created_at >= start).order_by(Order.created_at.desc()).all()
    for o in orders:
        try:
            o.items_dict = json.loads(o.items or "{}")
        except Exception as e:
            print(f"❌ JSON解析失败: {e}")
            o.items_dict = {}
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
    app.run(host="0.0.0.0", port=5000)

