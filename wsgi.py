from app import app, socketio

def run():
    socketio.run(app, debug=True)

# 仅当你本地运行 python wsgi.py 时才执行
if __name__ == "__main__":
    run()
