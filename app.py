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
import random
import string
from flask_migrate import Migrate
from urllib.parse import quote
import uuid
from flask import send_file
from werkzeug.utils import secure_filename
from io import BytesIO
import pandas as pd
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Table, TableStyle
from reportlab.lib import colors

import traceback



# 初始化 Flask
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, template_folder="templates", static_folder="static")
app.config["SECRET_KEY"] = "replace-this"
app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get("DATABASE_URL")
app.config["UPLOAD_FOLDER"] = os.path.join(app.static_folder, "uploads")
os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)
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
        cols = {c["name"] for c in inspector.get_columns("reviews")}
        if "rating" not in cols:
            with db.engine.begin() as conn:
                conn.execute(text("ALTER TABLE reviews ADD COLUMN rating INTEGER"))
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




# 设置登录管理
login_manager = LoginManager(app)
login_manager.login_view = "login"

# 数据模型
class Order(db.Model):
    __tablename__ = 'orders'
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
    fooi = db.Column(db.Float, default=0.0)
    discount_code = db.Column(db.String(50))  # ✅ 新增
    discount_amount = db.Column(db.Float, default=0.0)  # ✅ 新增



class Setting(db.Model):
    __tablename__ = 'settings'
    key = db.Column(db.String(50), primary_key=True)
    value = db.Column(db.String(200))

class Review(db.Model):
    __tablename__ = 'reviews'
    id = db.Column(db.Integer, primary_key=True)
    order_number = db.Column(db.String(20), db.ForeignKey('orders.order_number'), unique=True, nullable=False)
    customer_name = db.Column(db.String(100), nullable=False)
    content = db.Column(db.Text, nullable=False)
    rating = db.Column(db.Integer, default=0)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

class DiscountCode(db.Model):
    __tablename__ = 'discount_codes'
    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(50), unique=True, nullable=False)
    discount_percentage = db.Column(db.Float, default=3.0)
    is_used = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    customer_email = db.Column(db.String(120))
    discount_amount = db.Column(db.Float, default=0.0)  # ✅ 必须加这个


class MenuSection(db.Model):
    __tablename__ = 'menu_sections'
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), unique=True, nullable=False)


class MenuItem(db.Model):
    __tablename__ = 'menu_items'
    id = db.Column(db.Integer, primary_key=True)
    section_id = db.Column(db.Integer, db.ForeignKey('menu_sections.id'))
    name = db.Column(db.String(100), nullable=False)
    price = db.Column(db.Float, default=0.0)
    image = db.Column(db.String(200))
    section = db.relationship('MenuSection', backref=db.backref('items', lazy=True))


with app.app_context():
    db.create_all()
    defaults = {
        "is_open": "true",
        "open_time": "11:00",
        "close_time": "21:00",
        "pickup_enabled": "true",
        "delivery_enabled": "true",
        "pickup_start": "11:00",
        "pickup_end": "21:00",
        "delivery_start": "11:00",
        "delivery_end": "21:00",
    }
    for k, v in defaults.items():
        if not Setting.query.filter_by(key=k).first():
            db.session.add(Setting(key=k, value=v))
    db.session.commit()


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

# Review submission page
@app.route('/review')
def review_page():
    order_number = request.args.get('order') or ''
    return render_template('review.html', order_number=order_number)

# POS
@app.route('/pos', methods=["GET", "POST"])
@login_required
def pos():
    if request.method == "POST":
        data = request.get_json() or {}
        order_number = data.get("order_number") or data.get("orderNumber")

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


        resp = {"success": True}
        if str(order.payment_method).lower() == "online":
            url = os.getenv("TIKKIE_URL")
            if url:
                resp["paymentLink"] = url

        return jsonify(resp)

    # 之前会在此向 POS 页面推送今日订单信息，现已不再需要
    return render_template("pos.html")


# 接收前端订单提交
@app.route('/api/orders', methods=["POST"])
def api_orders():
    try:
        data = request.get_json() or {}
        order_number = data.get("order_number") or data.get("orderNumber")

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
            order_number=order_number,
            fooi=float(data.get("tip") or data.get("fooi") or 0),
            discount_code=data.get("discount_code") or data.get("discountCode"),  # ✅ 加入折扣码
            discount_amount=data.get("discount_amount")  # ✅ 加入折扣金额
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

        # 4. 如有折扣码，记录到 discount_codes 表
        discount_code = data.get("discount_code") or data.get("discountCode")
        customer_email = (
            data.get("customer_email")
            or data.get("customerEmail")
            or order.email
        )
        discount_amount = data.get("discount_amount") or 0  # ✅ 加入 discount_amount 获取

        if discount_code and customer_email:
            disc = DiscountCode(
                code=discount_code,
                customer_email=customer_email,
                discount_percentage=3.0,
                discount_amount=discount_amount,  # ✅ 必须加入
                is_used=False,
            )
            db.session.add(disc)
            db.session.commit()
            print(f"✅ 折扣码保存成功: {discount_code} for {customer_email} met korting {discount_amount}")

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




@app.route("/api/discounts/validate", methods=["POST"])
def validate_discount():
    try:
        data = request.get_json()
        code = data.get("code")
        order_total = float(data.get("order_total") or 0)

        disc = DiscountCode.query.filter_by(code=code, is_used=False).first()
        if not disc:
            return jsonify({"valid": False, "error": "Invalid or used code"}), 400

        if order_total < 20:
            return jsonify({"valid": False, "error": "Minimum order total not met"}), 400

        # ✅ 改成使用数据库折扣金额
        discount_amount = disc.discount_amount

        new_total = max(0, order_total - discount_amount)

        disc.is_used = True
        db.session.commit()

        return jsonify({
            "valid": True,
            "discount_amount": discount_amount,
            "new_total": new_total
        }), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500


