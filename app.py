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

# 初始化 Flask
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(
    __name__,
    template_folder="templates",
    static_folder="static",
)
app.config["SECRET_KEY"] = "replace-this"

DATABASE = os.path.join(BASE_DIR, "db.sqlite3")
app.config["SQLALCHEMY_DATABASE_URI"] = f"sqlite:///{DATABASE}"

db = SQLAlchemy(app)
with app.app_context():
    db.create_all()

# 设置登录管理
login_manager = LoginManager(app)
login_manager.login_view = "login"

# 数据模型
class Order(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    order_type = db.Column(db.String(20))
    customer_name = db.Column(db.String(100))
    phone = db.Column(db.String(20))
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
    if user_id == "admin":
        return User("admin")
    return None

# 首页路由
@app.route('/')
def home():
    return render_template('index.html')

# POS 路由
@app.route('/pos', methods=["GET", "POST"])
@login_required
def pos():
    if request.method == "POST":
        data = request.get_json()
        order = Order(
            order_type=data.get("order_type"),
            customer_name=data.get("customer_name"),
            phone=data.get("phone"),
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

# 管理员首页（占位）
@app.route('/admin')
@login_required
def admin():
    return render_template('admin.html')

# 管理员订单查看页
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
        total = 0
        for item in items.values():
            price = float(item.get("price", 0))
            qty = int(item.get("qty", 0))
            total += price * qty
        order_data.append({"order": o, "total": total})
    return render_template("admin_orders.html", order_data=order_data)

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

# ✅ Vercel 的入口点
def handler(environ, start_response):
    return app.wsgi_app(environ, start_response)
