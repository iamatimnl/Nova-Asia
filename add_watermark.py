import os
from PIL import Image, ImageDraw, ImageFont

SUPPORTED_EXTS = {'.jpg', '.jpeg', '.png', '.webp'}


def add_watermark(image_path, text="Nova Asia"):
    image = Image.open(image_path).convert("RGBA")
    width, height = image.size

    txt_layer = Image.new("RGBA", image.size, (255, 255, 255, 0))
    draw = ImageDraw.Draw(txt_layer)
    font = ImageFont.load_default()
    text_width, text_height = draw.textsize(text, font=font)
    margin = 10
    x = width - text_width - margin
    y = height - text_height - margin
    draw.text((x, y), text, font=font, fill=(255, 255, 255, 128))

    watermarked = Image.alpha_composite(image, txt_layer)
    out_mode = "RGB" if watermarked.mode != "RGB" else watermarked.mode
    watermarked.convert(out_mode).save(image_path)


if __name__ == "__main__":
    root_dir = "static"
    for dirpath, _, filenames in os.walk(root_dir):
        for fname in filenames:
            ext = os.path.splitext(fname)[1].lower()
            if ext in SUPPORTED_EXTS:
                fpath = os.path.join(dirpath, fname)
                print(f"Watermarking {fpath}")
                add_watermark(fpath)
