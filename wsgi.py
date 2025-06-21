from app import app, socketio

# 让 gunicorn 能找到 Flask 实例
application = app

# 如果你本地运行 wsgi.py，也可以启动 socketio（备用）
if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=5000)
