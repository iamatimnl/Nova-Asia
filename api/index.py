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
import json

app = Flask(__name__, template_folder="../templates", static_folder="../static")
app.config["SECRET_KEY"] = "replace-this"
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///db.sqlite3"
db = SQLAlchemy(app)

login_manager = LoginManager(app)
login_manager.login_view = "login"


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

@app.route('/')
def home():
    return render_template('index.html')

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

@app.route('/admin')
@login_required
def admin():
    return render_template('admin.html')

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


@app.route("/logout")
@login_required
def logout():
    logout_user()
    return redirect(url_for("login"))
# 🔑 Vercel serverless entry point:
def handler(environ, start_response):
    return app.wsgi_app(environ, start_response)
