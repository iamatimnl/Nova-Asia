#!/usr/bin/env bash
set -o errexit

echo "🚀 Custom Render Build Script: starting install"

# 安装依赖
pip install --upgrade pip
pip install -r requirements.txt
pip install gunicorn

echo "✅ Dependencies installed. Starting gunicorn..."
gunicorn wsgi:app
