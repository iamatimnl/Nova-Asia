from flask import Flask, render_template
import os


app = Flask(__name__)

# Discover all HTML templates in the templates directory and
# automatically create routes for each one.
templates_dir = app.template_folder or os.path.join(os.path.dirname(__file__), "templates")

for filename in os.listdir(templates_dir):
    if not filename.endswith(".html"):
        continue

    # Map index.html to '/' and others to '/<filename without extension>'
    route = "/" if filename == "index.html" else f"/{os.path.splitext(filename)[0]}"

    def make_view(template):
        def view(template=template):
            return render_template(template)

        # Ensure a unique function name for each view
        view.__name__ = f"view_{os.path.splitext(template)[0]}"
        return view

    app.add_url_rule(route, view_func=make_view(filename))


if __name__ == "__main__":
    app.run()
