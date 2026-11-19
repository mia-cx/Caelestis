---
title: Template studio
---

Turn an image into a Wplace template. Preview the result on the canvas while you choose its size, colours and position.

## Prepare the image

1. Right-click **Local** or a destination folder and choose **Create from image**. To save to a server folder, connect as an administrator.
2. Drop an image onto the studio, select **Choose file**, or use **Paste**. To load a web image, enter its **Image address** and click **Load**.

   ![The studio's empty canvas with Choose file, Paste and the Image address field.](images/studio/picker.png)

3. Choose **Crop** to show the source image. Drag the crop handles or enter the crop dimensions. Click **Apply**.

   ![A photo of a dog with crop handles drawn below the sky, the crop dimensions and Apply.](images/studio/crop.png)

4. In **Size**, adjust **Scale** or enter the dimensions in pixels. **Resample** controls how the studio combines source pixels. On the canvas, corner handles keep proportions and edge handles stretch one side. Hold Shift to swap these behaviours. **Reset aspect ratio** restores the proportions.

   ![The Size window at 20% scale with Resample and Position beside the pixelated preview.](images/studio/size.png)

5. Drag the image to its position. Enter a **Template name** and click **Save** when the preview looks right.

   ![The studio toolbar with the name Quito and Save outlined, above the finished preview.](images/studio/save.png)

Use **Replace image** to try another source, or **Undo** and **Redo** to revisit an edit.

## Choose the paint colours

In **Palette**, choose **All**, **Free**, **Premium** or **Owned**. **Owned** uses the colours available to your signed-in Wplace account. Click individual swatches to change which colours the template may use.

![The Palette window with All selected and every Wplace colour swatch.](images/studio/palette.png)

In **Colour**, choose **Matching** to set how the studio finds the closest palette colour. Under **Transparency**, use **Alpha** to decide how to treat partially transparent pixels. **Matte** blends them against a colour you choose.

![The Colour window with OKLab matching and the Alpha and Threshold controls.](images/studio/colour.png)

## Adjust tones and dither

1. In **Effects**, open **Add effect…**. Choose **Levels** and select a **Channel**. Set **Input black** and **Input white** for the ends of the range. **Midtones** adjusts values between them. In **Curves**, choose the channel the curve **Reads** and the one it **Changes**. Drag the graph to adjust the response.

   ![A Levels effect with raised input black, lowered input white and brighter midtones, beside the adjusted preview.](images/studio/effects-levels.png)

   ![A Curves effect with a gentle S-curve on OKLCH lightness, listed below Levels.](images/studio/effects-curves.png)

2. Add **Brightness and contrast**, **Exposure**, **White balance**, **Hue and saturation** or **Palette fit** as needed. A mask limits an effect to part of the image's colour or tonal range.
3. In **Dither**, select an **Algorithm** to mix palette colours across neighbouring pixels. Choose **None** for solid matches. Adjust **Strength** where available. Depending on the algorithm, **More options** includes adaptive placement or **Serpentine scan**.

   ![Floyd–Steinberg dithering at full strength with Placement and Serpentine scan, beside the dithered preview.](images/studio/dither.png)

4. Open **Scopes** to compare **Source**, **Effects** and **Output**. Choose **Histogram**, **Waveform**, **Parade**, **Vectorscope** or **CIE chromaticity**.

   ![The Scopes window showing red, green and blue histograms for the source and output.](images/studio/scopes.png)

## Arrange the workspace

Open **Panels** to show or hide a window. Drag a window by its header to move it. Drag a tab to dock it beside another panel or stack them together. On a phone, tap a tab to open the bottom sheet. Tap the same tab again to see more of the canvas.

![The Panels menu with every window ticked except Scopes.](images/studio/panels.png)

## Revise server artwork

As a server administrator, right-click a visible server template and choose **Replace from image**. If the server holds the original image and processing settings, the studio opens them. A replacement keeps the template's dimensions. Choose **Replace template**, then confirm the replacement.
