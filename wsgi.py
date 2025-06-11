# wsgi.py
from notifier import app, socketio  # ✅ 现在从 notifier.py 中导入

def run():
    socketio.run(app, host="0.0.0.0", port=5000, debug=True)

if __name__ == "__main__":
    run()

