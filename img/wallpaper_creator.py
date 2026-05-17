import os
from PIL import Image
import numpy as np
from math import ceil, sqrt

def create_wallpaper_from_images(input_folder, output_path="wallpaper.png", target_size=(4096, 2160), bg_color=(243, 176, 160)):
    """
    Stitches PNG images together to create a wallpaper of target size.
    
    Args:
        input_folder: Path to folder containing PNG images
        output_path: Where to save the resulting wallpaper
        target_size: Tuple of (width, height) for the wallpaper
        bg_color: RGB tuple for background color (default: #f3b0a0)
    """
    
    # Get all PNG files from the folder
    png_files = [f for f in os.listdir(input_folder) if f.lower().endswith('.png')]
    
    if not png_files:
        print(f"No PNG files found in {input_folder}")
        return False
    
    print(f"Found {len(png_files)} PNG images")
    
    # Load all images
    images = []
    for file in png_files:
        img_path = os.path.join(input_folder, file)
        try:
            img = Image.open(img_path)
            # Convert to RGBA if not already
            if img.mode != 'RGBA':
                img = img.convert('RGBA')
            images.append(img)
            print(f"Loaded: {file} - Size: {img.size}")
        except Exception as e:
            print(f"Error loading {file}: {e}")
    
    if not images:
        print("No valid images found")
        return False
    
    # Create background image with specified color
    wallpaper = Image.new('RGBA', target_size, bg_color + (255,))
    
    # Calculate how many images we need to fill the wallpaper
    # Estimate average image size to determine grid layout
    total_area = target_size[0] * target_size[1]
    avg_image_area = sum(img.width * img.height for img in images) / len(images)
    approx_needed = ceil(total_area / avg_image_area)
    
    print(f"\nNeed approximately {approx_needed} images to fill {target_size[0]}x{target_size[1]}")
    
    # Duplicate images if needed to fill the space
    if len(images) < approx_needed:
        print(f"Only {len(images)} images available. Will duplicate as needed.")
        original_count = len(images)
        while len(images) < approx_needed:
            images.extend(images[:min(original_count, approx_needed - len(images))])
    
    # Try to arrange images in a grid to fill the space
    # Calculate optimal grid dimensions
    best_grid = None
    min_waste = float('inf')
    
    # Try different grid configurations
    max_tries = min(20, approx_needed)
    for cols in range(1, max_tries + 1):
        rows = ceil(approx_needed / cols)
        if rows > max_tries:
            continue
        
        # Calculate scaled sizes while maintaining aspect ratios
        col_width = target_size[0] / cols
        row_height = target_size[1] / rows
        
        # Estimate waste
        waste = 0
        for i in range(min(cols * rows, len(images))):
            img = images[i % len(images)]
            target_ratio = col_width / row_height
            img_ratio = img.width / img.height
            
            if img_ratio > target_ratio:
                # Image is wider - scale to fit width
                scaled_width = col_width
                scaled_height = col_width / img_ratio
            else:
                # Image is taller - scale to fit height
                scaled_height = row_height
                scaled_width = row_height * img_ratio
            
            waste += (col_width * row_height) - (scaled_width * scaled_height)
        
        if waste < min_waste:
            min_waste = waste
            best_grid = (cols, rows, col_width, row_height)
    
    if best_grid is None:
        best_grid = (ceil(sqrt(approx_needed)), ceil(sqrt(approx_needed)), 
                    target_size[0] / ceil(sqrt(approx_needed)), 
                    target_size[1] / ceil(sqrt(approx_needed)))
    
    cols, rows, cell_width, cell_height = best_grid
    print(f"\nUsing grid: {cols} columns x {rows} rows")
    print(f"Cell size: {cell_width:.1f} x {cell_height:.1f}")
    
    # Place images in the grid
    image_index = 0
    images_per_cell = max(1, ceil(len(images) / (cols * rows)))
    
    for row in range(rows):
        for col in range(cols):
            if image_index >= len(images):
                break
            
            # Calculate position
            x = int(col * cell_width)
            y = int(row * cell_height)
            
            # Get current image
            img = images[image_index]
            image_index += 1
            
            # Calculate scaling to fit the cell while maintaining aspect ratio
            target_cell_size = (cell_width, cell_height)
            
            # Scale image to fit in cell
            img.thumbnail(target_cell_size, Image.Resampling.LANCZOS)
            
            # Calculate position to center the image in the cell
            paste_x = x + (cell_width - img.width) // 2
            paste_y = y + (cell_height - img.height) // 2
            
            # Paste image
            wallpaper.paste(img, (int(paste_x), int(paste_y)), img)
            
            print(f"Placed image {image_index}/{len(images)} at position ({x}, {y})")
        
        if image_index >= len(images):
            break
    
    # Convert to RGB and save as PNG (or you can save as JPG)
    # Create a new RGB image with the background color to flatten transparency
    final_wallpaper = Image.new('RGB', target_size, bg_color)
    final_wallpaper.paste(wallpaper, (0, 0), wallpaper)
    
    # Save the wallpaper
    final_wallpaper.save(output_path, 'PNG')
    print(f"\nWallpaper saved to: {output_path}")
    print(f"Size: {final_wallpaper.size}")
    
    return True

def main():
    # Configuration
    input_folder = input("Enter the path to the folder containing PNG images: ").strip()
    output_path = input("Enter output path (default: wallpaper.png): ").strip()
    
    if not output_path:
        output_path = "wallpaper.png"
    
    # Ensure the input folder exists
    if not os.path.exists(input_folder):
        print(f"Error: Folder '{input_folder}' does not exist!")
        return
    
    # Create the wallpaper
    success = create_wallpaper_from_images(
        input_folder=input_folder,
        output_path=output_path,
        target_size=(4096, 2160),
        bg_color=(243, 176, 160)  # #f3b0a0 in RGB
    )
    
    if success:
        print("\nWallpaper created successfully!")
    else:
        print("\nFailed to create wallpaper.")

if __name__ == "__main__":
    # Install required package if not available
    try:
        from PIL import Image
    except ImportError:
        print("PIL (Pillow) is required. Installing...")
        os.system("pip install Pillow")
        from PIL import Image
    
    main()