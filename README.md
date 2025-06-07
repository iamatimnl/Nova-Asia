# Nova Asia – Flask on Render

This repository demonstrates a minimal Flask deployment on Render. The goal is to avoid automatic Poetry detection and ensure `gunicorn` is installed and used at runtime.

## Structure

- `app.py` – Flask application.
- `wsgi.py` – Gunicorn entry point.
- `requirements.txt` – Dependencies.
- `runtime.txt` – Python version lock.
- `render.yaml` – Render configuration.

## Render configuration

The `render.yaml` file overrides Render's build steps to install dependencies with `pip` and explicitly install `gunicorn`:

```yaml
services:
  - type: web
    name: nova-asia-test
    runtime: python
    buildCommand: |
      pip install --upgrade pip
      pip install -r requirements.txt
      pip install gunicorn
    startCommand: gunicorn wsgi:app
```

Create a new Web Service on Render, link this repository, and it will deploy using the configuration above.
