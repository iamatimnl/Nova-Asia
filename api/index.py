from flask import Flask, render_template

app = Flask(__name__, template_folder="../templates", static_folder="../static")

@app.route('/')
def home():
    return render_template('index.html')

@app.route('/pos')
def pos():
    return render_template('pos.html')

@app.route('/admin')
def admin():
    return render_template('admin.html')

@app.route('/login')
def login():
    return render_template('login.html')