# 获取设置
@app.route('/api/settings/<key>')
def get_setting(key):
    s = Setting.query.filter_by(key=key).first()
    return jsonify({key: s.value if s else None})

@app.route('/api/settings')
def get_all_settings():
    settings = {s.key: s.value for s in Setting.query.all()}
    return jsonify(settings)

# ----- Review API -----
@app.route('/api/reviews', methods=['GET', 'POST'])
def reviews_api():
    if request.method == 'POST':
        data = request.get_json() or {}
        order_number = str(data.get('order_number') or '').strip()
        name = str(data.get('customer_name') or '').strip()
        content = str(data.get('content') or '').strip()
        rating = int(data.get('rating') or 0)

        if not order_number or not name or not content or rating not in range(1, 6):
            return jsonify({'status': 'fail', 'error': 'missing_fields'}), 400

        if not Order.query.filter_by(order_number=order_number).first():
            return jsonify({'status': 'fail', 'error': 'invalid_order'}), 400

        if Review.query.filter_by(order_number=order_number).first():
            return jsonify({'status': 'fail', 'error': 'already_reviewed'}), 400

        review = Review(order_number=order_number, customer_name=name, content=content, rating=rating)
        db.session.add(review)
        db.session.commit()
        socketio.emit('new_review', {
            'order_number': order_number,
            'customer_name': name,
            'content': content,
            'rating': rating,
            'created_at': review.created_at.isoformat()
        })
        return jsonify({'status': 'ok'}), 201

    reviews = Review.query.order_by(Review.created_at.desc()).all()
    return jsonify([
        {
            'customer_name': r.customer_name,
            'content': r.content,
            'rating': r.rating,
            'created_at': r.created_at.isoformat()
        }
        for r in reviews
    ])


# Mijn Nova Asia 管理后台
@app.route('/dashboard')
@login_required
def dashboard():
    def get_value(key, default):
        s = Setting.query.filter_by(key=key).first()
        return s.value if s else default

    sections = MenuSection.query.all()
    return render_template(
        'dashboard.html',
        is_open=get_value('is_open', 'true'),
        open_time=get_value('open_time', '11:00'),
        close_time=get_value('close_time', '21:00'),
        pickup_enabled=get_value('pickup_enabled', 'true'),
        delivery_enabled=get_value('delivery_enabled', 'true'),
        pickup_start=get_value('pickup_start', '11:00'),
        pickup_end=get_value('pickup_end', '21:00'),
        delivery_start=get_value('delivery_start', '11:00'),
        delivery_end=get_value('delivery_end', '21:00'),
        sections=sections,
    )


@app.route('/dashboard/update', methods=['POST'])
@login_required
def update_setting():
    data = request.get_json()
    is_open_val = data.get('is_open', 'true')
    open_time_val = data.get('open_time', '11:00')
    close_time_val = data.get('close_time', '21:00')
    pickup_enabled_val = data.get('pickup_enabled', 'true')
    delivery_enabled_val = data.get('delivery_enabled', 'true')
    pickup_start_val = data.get('pickup_start', '11:00')
    pickup_end_val = data.get('pickup_end', '21:00')
    delivery_start_val = data.get('delivery_start', '11:00')
    delivery_end_val = data.get('delivery_end', '21:00')

    for key, val in [
        ('is_open', is_open_val),
        ('open_time', open_time_val),
        ('close_time', close_time_val),
        ('pickup_enabled', pickup_enabled_val),
        ('delivery_enabled', delivery_enabled_val),
        ('pickup_start', pickup_start_val),
        ('pickup_end', pickup_end_val),
        ('delivery_start', delivery_start_val),
        ('delivery_end', delivery_end_val),
    ]:
        s = Setting.query.filter_by(key=key).first()
        if not s:
            db.session.add(Setting(key=key, value=val))
        else:
            s.value = val

    db.session.commit()
    settings = {s.key: s.value for s in Setting.query.all()}
    socketio.emit('setting_update', settings)
    return jsonify({'success': True})



@app.route('/dashboard/add_section', methods=['POST'])
@login_required
def add_section():
    name = request.form.get('section_name', '').strip()
    if name:
        section = MenuSection(name=name)
        db.session.add(section)
        db.session.commit()
    return redirect(url_for('dashboard'))


@app.route('/dashboard/add_item', methods=['POST'])
@login_required
def add_item():
    name = request.form.get('item_name', '').strip()
    price = request.form.get('price', '0')
    section_id = request.form.get('section_id')
    image_file = request.files.get('image')
    image_path = None
    if image_file and image_file.filename:
        filename = secure_filename(image_file.filename)
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        image_file.save(filepath)
        image_path = f'uploads/{filename}'
    if name and section_id:
        try:
            price_value = float(price)
        except ValueError:
            price_value = 0.0
        item = MenuItem(
            name=name,
            price=price_value,
            section_id=section_id,
            image=image_path,
        )
        db.session.add(item)
        db.session.commit()
    return redirect(url_for('dashboard'))



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
            "fooi": o.fooi or 0,
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
































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































