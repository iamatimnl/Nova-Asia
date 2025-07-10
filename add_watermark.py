import os
from PIL import Image

SUPPORTED_EXTS = {'.jpg', '.jpeg', '.png', '.webp'}

def add_logo_watermark(image_path, logo_path, output_suffix="_wm"):
    base, ext = os.path.splitext(image_path)
    if ext.lower() not in SUPPORTED_EXTS:
        return

    image = Image.open(image_path).convert("RGBA")
    logo = Image.open(logo_path).convert("RGBA")

    # Resize logo to 15% of image width
    ratio = 0.15
    logo_width = int(image.width * ratio)
    logo_ratio = logo_width / logo.width
    logo_height = int(logo.height * logo_ratio)
    logo = logo.resize((logo_width, logo_height), Image.ANTIALIAS)

    # Position logo at bottom-right with margin
    margin = 20
    x = image.width - logo.width - margin
    y = image.height - logo.height - margin

    # Create transparent layer for composition
    watermark_layer = Image.new("RGBA", image.size, (255, 255, 255, 0))
    watermark_layer.paste(logo, (x, y), logo)

    watermarked = Image.alpha_composite(image, watermark_layer)

    # Save result as new file
    output_path = f"{base}{output_suffix}.jpg"
    watermarked.convert("RGB").save(output_path)
    print(f"✅ 加了 logo 水印: {output_path}")

# 示例调用
if __name__ == "__main__":
    root_dir = "static/images"
    logo_path = os.path.join(root_dir, "Logo.png")

    for dirpath, _, filenames in os.walk(root_dir):
        for fname in filenames:
            if fname.lower() == "logo.png":
                continue  # 跳过 logo 自己
            fpath = os.path.join(dirpath, fname)
            add_logo_watermark(fpath, logo_path)
